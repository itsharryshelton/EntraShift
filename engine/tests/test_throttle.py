"""Throttling tests — the hard SoW requirement: honour ``Retry-After`` on every
429/503, grow backoff between attempts, and let the governor self-reduce
concurrency."""

from __future__ import annotations

import httpx
import pytest

from entrashift_engine.contracts import TenantRole, VmTokenResponse
from entrashift_engine.graph.client import (
    GraphClient,
    _parse_retry_after,
)
from entrashift_engine.graph.throttle import ThrottleGovernor


async def _fake_token(_role: TenantRole) -> VmTokenResponse:
    # Far-future expiry so the client never tries to refresh mid-test.
    return VmTokenResponse.model_validate(
        {
            "accessToken": "test-token",
            "expiresAt": "2999-01-01T00:00:00Z",
            "tenantId": "tenant-xyz",
        }
    )


def test_parse_retry_after_seconds_and_date() -> None:
    assert _parse_retry_after("30") == 30.0
    assert _parse_retry_after(None) is None
    assert _parse_retry_after("not-a-number-and-not-a-date") is None
    # An HTTP-date in the past clamps to 0, never negative.
    assert _parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0.0


async def test_retry_after_is_honoured_on_429(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 429 with Retry-After must cause a sleep of (at least) that many seconds,
    then the request is retried and succeeds."""
    slept: list[float] = []

    async def fake_sleep(delay: float) -> None:
        slept.append(delay)

    monkeypatch.setattr("entrashift_engine.graph.client.asyncio.sleep", fake_sleep)

    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "42"}, json={})
        return httpx.Response(200, json={"ok": True})

    governor = ThrottleGovernor(per_tenant=4, per_mailbox=2)
    client = GraphClient(
        _fake_token, governor, transport=httpx.MockTransport(handler)
    )
    try:
        resp = await client.request(
            "GET", "/me", role=TenantRole.SOURCE, tenant_id="tenant-xyz"
        )
        assert resp.status_code == 200
        assert calls["n"] == 2  # retried exactly once
        assert len(slept) == 1
        # Retry-After (42s) is honoured; jitter only adds up to 1s on top.
        assert 42.0 <= slept[0] <= 43.0
    finally:
        await client.aclose()


async def test_503_also_honours_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []

    async def fake_sleep(delay: float) -> None:
        slept.append(delay)

    monkeypatch.setattr("entrashift_engine.graph.client.asyncio.sleep", fake_sleep)

    seq = iter([503, 200])

    def handler(request: httpx.Request) -> httpx.Response:
        code = next(seq)
        if code == 503:
            return httpx.Response(503, headers={"Retry-After": "5"}, json={})
        return httpx.Response(200, json={})

    governor = ThrottleGovernor(4, 2)
    client = GraphClient(_fake_token, governor, transport=httpx.MockTransport(handler))
    try:
        resp = await client.request("GET", "/x", role=TenantRole.SOURCE)
        assert resp.status_code == 200
        assert 5.0 <= slept[0] <= 6.0
    finally:
        await client.aclose()


async def test_backoff_grows_without_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    """When no Retry-After is present, full-jitter backoff is bounded by an
    exponentially growing ceiling (2**attempt)."""
    slept: list[float] = []

    async def fake_sleep(delay: float) -> None:
        slept.append(delay)

    # Force full-jitter to return the ceiling so growth is observable.
    monkeypatch.setattr("entrashift_engine.graph.client.asyncio.sleep", fake_sleep)
    monkeypatch.setattr(
        "entrashift_engine.graph.client.random.uniform", lambda _a, b: b
    )

    def handler(request: httpx.Request) -> httpx.Response:
        # Always 429 without Retry-After -> exhausts retries.
        return httpx.Response(429, json={})

    governor = ThrottleGovernor(4, 2)
    client = GraphClient(
        _fake_token, governor, max_retries=3, transport=httpx.MockTransport(handler)
    )
    try:
        with pytest.raises(Exception):
            await client.request("GET", "/x", role=TenantRole.SOURCE)
        # Ceilings 2**0, 2**1, 2**2 = 1, 2, 4 -> strictly increasing.
        assert slept == sorted(slept)
        assert slept[0] < slept[-1]
    finally:
        await client.aclose()


async def test_governor_self_reduces_then_restores_concurrency() -> None:
    gov = ThrottleGovernor(per_tenant=4, per_mailbox=2)
    tenant = "tenant-xyz"

    # Simulate a burst of throttled calls above the high watermark.
    for _ in range(20):
        await gov.record(tenant, throttled=True)
    assert gov.effective_concurrency(tenant) < 4
    assert gov.is_backing_off(tenant) is True

    # The cooldown gates further reductions per call; force enough clean calls
    # over time to lift the throttle rate back down and restore capacity.
    gov._last_adjust[tenant] = 0.0  # bypass cooldown for the test
    for _ in range(200):
        await gov.record(tenant, throttled=False)
        gov._last_adjust[tenant] = 0.0
    assert gov.effective_concurrency(tenant) == 4
    assert gov.is_backing_off(tenant) is False
