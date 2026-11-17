"""Normalize Aside subscription usage into the windows bb shows next to a model."""
from __future__ import annotations

from datetime import datetime, timezone

SUBSCRIPTION_PROVIDERS = frozenset({
    "aside",
    "claude-code",
    "kimi-code",
    "openai-codex",
    "xai-grok-oauth",
})

WINDOW_ORDER = ("five_hour", "weekly", "monthly")
WINDOW_LABELS = {
    "five_hour": "5 hours",
    "weekly": "Weekly",
    "monthly": "Monthly",
}


def supports_usage(provider_id: str | None) -> bool:
    return bool(provider_id) and provider_id in SUBSCRIPTION_PROVIDERS


def normalize_usage(payload: dict | None) -> dict:
    """Turn Aside's getSubscriptionUsage payload into a stable relay response."""
    if not isinstance(payload, dict):
        return {"providerId": None, "state": None, "windows": []}
    provider_id = payload.get("providerId")
    state = payload.get("state")
    usage = payload.get("usage")
    windows = _windows_from_usage(usage if isinstance(usage, dict) else None)
    return {
        "providerId": provider_id if isinstance(provider_id, str) else None,
        "state": state if isinstance(state, str) else None,
        "windows": windows,
    }


def _windows_from_usage(usage: dict | None) -> list[dict]:
    if not usage:
        return []
    by_kind: dict[str, dict] = {}
    if "rateLimits" in usage:
        limits = usage.get("rateLimits")
        if isinstance(limits, dict):
            for key in ("primary", "secondary"):
                entry = limits.get(key)
                if not isinstance(entry, dict):
                    continue
                kind = _kind_from_minutes(entry.get("windowDurationMins"))
                if not kind or kind in by_kind:
                    continue
                by_kind[kind] = _window(kind, entry.get("usedPercent"), entry.get("resetsAt"))
    else:
        for entry in usage.get("windows") or []:
            if not isinstance(entry, dict):
                continue
            kind = _kind_from_id(entry.get("id"))
            if not kind or kind in by_kind:
                continue
            by_kind[kind] = _window(kind, entry.get("usedPercent"), entry.get("resetsAt"))
    return [by_kind[kind] for kind in WINDOW_ORDER if kind in by_kind]


def _kind_from_minutes(value) -> str | None:
    if not isinstance(value, (int, float)):
        return None
    if value <= 1440:
        return "five_hour"
    if 8640 <= value < 28800:
        return "weekly"
    if value >= 28800:
        return "monthly"
    return None


def _kind_from_id(value) -> str | None:
    if value in ("five_hour", "monthly", "weekly"):
        return value
    if value in ("five-hour", "five hour", "session"):
        return "five_hour"
    if value in ("seven_day", "seven-day"):
        return "weekly"
    return None


def normalize_bb_provider(provider_id: str, payload: dict | None) -> dict | None:
    """Map a bb model-token-usage provider block into the relay usage shape."""
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        return None
    by_kind: dict[str, dict] = {}
    for entry in payload.get("windows") or []:
        if not isinstance(entry, dict):
            continue
        kind = _kind_from_id(entry.get("kind")) or _kind_from_label(entry.get("label"))
        if not kind or kind in by_kind:
            continue
        by_kind[kind] = _window(kind, entry.get("usedPercent"), entry.get("resetsAt"))
    windows = [by_kind[kind] for kind in WINDOW_ORDER if kind in by_kind]
    if not windows:
        return None
    plan = payload.get("planLabel")
    return {
        "providerId": provider_id,
        "state": "active",
        "planLabel": plan if isinstance(plan, str) else None,
        "windows": windows,
        "source": "bb",
    }


def _kind_from_label(value) -> str | None:
    if not isinstance(value, str):
        return None
    label = value.strip().lower()
    if "week" in label:
        return "weekly"
    if "month" in label or label == "plan usage":
        return "monthly"
    if "hour" in label or "session" in label:
        return "five_hour"
    return None


# Aside provider ids to bb model-token-usage provider keys.
BB_PROVIDER_ALIASES = {
    "claude-code": ("claude-code",),
    "openai-codex": ("codex", "openai-codex"),
    "aside": ("aside",),
}


def _window(kind: str, used_percent, resets_at) -> dict:
    percent = used_percent if isinstance(used_percent, (int, float)) else 0
    return {
        "kind": kind,
        "label": WINDOW_LABELS[kind],
        "usedPercent": min(100, max(0, round(percent))),
        "resetsAt": _iso_reset(resets_at),
    }


def _iso_reset(value) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)) and value > 0:
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return None
