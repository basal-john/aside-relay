"""HTTP routes for subscription usage windows."""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time

from fastapi import APIRouter, Depends, HTTPException

import usage
from daemon import ACCOUNT_ID, daemon

log = logging.getLogger("aside-relay")
router = APIRouter()

# Aside sometimes returns usage:null for an active provider. Keep the last
# non-empty snapshot so the badge does not vanish the way bb's cache does not.
_CACHE_TTL_SECONDS = 30 * 60
_last_good: dict[str, tuple[float, dict]] = {}
_BB_BIN = shutil.which("bb") or "/opt/homebrew/bin/bb"


def attach(auth_dependency):
    """Register the usage route with the same Auth dependency the rest of the app uses."""

    @router.get("/api/usage", dependencies=[Depends(auth_dependency)])
    async def api_usage(provider: str | None = None):
        """Subscription usage windows for the selected model provider, same shape bb shows."""
        provider_id = provider.strip() if isinstance(provider, str) else ""
        if not usage.supports_usage(provider_id):
            return {"providerId": provider_id or None, "state": None, "windows": []}
        try:
            payload = await daemon.call("models.getSubscriptionUsage", {
                "accountId": ACCOUNT_ID, "providerId": provider_id,
            })
            result = usage.normalize_usage(payload if isinstance(payload, dict) else None)
        except Exception:
            log.exception("subscription usage failed")
            cached = _cached(provider_id)
            if cached is not None:
                return cached
            fallback = await _bb_fallback(provider_id)
            if fallback is not None:
                _remember(provider_id, fallback)
                return fallback
            raise HTTPException(502, "Could not load usage.")
        if result["windows"]:
            _remember(provider_id, result)
            return result
        cached = _cached(provider_id)
        if cached is not None:
            return cached
        fallback = await _bb_fallback(provider_id)
        if fallback is not None:
            _remember(provider_id, fallback)
            return fallback
        return result

    return router


def _remember(provider_id: str, payload: dict) -> None:
    _last_good[provider_id] = (time.monotonic(), payload)


def _cached(provider_id: str) -> dict | None:
    entry = _last_good.get(provider_id)
    if not entry:
        return None
    saved_at, payload = entry
    if time.monotonic() - saved_at > _CACHE_TTL_SECONDS:
        return None
    return payload


async def _bb_fallback(provider_id: str) -> dict | None:
    """When Aside has no windows, reuse bb's cached provider usage on this Mac."""
    aliases = usage.BB_PROVIDER_ALIASES.get(provider_id, (provider_id,))
    try:
        proc = await asyncio.create_subprocess_exec(
            _BB_BIN, "model-token-usage",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=8)
    except Exception:
        log.exception("bb usage fallback failed")
        return None
    if proc.returncode != 0 or not stdout:
        return None
    try:
        snapshot = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    providers = snapshot.get("providers") if isinstance(snapshot, dict) else None
    if not isinstance(providers, dict):
        return None
    for alias in aliases:
        mapped = usage.normalize_bb_provider(provider_id, providers.get(alias))
        if mapped is not None:
            return mapped
    return None
