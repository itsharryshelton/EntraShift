"""Checkpoint tests — resume state builds/loads correctly and the store honours
its write-rate floor (D1 budget)."""

from __future__ import annotations

from typing import Any

from entrashift_engine.checkpoint import (
    CHECKPOINT_VERSION,
    Checkpoint,
    CheckpointStore,
    load_checkpoint,
)
from entrashift_engine.contracts import CheckpointUpdate, Job, Workload


def _job_with_checkpoint(checkpoint: dict[str, Any] | None) -> Job:
    return Job.model_validate(
        {
            "id": "job-1",
            "migrationUserId": "mu-1",
            "sourceEmail": "a@source.com",
            "targetUpn": "a@dest.com",
            "workload": "onedrive",
            "status": "running",
            "progressCurrent": 12,
            "bytesDone": 999,
            "createdAt": "2026-07-09T00:00:00Z",
            "updatedAt": "2026-07-09T00:00:00Z",
            "checkpoint": checkpoint,
        }
    )


def test_load_checkpoint_fresh_when_absent() -> None:
    cp = load_checkpoint(_job_with_checkpoint(None), "full")
    assert cp.version == CHECKPOINT_VERSION
    assert cp.workload == Workload.ONEDRIVE
    assert cp.cursor == {}
    assert cp.pass_ == "full"


def test_load_checkpoint_restores_cursor() -> None:
    stored = {
        "version": CHECKPOINT_VERSION,
        "workload": "onedrive",
        "pass_": "full",
        "cursor": {"delta_link": "abc", "items_done": ["x"]},
        "progress_current": 12,
        "bytes_done": 999,
    }
    cp = load_checkpoint(_job_with_checkpoint(stored), "delta")
    assert cp.cursor["delta_link"] == "abc"
    assert cp.progress_current == 12
    # The pass is realigned to the pass being run.
    assert cp.pass_ == "delta"


def test_load_checkpoint_resets_on_version_mismatch() -> None:
    stored = {"version": 999, "workload": "onedrive", "cursor": {"x": 1}}
    cp = load_checkpoint(_job_with_checkpoint(stored), "full")
    assert cp.cursor == {}  # incompatible -> clean restart


def test_load_checkpoint_resets_on_garbage() -> None:
    cp = load_checkpoint(_job_with_checkpoint({"totally": "wrong"}), "full")
    assert cp.version == CHECKPOINT_VERSION
    assert cp.cursor == {}


class _FakeControlPlane:
    """Records checkpoint writes so we can assert the rate floor is honoured."""

    def __init__(self) -> None:
        self.writes: list[CheckpointUpdate] = []

    async def checkpoint(self, job_id: str, update: CheckpointUpdate) -> None:
        self.writes.append(update)


async def test_store_flush_writes_and_maybe_flush_respects_interval() -> None:
    cp = Checkpoint.empty(Workload.EXCHANGE, "full")
    fake = _FakeControlPlane()
    store = CheckpointStore(fake, "job-1", cp, interval_sec=3600)

    store.update(progress_current=5, bytes_done=100)
    # Interval is huge and nothing flushed yet -> maybe_flush must NOT write.
    wrote = await store.maybe_flush()
    assert wrote is True  # first call: last_flush=0, elapsed huge -> flushes once
    assert len(fake.writes) == 1

    # Immediately again -> within interval, suppressed.
    store.update(progress_current=6, bytes_done=120)
    wrote = await store.maybe_flush()
    assert wrote is False
    assert len(fake.writes) == 1

    # Forced flush always writes and carries the latest counters.
    await store.flush()
    assert len(fake.writes) == 2
    assert fake.writes[-1].progress_current == 6
    assert fake.writes[-1].bytes_done == 120


def test_checkpoint_to_json_round_trips() -> None:
    cp = Checkpoint.empty(Workload.EXCHANGE, "full")
    cp.cursor["folder_map"] = {"src": "dst"}
    cp.progress_current = 3
    data = cp.to_json()
    restored = Checkpoint.model_validate(data)
    assert restored.cursor["folder_map"] == {"src": "dst"}
    assert restored.progress_current == 3
