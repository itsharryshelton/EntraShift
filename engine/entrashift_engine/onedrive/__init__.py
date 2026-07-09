"""OneDrive for Business migration module (SoW Phase 4, OneDrive module).

Recursive copy preserving folder structure and Created/Modified metadata (where
the Graph API allows), using the drive **delta API** for enumeration and
incremental passes, **upload sessions** for files larger than 4 MB, and
path-length / invalid-character remediation logged per item.

Latest file version only — version history is explicitly out of scope.
"""
