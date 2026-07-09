"""OneDrive migration orchestrator.

Flow per job (one user's OneDrive):

    1. Resolve source + destination drive ids from the UPNs.
    2. Enumerate the source drive with ``/drive/root/delta`` (no token = full
       pass; stored token = delta pass). The delta feed returns folders and
       files flat, each with a ``parentReference``.
    3. Recreate the folder hierarchy in the destination (parents first),
       remediating invalid characters / over-long path segments and logging any
       remediation per item to the local VM log.
    4. Copy each file: stream the source content and either simple-PUT it
       (<= 4 MB) or drive an upload session in 320 KiB-aligned chunks (> 4 MB).
       Preserve Created/Modified via a follow-up ``fileSystemInfo`` PATCH.
    5. Persist the delta link so the next incremental pass only moves changes.

Item-level failures are retried up to ``itemMaxRetries`` then skip-and-logged;
they never fail the drive job. Latest version only (no version history).

PROTOTYPE: metadata-preservation fidelity and conflict behaviour must be
validated in Phase 1; the enumeration/upload/skip-and-log structure is the
load-bearing part.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

import httpx

from ..contracts import ItemStatus, JobStatus, TenantRole
from ..graph.client import GraphClient
from ..graph.errors import AuthExpired, GraphError, PermissionRevoked, QuotaExceeded
from ..job_context import JobContext
from ..logging_setup import get_logger

log = get_logger("onedrive.migrator")

# Graph large-file threshold is 4 MB; the exact value comes from EngineConfig.
# Upload-session chunks MUST be a multiple of 320 KiB (327,680 bytes) and each
# request must stay under 60 MiB. We use 10 * 320 KiB = 3.2 MiB.
_CHUNK_MULTIPLE = 327_680
_UPLOAD_CHUNK = _CHUNK_MULTIPLE * 10  # 3,276,800 bytes

# Characters not permitted in OneDrive/SharePoint item names.
_INVALID_CHARS = re.compile(r'[\\/:*?"<>|]')
# Conservative per-segment length cap for remediation.
_MAX_SEGMENT_LEN = 255


@dataclass(slots=True)
class _DriveEnum:
    items: list[dict] = field(default_factory=list)
    delta_link: Optional[str] = None


class OneDriveMigrator:
    """Migrates one user's OneDrive for a single job."""

    def __init__(self, ctx: JobContext, source_tenant_id: str, dest_tenant_id: str) -> None:
        self._ctx = ctx
        self._source_tenant_id = source_tenant_id
        self._dest_tenant_id = dest_tenant_id
        self._graph: GraphClient = ctx.graph

    async def aclose(self) -> None:
        # No-op retained for the worker's lifecycle contract. All HTTP — including
        # preauthenticated download/upload URLs — now flows through the shared
        # GraphClient so Retry-After / backoff / governor accounting always apply.
        return None

    # ---- entry point ------------------------------------------------------

    async def run(self) -> JobStatus:
        ctx = self._ctx
        is_delta = ctx.dispatch.pass_ == "delta"
        running = JobStatus.DELTA_RUNNING if is_delta else JobStatus.RUNNING
        cursor = ctx.store.checkpoint.cursor
        folder_map: dict[str, str] = cursor.setdefault("folder_map", {})
        items_done: set[str] = set(cursor.setdefault("items_done", []))

        await ctx.report_progress(running, phase_text="Resolving drives…", force=True)

        src_drive = await self._resolve_drive_root(
            TenantRole.SOURCE, self._source_tenant_id, ctx.dispatch.source_email
        )
        dst_drive = await self._resolve_drive_root(
            TenantRole.DESTINATION, self._dest_tenant_id, ctx.dispatch.target_upn
        )
        # Map the source root to the destination root up front.
        folder_map.setdefault(src_drive["rootId"], dst_drive["rootId"])

        try:
            async with ctx.governor.slot(
                self._source_tenant_id, mailbox=src_drive["driveId"]
            ):
                enum = await self._enumerate(src_drive, cursor, is_delta=is_delta)
                await self._apply(
                    enum, src_drive, dst_drive, folder_map, items_done, running
                )
                if enum.delta_link:
                    cursor["delta_link"] = enum.delta_link
        finally:
            cursor["items_done"] = list(items_done)

        await ctx.flush_items()
        await ctx.report_progress(
            running,
            phase_text="OneDrive pass complete",
            delta_token=cursor.get("delta_link"),
            force=True,
        )
        await ctx.store.flush()
        return JobStatus.COMPLETED

    # ---- drive resolution -------------------------------------------------

    async def _resolve_drive_root(
        self, role: TenantRole, tenant_id: str, user_ref: str
    ) -> dict:
        root = await self._graph.get_json(
            f"/users/{user_ref}/drive/root", role=role, tenant_id=tenant_id
        )
        drive = root.get("parentReference", {}).get("driveId") or root.get("id")
        return {"userRef": user_ref, "rootId": root["id"], "driveId": drive}

    # ---- enumeration ------------------------------------------------------

    async def _enumerate(
        self, src_drive: dict, cursor: dict, *, is_delta: bool
    ) -> _DriveEnum:
        """Page the drive delta feed. Delta pass starts from the stored link."""
        start = (
            cursor.get("delta_link")
            if is_delta and cursor.get("delta_link")
            else f"/users/{src_drive['userRef']}/drive/root/delta"
        )
        out = _DriveEnum()
        next_url: Optional[str] = start
        while next_url:
            resp = await self._graph.request(
                "GET", next_url, role=TenantRole.SOURCE, tenant_id=self._source_tenant_id
            )
            body = resp.json()
            out.items.extend(body.get("value", []))
            out.delta_link = body.get("@odata.deltaLink") or out.delta_link
            next_url = body.get("@odata.nextLink")
        return out

    async def _apply(
        self,
        enum: _DriveEnum,
        src_drive: dict,
        dst_drive: dict,
        folder_map: dict[str, str],
        items_done: set[str],
        running: JobStatus,
    ) -> None:
        ctx = self._ctx
        # Separate folders and files; create folders shallow-first so parents
        # exist before children.
        folders = [i for i in enum.items if "folder" in i and "root" not in i]
        files = [i for i in enum.items if "file" in i]
        ctx.progress_total = len(files)

        folders.sort(key=lambda i: _depth(i))
        for folder in folders:
            if ctx.should_stop():
                return
            await self._ensure_dest_folder(folder, dst_drive, folder_map)

        for f in files:
            if ctx.should_stop():
                return
            if f["id"] in items_done:
                continue  # already copied on a prior interrupted run
            ok = await self._copy_file_with_retries(f, src_drive, dst_drive, folder_map)
            if ok:
                items_done.add(f["id"])
                ctx.progress_current += 1
                ctx.bytes_done += int(f.get("size", 0))
            await ctx.heartbeat(
                running,
                phase_text=f"Copying files [{ctx.progress_current}/{ctx.progress_total}]",
            )

    # ---- folder creation --------------------------------------------------

    async def _ensure_dest_folder(
        self, folder: dict, dst_drive: dict, folder_map: dict[str, str]
    ) -> str:
        src_id = folder["id"]
        if src_id in folder_map:
            return folder_map[src_id]

        parent_src = folder.get("parentReference", {}).get("id")
        dst_parent = folder_map.get(parent_src, dst_drive["rootId"])
        name = self._remediate_name(folder.get("name", "Folder"), src_id)

        resp = await self._graph.request(
            "POST",
            f"/users/{dst_drive['userRef']}/drive/items/{dst_parent}/children",
            role=TenantRole.DESTINATION,
            tenant_id=self._dest_tenant_id,
            json_body={
                "name": name,
                "folder": {},
                "@microsoft.graph.conflictBehavior": "replace",
            },
            expected=(200, 201),
        )
        dst_id = resp.json()["id"]
        folder_map[src_id] = dst_id
        return dst_id

    # ---- file copy --------------------------------------------------------

    async def _copy_file_with_retries(
        self, f: dict, src_drive: dict, dst_drive: dict, folder_map: dict[str, str]
    ) -> bool:
        ctx = self._ctx
        attempts = 0
        last_err: Optional[Exception] = None
        while attempts <= ctx.config.item_max_retries:
            try:
                await self._copy_file(f, src_drive, dst_drive, folder_map)
                return True
            except (PermissionRevoked, QuotaExceeded):
                raise  # job-fatal, distinct status
            except (GraphError, httpx.HTTPError) as exc:
                last_err = exc
                attempts += 1
                log.debug(
                    "onedrive_item_retry",
                    extra={"job_id": ctx.job_id, "item_id": f["id"], "attempt": attempts},
                )
        # A token that is still rejected after every retry (invalidated + re-fetched
        # by the GraphClient on each 401) is a genuine auth failure — surface it as
        # the distinct auth_expired job status rather than swallowing it per-item.
        if isinstance(last_err, AuthExpired):
            raise last_err
        error_class = (
            last_err.error_class if isinstance(last_err, GraphError) else "UploadFailed"
        )
        ctx.log_item(
            f["id"],
            status=ItemStatus.FAILED,
            error_class=error_class,
            error_detail=str(last_err)[:2000] if last_err else "unknown upload failure",
            folder_path=f.get("parentReference", {}).get("path"),
        )
        return False

    async def _copy_file(
        self, f: dict, src_drive: dict, dst_drive: dict, folder_map: dict[str, str]
    ) -> None:
        threshold = self._ctx.config.onedrive_upload_session_threshold_bytes
        size = int(f.get("size", 0))
        parent_src = f.get("parentReference", {}).get("id")
        dst_parent = folder_map.get(parent_src, dst_drive["rootId"])
        name = self._remediate_name(f.get("name", "file"), f["id"])
        fs_info = f.get("fileSystemInfo", {})

        content = await self._download(f, src_drive)

        if size <= threshold:
            dst_item = await self._simple_upload(dst_drive, dst_parent, name, content)
        else:
            dst_item = await self._session_upload(
                dst_drive, dst_parent, name, content, fs_info
            )

        # Preserve Created/Modified where the API allows (best effort).
        if dst_item and fs_info:
            await self._patch_metadata(dst_drive, dst_item, fs_info)

    async def _download(self, f: dict, src_drive: dict) -> bytes:
        """Stream file content through the GraphClient choke point so Retry-After,
        backoff, and governor accounting always apply. Prefer the preauthenticated
        download URL (called WITHOUT a bearer header, per the GraphClient
        contract); fall back to the authenticated /content endpoint (which
        302-redirects to a download URL — followed by the client)."""
        download_url = f.get("@microsoft.graph.downloadUrl") or f.get(
            "@content.downloadUrl"
        )
        if download_url:
            resp = await self._graph.request(
                "GET",
                download_url,
                authenticated=False,  # preauthenticated URL — no bearer header
                tenant_id=self._source_tenant_id,
            )
            return resp.content
        resp = await self._graph.request(
            "GET",
            f"/users/{src_drive['userRef']}/drive/items/{f['id']}/content",
            role=TenantRole.SOURCE,
            tenant_id=self._source_tenant_id,
        )
        return resp.content

    async def _simple_upload(
        self, dst_drive: dict, parent_id: str, name: str, content: bytes
    ) -> str:
        resp = await self._graph.request(
            "PUT",
            f"/users/{dst_drive['userRef']}/drive/items/{parent_id}:/{name}:/content",
            role=TenantRole.DESTINATION,
            tenant_id=self._dest_tenant_id,
            content=content,
            headers={"Content-Type": "application/octet-stream"},
            expected=(200, 201),
        )
        return resp.json().get("id", "")

    async def _session_upload(
        self, dst_drive: dict, parent_id: str, name: str, content: bytes, fs_info: dict
    ) -> str:
        """Upload a large file via an upload session, 320 KiB-aligned chunks."""
        session = await self._graph.request(
            "POST",
            f"/users/{dst_drive['userRef']}/drive/items/{parent_id}:/{name}:/createUploadSession",
            role=TenantRole.DESTINATION,
            tenant_id=self._dest_tenant_id,
            json_body={
                "item": {
                    "@microsoft.graph.conflictBehavior": "replace",
                    "name": name,
                    "fileSystemInfo": fs_info,
                }
            },
            expected=(200, 201),
        )
        upload_url = session.json()["uploadUrl"]

        total = len(content)
        start = 0
        dst_id = ""
        while start < total:
            end = min(start + _UPLOAD_CHUNK, total)
            chunk = content[start:end]
            # The upload URL is preauthenticated — NO Authorization header — but
            # it still goes through the GraphClient so a 429/503 mid-upload
            # honours Retry-After with backoff (a chunk 202 is the in-progress
            # ack; 200/201 completes the file).
            resp = await self._graph.request(
                "PUT",
                upload_url,
                authenticated=False,
                tenant_id=self._dest_tenant_id,
                content=chunk,
                headers={
                    "Content-Length": str(len(chunk)),
                    "Content-Range": f"bytes {start}-{end - 1}/{total}",
                },
                expected=(200, 201, 202),
            )
            if resp.status_code in (200, 201):
                dst_id = resp.json().get("id", "")
            start = end
        return dst_id

    async def _patch_metadata(self, dst_drive: dict, item_id: str, fs_info: dict) -> None:
        try:
            await self._graph.request(
                "PATCH",
                f"/users/{dst_drive['userRef']}/drive/items/{item_id}",
                role=TenantRole.DESTINATION,
                tenant_id=self._dest_tenant_id,
                json_body={"fileSystemInfo": fs_info},
            )
        except GraphError as exc:
            # Metadata preservation is best-effort; a failure here does not fail
            # the file copy. Recorded in the local log only.
            log.info(
                "onedrive_metadata_patch_failed",
                extra={"item_id": item_id, "error_class": exc.error_class},
            )

    # ---- remediation ------------------------------------------------------

    def _remediate_name(self, name: str, item_id: str) -> str:
        """Replace invalid characters and truncate over-long segments.

        Any change is recorded to the local VM log as a per-item remediation
        entry (SoW Phase 4 — per-item remediation log). This is not a failure,
        so it is not sent to the control-plane skip/fail table.
        """
        remediated = _INVALID_CHARS.sub("_", name).strip().rstrip(".")
        if not remediated:
            remediated = f"item_{item_id[:8]}"
        if len(remediated) > _MAX_SEGMENT_LEN:
            remediated = remediated[:_MAX_SEGMENT_LEN]
        if remediated != name:
            log.info(
                "onedrive_remediation",
                extra={
                    "job_id": self._ctx.job_id,
                    "item_id": item_id,
                    "original": name,
                    "remediated": remediated,
                },
            )
        return remediated


def _depth(item: dict) -> int:
    """Folder depth from its parentReference path (shallow-first ordering)."""
    path = item.get("parentReference", {}).get("path", "")
    # Path looks like '/drive/root:/A/B'. Count segments after 'root:'.
    tail = path.split("root:", 1)[-1]
    return tail.count("/")
