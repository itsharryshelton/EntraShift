"""Bootstrap: ``python -m entrashift_engine`` and the ``entrashift-engine``
console script both land here.

Runs the async engine loop with graceful KeyboardInterrupt handling (the SIGINT
fallback for Windows dev boxes; on Linux the signal handlers in ``worker`` take
over).
"""

from __future__ import annotations

import asyncio

from .worker import run_engine


def main() -> None:
    try:
        asyncio.run(run_engine())
    except KeyboardInterrupt:
        # Graceful: the signal handler already asked the loop to stop.
        pass


if __name__ == "__main__":
    main()
