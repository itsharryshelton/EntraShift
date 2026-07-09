"""Mailbox export — ``POST /admin/exchange/mailboxes/{id}/exportItems``.

Exports mailbox items as full-fidelity opaque streams, **max 20 items per
call** (Graph hard limit — SoW §1.2). Each item comes back as base64 ``data``
plus its ``itemId`` / ``changeKey``. Per-item errors are returned inline in the
200 response (not as a request-level failure), so a bad item never aborts the
batch — the caller records it via skip-and-log.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ..contracts import TenantRole
from ..graph.client import GraphClient
from ..logging_setup import get_logger

log = get_logger("exchange.exporter")

# Graph hard cap on items per exportItems call.
MAX_EXPORT_BATCH = 20


@dataclass(slots=True)
class ExportedItem:
    """A successfully exported item's opaque stream."""

    item_id: str
    change_key: Optional[str]
    data: str  # base64 opaque stream — treated as message content, never logged


@dataclass(slots=True)
class ExportItemError:
    """A per-item export failure returned inline in the 200 response."""

    item_id: str
    code: str
    message: str


@dataclass(slots=True)
class ExportResult:
    exported: list[ExportedItem]
    errors: list[ExportItemError]


class MailboxExporter:
    """Exports batches of items from a source mailbox."""

    def __init__(self, graph: GraphClient, source_tenant_id: str) -> None:
        self._graph = graph
        self._tenant_id = source_tenant_id

    async def export_items(
        self, mailbox_id: str, item_ids: list[str]
    ) -> ExportResult:
        """Export up to 20 items. Caller must pre-chunk to ``MAX_EXPORT_BATCH``."""
        if not item_ids:
            return ExportResult(exported=[], errors=[])
        if len(item_ids) > MAX_EXPORT_BATCH:
            raise ValueError(
                f"exportItems accepts at most {MAX_EXPORT_BATCH} items "
                f"(got {len(item_ids)}) — chunk before calling"
            )

        resp = await self._graph.request(
            "POST",
            f"/admin/exchange/mailboxes/{mailbox_id}/exportItems",
            role=TenantRole.SOURCE,
            tenant_id=self._tenant_id,
            json_body={"itemIds": item_ids},
        )
        body = resp.json()

        exported: list[ExportedItem] = []
        errors: list[ExportItemError] = []
        for entry in body.get("value", []):
            err = entry.get("Error") or entry.get("error")
            if err:
                errors.append(
                    ExportItemError(
                        item_id=entry.get("itemId", "<unknown>"),
                        code=err.get("code", "ExportItemError"),
                        message=err.get("message", ""),
                    )
                )
                continue
            data = entry.get("data")
            if not data:
                errors.append(
                    ExportItemError(
                        item_id=entry.get("itemId", "<unknown>"),
                        code="EmptyExportStream",
                        message="export returned no data stream",
                    )
                )
                continue
            exported.append(
                ExportedItem(
                    item_id=entry["itemId"],
                    change_key=entry.get("changeKey"),
                    data=data,
                )
            )

        log.debug(
            "exchange_export_batch",
            extra={
                "mailbox_id": mailbox_id,
                "requested": len(item_ids),
                "exported": len(exported),
                "errors": len(errors),
            },
        )
        return ExportResult(exported=exported, errors=errors)


def chunk_item_ids(item_ids: list[str], size: int = MAX_EXPORT_BATCH) -> list[list[str]]:
    """Split item ids into export-sized chunks (never larger than the Graph cap)."""
    size = min(size, MAX_EXPORT_BATCH)
    return [item_ids[i : i + size] for i in range(0, len(item_ids), size)]
