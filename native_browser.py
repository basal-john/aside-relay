"""Authenticated browser-control routes mounted by the main FastAPI app."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

import browser

router = APIRouter(prefix="/api/native/browser", tags=["browser"])

CONTROL_ACTIONS = {"click", "scroll", "type", "key", "back", "forward", "reload", "navigate"}
KEYS = {
    "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown",
    "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space",
}


@router.post("/tabs/{target_id}/control")
async def control_browser_tab(target_id: str, payload: dict, session: str | None = None,
                              show_all: bool = Query(False, alias="all")):
    action = payload.get("action")
    if action not in CONTROL_ACTIONS:
        raise HTTPException(400, "Unsupported browser action.")
    x, y = payload.get("x"), payload.get("y")
    if action == "click" and not (_is_unit_number(x) and _is_unit_number(y)):
        raise HTTPException(400, "Click coordinates must be between 0 and 1.")
    delta_x, delta_y = payload.get("deltaX", 0), payload.get("deltaY", 0)
    if action == "scroll" and not all(isinstance(value, int) and abs(value) <= 4000 for value in (delta_x, delta_y)):
        raise HTTPException(400, "Scroll distance is invalid.")
    text = payload.get("text", "")
    if action == "type" and (not isinstance(text, str) or len(text) > 5_000):
        raise HTTPException(400, "Text is invalid.")
    key = payload.get("key", "")
    if action == "key" and key not in KEYS:
        raise HTTPException(400, "Key is not supported.")
    url = payload.get("url", "")
    if action == "navigate" and not _is_web_url(url):
        raise HTTPException(400, "Use a full http:// or https:// address.")
    return await browser.control_tab(
        target_id, action, session_id=session, show_all=show_all,
        x=x, y=y, delta_x=delta_x, delta_y=delta_y, text=text, key=key, url=url,
    )


@router.get("/library")
async def browser_library(kind: str = Query(pattern="^(history|bookmarks|groups)$"),
                          session: str | None = None, query: str = "",
                          limit: int = Query(100, ge=1, le=250)):
    return await browser.browser_library(kind, session_id=session, query=query.strip(), max_results=limit)


@router.post("/cleanup")
async def cleanup_agent_tabs(payload: dict, session: str | None = None):
    keep = payload.get("keepTargetIds", [])
    if not isinstance(keep, list) or not all(isinstance(item, str) and item for item in keep):
        raise HTTPException(400, "Invalid tabs to keep.")
    return await browser.clear_agent_tabs(session_id=session, keep_target_ids=keep)


@router.get("/tabs/{target_id}/stream.mjpeg")
async def browser_preview_stream(request: Request, target_id: str,
                                 session: str | None = None,
                                 show_all: bool = Query(False, alias="all"),
                                 fps: float = Query(2, ge=.5, le=3)):
    await browser.find_tab(target_id, session_id=session, show_all=show_all)
    boundary = "aside-browser-frame"

    async def frames() -> AsyncIterator[bytes]:
        interval = 1 / fps
        while not await request.is_disconnected():
            started = asyncio.get_running_loop().time()
            try:
                path, _ = await browser.screenshot(
                    target_id, quality=68, max_age=0,
                    session_id=session, show_all=show_all,
                )
                frame = path.read_bytes()
                yield (
                    f"--{boundary}\r\nContent-Type: image/jpeg\r\n"
                    f"Content-Length: {len(frame)}\r\n\r\n"
                ).encode() + frame + b"\r\n"
            except (browser.TabNotFound, browser.TabAsleep):
                return
            except (browser.TooBusy, ConnectionError, OSError, TimeoutError):
                pass
            elapsed = asyncio.get_running_loop().time() - started
            await asyncio.sleep(max(.05, interval - elapsed))

    return StreamingResponse(
        frames(), media_type=f"multipart/x-mixed-replace; boundary={boundary}",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


def _is_unit_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1


def _is_web_url(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 8_192:
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
