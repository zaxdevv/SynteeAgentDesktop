"""Feature flags backed by the AppConfig table.

Centralised read access to boolean toggles stored as AppConfig rows so that
runtime services (global chat gating, launcher download gating) don't have to
hit the DB on every request — values are cached in-process for a short TTL.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from sqlalchemy import select

from app.db.models.config import AppConfig
from app.db.session import async_session_factory

logger = logging.getLogger(__name__)

_CACHE_TTL = 15.0  # seconds — short enough for admin toggles to take effect quickly

_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = asyncio.Lock()


async def _read_raw(key: str) -> Any | None:
    async with async_session_factory() as db:
        row = (
            await db.execute(select(AppConfig).where(AppConfig.key == key))
        ).scalar_one_or_none()
        return row.value if row else None


async def get_flag(key: str, default: bool = False) -> bool:
    """Return a boolean feature flag, cached for _CACHE_TTL seconds."""
    now = time.time()
    cached = _cache.get(key)
    if cached and now - cached[0] < _CACHE_TTL:
        return bool(cached[1])

    async with _cache_lock:
        cached = _cache.get(key)
        if cached and now - cached[0] < _CACHE_TTL:
            return bool(cached[1])
        try:
            value = await _read_raw(key)
        except Exception as exc:
            logger.warning("feature flag read failed for %s: %s", key, exc)
            return default
        result = bool(value.get("enabled", default)) if isinstance(value, dict) else bool(value if value is not None else default)
        _cache[key] = (time.time(), result)
        return result


async def is_global_chat_enabled() -> bool:
    return await get_flag("global_chat", default=True)


async def is_launcher_download_open() -> bool:
    return await get_flag("launcher_download_open", default=False)


async def is_response_cache_enabled() -> bool:
    """Response caching feature flag — default True (enabled by default)."""
    return await get_flag("response_cache", default=True)


async def invalidate(key: str) -> None:
    async with _cache_lock:
        _cache.pop(key, None)
