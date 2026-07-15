"""Exchange migration orchestrator (SoW Phase 4, Exchange module).

Flow per job (one user's mailboxes):

    1. Resolve the user's mailboxes (primary + optional archive + shared).
    2. For each mailbox, enumerate folders via ``mailboxFolder: delta`` and
       recreate the folder hierarchy in the destination (mapping stored in the
       checkpoint so it survives reboots).
    3. For each folder, enumerate items via ``mailboxItem: delta`` (no token =
       full pass; stored token = delta pass), export in <=20-item batches,
       import each into the mapped destination folder.
    4. Item-level failures are retried up to ``itemMaxRetries`` then recorded via
       skip-and-log — they never fail the mailbox job.
    5. Delta tokens (folder + per-folder item) are persisted so the next
       incremental pass resumes exactly where this one left off.

Full and delta passes share the same code path; only the presence of stored
delta tokens differs. Base64 item streams are treated as message content and
are NEVER written to the logs.

The exact ``mailboxFolder`` create/childFolders shapes and the per-user mailbox
resolution endpoint must be validated against live Graph during Phase 1 (they
vary slightly by tenant configuration). The structure and throttling/skip-and-log
behaviour are the load-bearing parts.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Optional

from ..contracts import ItemStatus, JobStatus, TenantRole
from ..graph.client import GraphClient
from ..graph.errors import AuthExpired, GraphError, PermissionRevoked, QuotaExceeded
from ..job_context import JobContext
from ..logging_setup import get_logger
from .exporter import ExportedItem, MailboxExporter, chunk_item_ids
from .importer import MailboxImporter

log = get_logger("exchange.migrator")


@dataclass(slots=True)
class MailboxRef:
    """A resolved mailbox to migrate."""

    mailbox_id: str
    mailbox_type: str  # 'primary' | 'archive' | 'shared'


@dataclass(slots=True)
class _FolderEnum:
    folders: list[dict]
    delta_link: Optional[str]


@dataclass(slots=True)
class _ItemEnum:
    added_or_updated: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    delta_link: Optional[str] = None


class ExchangeMigrator:
    """Migrates one user's Exchange mailboxes for a single job."""

    def __init__(self, ctx: JobContext, source_tenant_id: str, dest_tenant_id: str) -> None:
        self._ctx = ctx
        self._source_tenant_id = source_tenant_id
        self._dest_tenant_id = dest_tenant_id
        self._graph: GraphClient = ctx.graph
        self._exporter = MailboxExporter(ctx.graph, source_tenant_id)
        self._importer = MailboxImporter(ctx.graph, dest_tenant_id)

    # ---- public entry point ----------------------------------------------

    async def run(self) -> JobStatus:
        """Execute the pass. Returns the terminal-ish status to report."""
        ctx = self._ctx
        is_delta = ctx.dispatch.pass_ == "delta"
        running_status = JobStatus.DELTA_RUNNING if is_delta else JobStatus.RUNNING

        await ctx.report_progress(
            running_status, phase_text="Resolving mailboxes…", force=True
        )

        source_mailboxes = await self._resolve_mailboxes(
            TenantRole.SOURCE, self._source_tenant_id, ctx.dispatch.source_email,
            include_archive=ctx.dispatch.include_archive,
        )
        # Destination mailbox is resolved from the target UPN; for v1 we import
        # into the matching mailbox type on the destination side.
        dest_mailboxes = await self._resolve_mailboxes(
            TenantRole.DESTINATION, self._dest_tenant_id, ctx.dispatch.target_upn,
            include_archive=ctx.dispatch.include_archive,
        )
        dest_by_type = {m.mailbox_type: m for m in dest_mailboxes}

        for src_mbx in source_mailboxes:
            if ctx.should_stop():
                log.info("exchange_migrator_stopping", extra={"job_id": ctx.job_id})
                return running_status  # not terminal; will resume on next claim
            dst_mbx = dest_by_type.get(src_mbx.mailbox_type)
            if dst_mbx is None:
                log.warning(
                    "exchange_dest_mailbox_missing",
                    extra={"job_id": ctx.job_id, "type": src_mbx.mailbox_type},
                )
                continue
            await self._migrate_mailbox(src_mbx, dst_mbx, is_delta=is_delta)

        await ctx.flush_items()
        # Persist the terminal delta token so the next incremental pass resumes.
        await ctx.report_progress(
            running_status,
            phase_text="Mailbox pass complete",
            delta_token=_encode_deltas(ctx.store.checkpoint.cursor.get("item_deltas", {})),
            force=True,
        )
        await ctx.store.flush()
        return JobStatus.COMPLETED

    # ---- mailbox resolution ----------------------------------------------

    async def _resolve_mailboxes(
        self, role: TenantRole, tenant_id: str, user_ref: str, *, include_archive: bool
    ) -> list[MailboxRef]:
        """Resolve a user's mailboxes via their Exchange user settings.

        Uses ``GET /users/{id}/settings/exchange`` which lists the mailboxes
        (primary/archive/shared) with the ids used by the admin/exchange APIs.
        """
        try:
            data = await self._graph.get_json(
                f"/users/{user_ref}/settings/exchange", role=role, tenant_id=tenant_id
            )
        except GraphError as exc:
            log.error(
                "exchange_mailbox_resolve_failed",
                extra={"user": user_ref, "role": role.value, "error": exc.error_class},
            )
            raise

        refs: list[MailboxRef] = []
        for mbx in data.get("mailboxes", []):
            mtype = (mbx.get("mailboxType") or "primary").lower()
            if mtype == "archive" and not include_archive:
                continue
            refs.append(MailboxRef(mailbox_id=mbx["id"], mailbox_type=mtype))
        if not refs:
            log.warning(
                "exchange_no_mailboxes_resolved",
                extra={"user": user_ref, "role": role.value},
            )
        return refs

    # ---- per-mailbox migration -------------------------------------------

    async def _migrate_mailbox(
        self, src: MailboxRef, dst: MailboxRef, *, is_delta: bool
    ) -> None:
        ctx = self._ctx
        cursor = ctx.store.checkpoint.cursor
        folder_map: dict[str, str] = cursor.setdefault("folder_map", {})
        folders_done: list[str] = cursor.setdefault("folders_done", [])
        item_deltas: dict[str, str] = cursor.setdefault("item_deltas", {})

        # Per-mailbox concurrency slot (governor also caps per-tenant).
        async with ctx.governor.slot(self._source_tenant_id, mailbox=src.mailbox_id):
            folder_enum = await self._enumerate_folders(src.mailbox_id, is_delta, cursor)

            for folder in folder_enum.folders:
                if ctx.should_stop():
                    return
                src_folder_id = folder["id"]
                if src_folder_id in folders_done and not is_delta:
                    continue  # already fully migrated on a prior (interrupted) run

                dst_folder_id = await self._ensure_dest_folder(
                    dst.mailbox_id, folder, folder_map
                )

                await self._migrate_folder_items(
                    src.mailbox_id,
                    src_folder_id,
                    dst.mailbox_id,
                    dst_folder_id,
                    folder.get("displayName"),
                    item_deltas,
                    is_delta=is_delta,
                )

                if not is_delta and src_folder_id not in folders_done:
                    folders_done.append(src_folder_id)
                await ctx.heartbeat(
                    JobStatus.DELTA_RUNNING if is_delta else JobStatus.RUNNING,
                    phase_text=f"Folder: {folder.get('displayName', src_folder_id)}",
                )

            # Persist the folder-level delta link for the next pass.
            if folder_enum.delta_link:
                cursor["folder_delta_link"] = folder_enum.delta_link

    async def _enumerate_folders(
        self, mailbox_id: str, is_delta: bool, cursor: dict
    ) -> _FolderEnum:
        """Page ``folders/delta``; on a delta pass start from the stored link."""
        start = (
            cursor.get("folder_delta_link")
            if is_delta and cursor.get("folder_delta_link")
            else f"/admin/exchange/mailboxes/{mailbox_id}/folders/delta"
        )
        folders: list[dict] = []
        delta_link: Optional[str] = None
        next_url: Optional[str] = start
        while next_url:
            resp = await self._graph.request(
                "GET", next_url, role=TenantRole.SOURCE, tenant_id=self._source_tenant_id
            )
            body = resp.json()
            folders.extend(body.get("value", []))
            delta_link = body.get("@odata.deltaLink") or delta_link
            next_url = body.get("@odata.nextLink")
        return _FolderEnum(folders=folders, delta_link=delta_link)

    async def _ensure_dest_folder(
        self, dest_mailbox_id: str, src_folder: dict, folder_map: dict[str, str]
    ) -> str:
        """Return the destination folder id for a source folder, creating it if
        needed. The mapping is cached in the checkpoint so re-runs are stable."""
        src_id = src_folder["id"]
        if src_id in folder_map:
            return folder_map[src_id]

        display_name = src_folder.get("displayName", "Migrated")
        # Create as a child of the destination root folder collection. Folder
        # hierarchy nesting beyond one level is a simplification; the
        # parentFolderId chain should be honoured once validated in Phase 1.
        resp = await self._graph.request(
            "POST",
            f"/admin/exchange/mailboxes/{dest_mailbox_id}/folders",
            role=TenantRole.DESTINATION,
            tenant_id=self._dest_tenant_id,
            json_body={"displayName": display_name},
            expected=(200, 201),
        )
        dest_id = resp.json()["id"]
        folder_map[src_id] = dest_id
        return dest_id

    async def _migrate_folder_items(
        self,
        src_mailbox_id: str,
        src_folder_id: str,
        dst_mailbox_id: str,
        dst_folder_id: str,
        folder_path: Optional[str],
        item_deltas: dict[str, str],
        *,
        is_delta: bool,
    ) -> None:
        ctx = self._ctx
        item_enum = await self._enumerate_items(
            src_mailbox_id, src_folder_id, item_deltas, is_delta=is_delta
        )
        # NOTE: item deletions on a delta pass (item_enum.removed) are not
        # replayed to the destination in v1 (migration is additive) — documented
        # limitation. They are captured here for a future tombstone phase.

        for batch in chunk_item_ids(item_enum.added_or_updated):
            if ctx.should_stop():
                break
            await self._process_export_batch(
                src_mailbox_id, dst_mailbox_id, dst_folder_id, batch, folder_path,
                mode="update" if is_delta else "create",
            )
            await ctx.heartbeat(
                JobStatus.DELTA_RUNNING if is_delta else JobStatus.RUNNING,
                phase_text=f"Migrating {folder_path or src_folder_id} "
                f"[{ctx.progress_current} items]",
            )

        # Persist this folder's item delta link for the next incremental pass.
        if item_enum.delta_link:
            item_deltas[src_folder_id] = item_enum.delta_link

    async def _enumerate_items(
        self,
        mailbox_id: str,
        folder_id: str,
        item_deltas: dict[str, str],
        *,
        is_delta: bool,
    ) -> _ItemEnum:
        start = (
            item_deltas.get(folder_id)
            if is_delta and item_deltas.get(folder_id)
            else f"/admin/exchange/mailboxes/{mailbox_id}/folders/{folder_id}/items/delta"
        )
        out = _ItemEnum()
        next_url: Optional[str] = start
        while next_url:
            resp = await self._graph.request(
                "GET", next_url, role=TenantRole.SOURCE, tenant_id=self._source_tenant_id
            )
            body = resp.json()
            for item in body.get("value", []):
                if "@removed" in item:
                    out.removed.append(item["id"])
                else:
                    out.added_or_updated.append(item["id"])
            out.delta_link = body.get("@odata.deltaLink") or out.delta_link
            next_url = body.get("@odata.nextLink")
        return out

    async def _process_export_batch(
        self,
        src_mailbox_id: str,
        dst_mailbox_id: str,
        dst_folder_id: str,
        item_ids: list[str],
        folder_path: Optional[str],
        *,
        mode: str,
    ) -> None:
        """Export a <=20 batch and import each item, with per-item retry +
        skip-and-log. A single failing item never aborts the batch or the job."""
        ctx = self._ctx
        result = await self._exporter.export_items(src_mailbox_id, item_ids)

        # Items the export API itself rejected -> skip-and-log immediately.
        for err in result.errors:
            ctx.log_item(
                err.item_id,
                status=ItemStatus.SKIPPED,
                error_class=err.code,
                error_detail=err.message,
                folder_path=folder_path,
            )

        for item in result.exported:
            ok = await self._import_with_retries(
                dst_mailbox_id, dst_folder_id, item, folder_path, mode=mode
            )
            if ok:
                ctx.progress_current += 1
                ctx.items_succeeded += 1
                # Approximate decoded size from the base64 stream length.
                ctx.bytes_done += (len(item.data) * 3) // 4

    async def _import_with_retries(
        self,
        dst_mailbox_id: str,
        dst_folder_id: str,
        item: ExportedItem,
        folder_path: Optional[str],
        *,
        mode: str,
    ) -> bool:
        """Import one item, retrying transient errors up to ``itemMaxRetries``.

        Auth/permission/quota errors are re-raised (they are job-fatal and map
        to distinct statuses). Everything else is retried, then skip-and-logged.
        """
        ctx = self._ctx
        attempts = 0
        last_err: Optional[GraphError] = None
        while attempts <= ctx.config.item_max_retries:
            try:
                await self._importer.import_item(
                    dst_mailbox_id, dst_folder_id, item, mode=mode
                )
                return True
            except (PermissionRevoked, QuotaExceeded):
                raise  # job-fatal, distinct status — do not swallow
            except GraphError as exc:
                last_err = exc
                attempts += 1
                log.debug(
                    "exchange_item_retry",
                    extra={
                        "job_id": ctx.job_id,
                        "item_id": item.item_id,
                        "attempt": attempts,
                        "error_class": exc.error_class,
                    },
                )
        # A token still rejected after every retry (invalidated + re-fetched by the
        # GraphClient on each 401) is a genuine auth failure — surface it as the
        # distinct auth_expired job status rather than swallowing it per-item.
        if isinstance(last_err, AuthExpired):
            raise last_err
        # Retry budget exhausted -> skip-and-log (item-level failure only).
        ctx.log_item(
            item.item_id,
            status=ItemStatus.FAILED,
            error_class=last_err.error_class if last_err else "ImportFailed",
            error_detail=last_err.detail if last_err else "unknown import failure",
            folder_path=folder_path,
        )
        return False


def _encode_deltas(item_deltas: dict[str, str]) -> Optional[str]:
    """Pack the per-folder item delta links into a single opaque token string.

    The control plane stores this verbatim in ``jobs.delta_token``; the engine
    re-reads the full map from its checkpoint, so this is primarily a
    UI-visible marker that a delta baseline exists.
    """
    if not item_deltas:
        return None
    import json

    return base64.urlsafe_b64encode(json.dumps(item_deltas).encode()).decode()
