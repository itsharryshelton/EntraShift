"""Typed Graph errors mapped to the distinct job failure statuses.

SoW Phase 4 requires that ``auth_expired``, ``permission_revoked`` and
``quota_exceeded`` surface as *distinct* job statuses with remediation hints.
Each error class below carries the ``JobStatus`` it maps to so the worker can
set the right terminal status without re-inspecting HTTP codes.
"""

from __future__ import annotations

from typing import Optional

from ..contracts import JobStatus


class GraphError(Exception):
    """Base for all Graph failures. Maps to the generic ``failed`` status."""

    job_status: JobStatus = JobStatus.FAILED

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        graph_code: Optional[str] = None,
        detail: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.graph_code = graph_code
        self.detail = detail or message

    @property
    def error_class(self) -> str:
        """Short, log-safe classifier (e.g. for ``job.error_class``)."""
        return self.graph_code or type(self).__name__


class AuthExpired(GraphError):
    """401 / invalid or expired token. The engine re-fetches a token; if it
    still fails this is surfaced so the engineer can re-consent / re-connect."""

    job_status = JobStatus.AUTH_EXPIRED


class PermissionRevoked(GraphError):
    """403 / insufficient privileges — admin consent revoked or scope missing."""

    job_status = JobStatus.PERMISSION_REVOKED


class QuotaExceeded(GraphError):
    """Mailbox/drive quota or storage limit hit (e.g. 507, quota Graph codes)."""

    job_status = JobStatus.QUOTA_EXCEEDED


class ThrottledError(GraphError):
    """429 / 503 with (usually) a ``Retry-After``. Retried inside the client;
    only escapes if the retry budget is exhausted."""

    def __init__(
        self,
        message: str,
        *,
        retry_after: Optional[float] = None,
        status_code: Optional[int] = None,
        graph_code: Optional[str] = None,
        detail: Optional[str] = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, graph_code=graph_code, detail=detail
        )
        self.retry_after = retry_after


class ItemFailedError(GraphError):
    """A single item failed after its retry budget. Caught by the migrator and
    recorded via skip-and-log — it must never fail the whole job (SoW Phase 4)."""


def classify_graph_error(
    status_code: int, graph_code: Optional[str], message: str, detail: Optional[str]
) -> GraphError:
    """Map an HTTP status + Graph error code onto a typed error.

    Ordering matters: check specific Graph codes before broad HTTP families.
    """
    code = (graph_code or "").lower()

    # Quota / storage — can appear as 403, 413, or 507 depending on API.
    if status_code == 507 or "quota" in code or "storageexceeded" in code:
        return QuotaExceeded(
            message, status_code=status_code, graph_code=graph_code, detail=detail
        )

    if status_code == 401 or code in {
        "invalidauthenticationtoken",
        "unauthenticated",
        "tokenexpired",
    }:
        return AuthExpired(
            message, status_code=status_code, graph_code=graph_code, detail=detail
        )

    if status_code == 403 or code in {
        "accessdenied",
        "authorizationrequestdenied",
        "insufficientprivileges",
        "erroraccessdenied",
    }:
        return PermissionRevoked(
            message, status_code=status_code, graph_code=graph_code, detail=detail
        )

    return GraphError(
        message, status_code=status_code, graph_code=graph_code, detail=detail
    )
