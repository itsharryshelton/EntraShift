"""Exchange Online migration module — Microsoft Graph mailbox import/export.

EWS is FORBIDDEN (disabled by Microsoft from Oct 2026). This module is built
entirely on the Graph mailbox import/export APIs (v1.0):

    * ``POST /admin/exchange/mailboxes/{id}/exportItems`` (max 20 items/call)
    * ``POST /admin/exchange/mailboxes/{id}/createImportSession`` + import URL
    * ``mailboxFolder: delta`` / ``mailboxItem: delta`` for incremental passes

Supports primary, archive, and shared mailboxes.
"""
