"""Mailbox import — ``createImportSession`` + upload to the import URL.

Two steps (SoW §1.2):

    1. ``POST /admin/exchange/mailboxes/{id}/createImportSession`` returns a
       ``mailboxItemImportSession`` with a preauthenticated ``importUrl`` and an
       ``expirationDateTime``.
    2. POST each exported item to that ``importUrl`` with a body of
       ``{ FolderId, Mode, Data, ItemId?, ChangeKey? }``.

CRITICAL: the ``importUrl`` is preauthenticated (it embeds its own token in the
``outlook.office365.com`` domain). Do **not** attach an ``Authorization``
header to the upload POST — hence ``authenticated=False``. The session token
expires, so the importer transparently recreates the session when needed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from ..contracts import TenantRole
from ..exchange.exporter import ExportedItem
from ..graph.client import GraphClient
from ..logging_setup import get_logger

log = get_logger("exchange.importer")

# Refresh the import session this many seconds before its stated expiry.
_SESSION_SKEW_SEC = 60


@dataclass(slots=True)
class ImportedItem:
    """Result of a successful import."""

    source_item_id: str
    dest_item_id: str
    change_key: Optional[str]


class MailboxImporter:
    """Imports exported items into a destination mailbox folder."""

    def __init__(self, graph: GraphClient, dest_tenant_id: str) -> None:
        self._graph = graph
        self._tenant_id = dest_tenant_id
        self._import_url: Optional[str] = None
        self._import_url_expiry: float = 0.0
        self._session_mailbox: Optional[str] = None

    async def _ensure_session(self, mailbox_id: str) -> str:
        """Return a live import URL, (re)creating the session as needed."""
        now = time.time()
        if (
            self._import_url
            and self._session_mailbox == mailbox_id
            and now < (self._import_url_expiry - _SESSION_SKEW_SEC)
        ):
            return self._import_url

        resp = await self._graph.request(
            "POST",
            f"/admin/exchange/mailboxes/{mailbox_id}/createImportSession",
            role=TenantRole.DESTINATION,
            tenant_id=self._tenant_id,
            expected=(200, 201),
        )
        body = resp.json()
        self._import_url = body["importUrl"]
        self._session_mailbox = mailbox_id
        expiry = body.get("expirationDateTime")
        self._import_url_expiry = _parse_expiry(expiry)
        log.debug(
            "exchange_import_session_created",
            extra={"mailbox_id": mailbox_id, "expires_at": expiry},
        )
        return self._import_url

    async def import_item(
        self,
        mailbox_id: str,
        dest_folder_id: str,
        item: ExportedItem,
        *,
        mode: str = "create",
    ) -> ImportedItem:
        """Import a single exported item into ``dest_folder_id``.

        ``mode`` is ``"create"`` on a full pass; ``"update"`` on a delta pass for
        an item that already exists in the destination.
        """
        url = await self._ensure_session(mailbox_id)
        payload: dict[str, object] = {
            "FolderId": dest_folder_id,
            "Mode": mode,
            "Data": item.data,  # base64 opaque stream — never logged
        }
        # For update mode, Exchange needs the destination item's id/changeKey;
        # on create we let Exchange mint a new item id.
        if mode == "update":
            payload["ItemId"] = item.item_id
            if item.change_key:
                payload["ChangeKey"] = item.change_key

        resp = await self._graph.request(
            "POST",
            url,
            authenticated=False,  # preauthenticated importUrl — no bearer header
            json_body=payload,
            expected=(200, 201),
        )
        body = resp.json()
        return ImportedItem(
            source_item_id=item.item_id,
            dest_item_id=body.get("itemId", ""),
            change_key=body.get("changeKey"),
        )


def _parse_expiry(value: Optional[str]) -> float:
    if not value:
        # Unknown expiry — assume a short-lived session so we refresh promptly.
        return time.time() + 300
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time() + 300
