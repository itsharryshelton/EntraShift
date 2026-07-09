"""Alias-parity tests — the Python contracts MUST speak the same camelCase wire
format as ``shared/contracts.ts``. If these fail, the engine and control plane
have drifted and will not interoperate."""

from __future__ import annotations

from entrashift_engine.contracts import (
    TERMINAL_STATUSES,
    CheckpointUpdate,
    EngineConfig,
    ItemLogBatch,
    ItemStatus,
    Job,
    JobDispatchMessage,
    JobStatus,
    ProgressUpdate,
    StatusUpdate,
    TenantRole,
    VmTokenRequest,
    VmTokenResponse,
    Workload,
)


def test_job_dispatch_message_round_trip_camel_case() -> None:
    wire = {
        "jobId": "job-1",
        "migrationUserId": "mu-1",
        "workload": "exchange",
        "sourceEmail": "a@source.com",
        "targetUpn": "a@dest.com",
        "includeArchive": True,
        "pass": "delta",
        "dispatchSeq": 7,
    }
    msg = JobDispatchMessage.model_validate(wire)
    assert msg.job_id == "job-1"
    assert msg.workload == Workload.EXCHANGE
    assert msg.pass_ == "delta"  # `pass` keyword mapped to pass_
    assert msg.include_archive is True

    dumped = msg.model_dump(by_alias=True, exclude_none=True)
    assert dumped == wire  # exact round-trip, including the `pass` alias


def test_progress_update_serialises_camel_and_omits_none() -> None:
    upd = ProgressUpdate(
        status=JobStatus.RUNNING,
        progress_current=10,
        bytes_done=2048,
    )
    dumped = upd.model_dump(by_alias=True, exclude_none=True)
    assert dumped["status"] == "running"
    assert dumped["progressCurrent"] == 10
    assert dumped["bytesDone"] == 2048
    # Unset optional fields must not appear on the wire.
    assert "phaseText" not in dumped
    assert "deltaToken" not in dumped


def test_engine_config_parses_camel_case_defaults() -> None:
    cfg = EngineConfig.model_validate(
        {
            "minPollIntervalSec": 30,
            "perMailboxConcurrency": 2,
            "perTenantConcurrency": 4,
            "exchangeExportBatchSize": 20,
            "onedriveUploadSessionThresholdBytes": 4194304,
            "itemMaxRetries": 5,
            "paused": False,
        }
    )
    assert cfg.exchange_export_batch_size == 20
    assert cfg.onedrive_upload_session_threshold_bytes == 4194304
    assert cfg.paused is False


def test_vm_token_request_default_scope() -> None:
    req = VmTokenRequest(tenant_role=TenantRole.SOURCE)
    dumped = req.model_dump(by_alias=True, exclude_none=True)
    assert dumped["tenantRole"] == "source"
    assert dumped["scope"] == "https://graph.microsoft.com/.default"


def test_vm_token_response_parses() -> None:
    resp = VmTokenResponse.model_validate(
        {
            "accessToken": "eyJ...",
            "expiresAt": "2026-07-09T12:00:00Z",
            "tenantId": "tid-123",
        }
    )
    assert resp.access_token.startswith("eyJ")
    assert resp.tenant_id == "tid-123"


def test_checkpoint_and_status_and_items_aliases() -> None:
    cp = CheckpointUpdate(checkpoint={"folder": "x"}, progress_current=3, bytes_done=9)
    assert cp.model_dump(by_alias=True)["progressCurrent"] == 3

    su = StatusUpdate(status=JobStatus.AUTH_EXPIRED, error_class="AuthError")
    d = su.model_dump(by_alias=True, exclude_none=True)
    assert d["status"] == "auth_expired"
    assert d["errorClass"] == "AuthError"

    batch = ItemLogBatch(
        items=[
            {
                "itemId": "i1",
                "status": "skipped",
                "errorClass": "E",
                "errorDetail": "d",
            }
        ]
    )
    dumped = batch.model_dump(by_alias=True, exclude_none=True)
    assert dumped["items"][0]["itemId"] == "i1"
    assert dumped["items"][0]["status"] == "skipped"


def test_terminal_statuses_match_ts_contract() -> None:
    # Mirrors TERMINAL_STATUSES in shared/contracts.ts exactly.
    expected = {
        JobStatus.COMPLETED,
        JobStatus.CANCELLED,
        JobStatus.AUTH_EXPIRED,
        JobStatus.PERMISSION_REVOKED,
        JobStatus.QUOTA_EXCEEDED,
        JobStatus.FAILED,
    }
    assert set(TERMINAL_STATUSES) == expected
    # Non-terminal states must be excluded.
    assert JobStatus.RUNNING not in TERMINAL_STATUSES
    assert JobStatus.BACKING_OFF not in TERMINAL_STATUSES


def test_job_parses_full_record_with_extra_fields_ignored() -> None:
    job = Job.model_validate(
        {
            "id": "job-1",
            "migrationUserId": "mu-1",
            "sourceEmail": "a@source.com",
            "targetUpn": "a@dest.com",
            "workload": "onedrive",
            "status": "running",
            "phaseText": None,
            "progressCurrent": 5,
            "progressTotal": 100,
            "bytesDone": 1234,
            "bytesTotal": None,
            "deltaToken": None,
            "attempts": 1,
            "errorClass": None,
            "errorDetail": None,
            "createdAt": "2026-07-09T00:00:00Z",
            "updatedAt": "2026-07-09T00:00:00Z",
            "startedAt": None,
            "completedAt": None,
            "checkpoint": {"delta_link": "abc"},
            "someFutureField": "ignored",  # forward-compat: extra ignored
        }
    )
    assert job.workload == Workload.ONEDRIVE
    assert job.progress_current == 5
    assert job.checkpoint == {"delta_link": "abc"}


def test_item_status_enum_values() -> None:
    assert ItemStatus.SKIPPED.value == "skipped"
    assert ItemStatus.FAILED.value == "failed"
