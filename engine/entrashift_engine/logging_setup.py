"""JSON-lines rotating file logging for the VM (SoW Phase 5).

Design constraints from the scope:
    * Structured **JSON-lines** rotating text logs on the VM.
    * Covers job lifecycle, throttling events, and item-level errors.
    * Contains **no credentials and no message content** — ever.

The redaction filter is a defence-in-depth backstop: call sites must not pass
secrets or item bodies in the first place, but the filter scrubs known-sensitive
keys and bearer tokens from any record that slips through.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import re
from datetime import datetime, timezone
from typing import Any

# Keys whose values must never be written to the log, at any nesting level.
_SENSITIVE_KEYS = frozenset(
    {
        "authorization",
        "access_token",
        "accesstoken",
        "client_secret",
        "clientsecret",
        "secret",
        "password",
        "cf-access-client-secret",
        "cf_access_client_secret",
        "cf-access-client-id",
        "cf_queue_api_token",
        "api_token",
        "token",
        "data",  # base64 mailbox item stream / file bytes — message content
        "importurl",
        "uploadurl",
        "content",
    }
)

# Redact bearer tokens embedded in free-text messages.
_BEARER_RE = re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+")
_REDACTED = "***REDACTED***"

# Standard LogRecord attributes we do not want duplicated into the JSON `extra`.
_RESERVED = frozenset(
    logging.makeLogRecord({}).__dict__.keys()
    | {"message", "asctime", "taskName"}
)


def _scrub(value: Any) -> Any:
    """Recursively redact sensitive keys / bearer tokens in a value."""
    if isinstance(value, dict):
        return {
            k: (_REDACTED if str(k).lower() in _SENSITIVE_KEYS else _scrub(v))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_scrub(v) for v in value]
    if isinstance(value, str):
        return _BEARER_RE.sub("bearer " + _REDACTED, value)
    return value


class JsonLinesFormatter(logging.Formatter):
    """Render each record as a single JSON object on one line."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
        }
        # Merge structured context passed via `extra={...}`.
        for key, val in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = val
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)

        payload = _scrub(payload)
        return json.dumps(payload, default=str, ensure_ascii=False)


class _RedactingFilter(logging.Filter):
    """Scrub the formatted message string as a second backstop."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _BEARER_RE.sub("bearer " + _REDACTED, record.msg)
        return True


def setup_logging(
    log_dir: str,
    level: str = "INFO",
    max_bytes: int = 10_485_760,
    backup_count: int = 10,
) -> logging.Logger:
    """Configure the root ``entrashift`` logger with a rotating JSON-lines file
    handler plus a console handler. Idempotent."""
    os.makedirs(log_dir, exist_ok=True)
    logger = logging.getLogger("entrashift")
    logger.setLevel(level.upper())
    logger.propagate = False

    if logger.handlers:  # already configured
        return logger

    formatter = JsonLinesFormatter()
    redactor = _RedactingFilter()

    file_handler = logging.handlers.RotatingFileHandler(
        os.path.join(log_dir, "engine.jsonl"),
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(redactor)
    logger.addHandler(file_handler)

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console.addFilter(redactor)
    logger.addHandler(console)

    return logger


def get_logger(name: str = "entrashift") -> logging.Logger:
    """Return a child logger under the configured ``entrashift`` root."""
    return logging.getLogger(name if name.startswith("entrashift") else f"entrashift.{name}")
