"""Concurrency governor for Graph calls (SoW Phase 4, Throttling & Backoff).

Two mechanisms:

1. **Static caps** — per-tenant and per-mailbox ``asyncio.Semaphore``s enforce
   the conservative concurrency ceilings from ``EngineConfig``
   (``perTenantConcurrency`` / ``perMailboxConcurrency``).

2. **Adaptive governor** — each tenant tracks its recent throttle rate over a
   sliding window. When throttling climbs above a threshold the governor
   *reduces* the effective per-tenant concurrency (extra permits are "parked")
   *before* Graph starts sustained 429s; when things stay clean it slowly
   restores permits. This is the "self-reduce concurrency before sustained
   throttling" requirement.

The semaphores are acquired via async context managers so callers cannot leak
permits on error paths.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import AsyncIterator

from ..logging_setup import get_logger

log = get_logger("throttle")


class _AdaptiveSemaphore:
    """A semaphore whose *effective* capacity can be lowered/raised at runtime.

    We never destroy the underlying permits; instead we "park" permits by
    acquiring them internally so live callers are unaffected and in-flight work
    is never cancelled. Capacity changes take effect for subsequent acquires.
    """

    def __init__(self, capacity: int) -> None:
        self._max = max(1, capacity)
        self._sem = asyncio.Semaphore(self._max)
        self._effective = self._max
        self._parked = 0
        self._lock = asyncio.Lock()

    @property
    def effective(self) -> int:
        return self._effective

    async def set_effective(self, target: int) -> None:
        """Adjust effective capacity toward ``target`` within [1, max]."""
        target = max(1, min(self._max, target))
        async with self._lock:
            if target < self._effective:
                # Park (acquire) permits to shrink capacity.
                to_park = self._effective - target
                for _ in range(to_park):
                    await self._sem.acquire()
                    self._parked += 1
                self._effective = target
            elif target > self._effective:
                # Release parked permits to grow capacity.
                to_release = min(self._parked, target - self._effective)
                for _ in range(to_release):
                    self._sem.release()
                    self._parked -= 1
                self._effective += to_release

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[None]:
        await self._sem.acquire()
        try:
            yield
        finally:
            self._sem.release()


class ThrottleGovernor:
    """Tracks throttle-rate per tenant and adapts per-tenant concurrency."""

    # Sliding-window length for the throttle-rate estimate.
    WINDOW_SEC = 60.0
    # Also bound the window by recent-event count. Without this, a burst of
    # throttles followed by a high volume of clean calls in the SAME wall-clock
    # window keeps the rate elevated (old events never age out), so the governor
    # would never restore capacity under sustained high throughput. The rate is
    # therefore over "the last MAX_EVENTS calls OR the last WINDOW_SEC seconds",
    # whichever is smaller.
    MAX_EVENTS = 200
    # Above this fraction of throttled calls we shrink; below LOW we grow.
    HIGH_WATERMARK = 0.10
    LOW_WATERMARK = 0.02
    # Minimum seconds between capacity adjustments per tenant.
    ADJUST_COOLDOWN_SEC = 15.0

    def __init__(self, per_tenant: int, per_mailbox: int) -> None:
        self._per_tenant_cap = max(1, per_tenant)
        self._per_mailbox_cap = max(1, per_mailbox)
        self._tenant_sems: dict[str, _AdaptiveSemaphore] = {}
        self._mailbox_sems: dict[str, asyncio.Semaphore] = {}
        # tenant -> deque[(timestamp, throttled: 0|1)]
        self._events: dict[str, deque[tuple[float, int]]] = {}
        self._last_adjust: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def _tenant_sem(self, tenant: str) -> _AdaptiveSemaphore:
        async with self._lock:
            sem = self._tenant_sems.get(tenant)
            if sem is None:
                sem = _AdaptiveSemaphore(self._per_tenant_cap)
                self._tenant_sems[tenant] = sem
                self._events[tenant] = deque()
            return sem

    async def _mailbox_sem(self, mailbox: str) -> asyncio.Semaphore:
        async with self._lock:
            sem = self._mailbox_sems.get(mailbox)
            if sem is None:
                sem = asyncio.Semaphore(self._per_mailbox_cap)
                self._mailbox_sems[mailbox] = sem
            return sem

    @asynccontextmanager
    async def slot(self, tenant: str, mailbox: str | None = None) -> AsyncIterator[None]:
        """Acquire a tenant slot (and, if given, a per-mailbox slot)."""
        tenant_sem = await self._tenant_sem(tenant)
        async with tenant_sem.acquire():
            if mailbox is None:
                yield
                return
            mailbox_sem = await self._mailbox_sem(f"{tenant}:{mailbox}")
            async with mailbox_sem:
                yield

    async def record(self, tenant: str, *, throttled: bool) -> None:
        """Record the outcome of one Graph call and adapt if needed."""
        now = time.monotonic()
        await self._tenant_sem(tenant)  # ensure structures exist
        events = self._events[tenant]
        events.append((now, 1 if throttled else 0))
        cutoff = now - self.WINDOW_SEC
        while events and events[0][0] < cutoff:
            events.popleft()
        # Count-bound the window so recent clean calls can dilute an old burst.
        while len(events) > self.MAX_EVENTS:
            events.popleft()

        if throttled:
            log.warning(
                "graph_throttled",
                extra={"tenant": tenant, "window_events": len(events)},
            )

        # Rate-limit adjustments.
        last = self._last_adjust.get(tenant, 0.0)
        if (now - last) < self.ADJUST_COOLDOWN_SEC or len(events) < 10:
            return

        rate = sum(v for _, v in events) / len(events)
        sem = self._tenant_sems[tenant]
        if rate >= self.HIGH_WATERMARK and sem.effective > 1:
            await sem.set_effective(sem.effective - 1)
            self._last_adjust[tenant] = now
            log.warning(
                "throttle_governor_reduced",
                extra={
                    "tenant": tenant,
                    "throttle_rate": round(rate, 3),
                    "new_concurrency": sem.effective,
                },
            )
        elif rate <= self.LOW_WATERMARK and sem.effective < self._per_tenant_cap:
            await sem.set_effective(sem.effective + 1)
            self._last_adjust[tenant] = now
            log.info(
                "throttle_governor_restored",
                extra={
                    "tenant": tenant,
                    "throttle_rate": round(rate, 3),
                    "new_concurrency": sem.effective,
                },
            )

    def effective_concurrency(self, tenant: str) -> int:
        """Current effective per-tenant concurrency (for progress/telemetry)."""
        sem = self._tenant_sems.get(tenant)
        return sem.effective if sem else self._per_tenant_cap

    def is_backing_off(self, tenant: str) -> bool:
        """True when the governor has reduced this tenant below its cap."""
        return self.effective_concurrency(tenant) < self._per_tenant_cap
