from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

logger = logging.getLogger(__name__)


class IngestionTaskGroup:
    """Own in-process ingestion tasks for one application's lifespan."""

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task[None]] = set()
        self._closing = False

    def start(self, operation: Coroutine[Any, Any, None]) -> None:
        if self._closing:
            operation.close()
            raise RuntimeError("Ingestion service is shutting down")
        task = asyncio.create_task(operation)
        self._tasks.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (error := task.exception()) is not None:
            logger.error(
                "Ingestion task failed", exc_info=(type(error), error, error.__traceback__)
            )

    async def close(self) -> None:
        self._closing = True
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
