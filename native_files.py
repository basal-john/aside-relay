"""Authenticated, root-scoped file and artifact routes for the remote UI."""
from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse

import config
import sessions
from daemon import ACCOUNT_ID, daemon

router = APIRouter(prefix="/api/native/files", tags=["files"])

_MAX_ITEMS = 500
_MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
_OUTPUT_DIRECTORIES = ("artifacts", "output")
_BLOCKED_NAMES = {
    ".env", ".git", ".idea", ".vscode", "cache", "node_modules", "__pycache__",
}
_BLOCKED_SUFFIXES = {".key", ".pem", ".p12", ".pfx"}
_TEXT_SUFFIXES = {
    ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp",
    ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".log", ".md",
    ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".svg", ".toml", ".ts",
    ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
_MIME_BY_SUFFIX = {
    ".csv": "text/csv", ".css": "text/css", ".html": "text/html", ".js": "text/javascript",
    ".json": "application/json", ".jsx": "text/javascript", ".md": "text/markdown", ".mjs": "text/javascript",
    ".py": "text/x-python", ".sh": "text/x-shellscript", ".svg": "image/svg+xml", ".ts": "text/typescript",
    ".tsx": "text/typescript", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
}


@router.get("/roots")
async def roots(session: str | None = None):
    items = [{"id": "uploads", "name": "Uploads", "path": str(config.UPLOAD_DIR)}]
    workspace = await _workspace_root(session)
    if workspace:
        items.insert(0, {"id": "project", "name": f"Project · {workspace.name}", "path": str(workspace)})
    directory = sessions.session_dir(session) if session else None
    if directory:
        items.append({"id": "session", "name": "Conversation files", "path": str(directory)})
    return {"items": items}


@router.get("/browse")
async def browse(root: str, path: str = "", session: str | None = None):
    base = await _root(root, session)
    directory = _inside(base, path)
    if not directory.is_dir():
        raise HTTPException(404, "Folder not found.")
    items = []
    try:
        children = sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold()))
    except OSError as error:
        raise HTTPException(403, "Folder cannot be read.") from error
    for child in children:
        if len(items) >= _MAX_ITEMS:
            break
        if not _is_visible(child) or child.is_symlink() or not (child.is_dir() or child.is_file()):
            continue
        try:
            stat = child.stat()
        except OSError:
            continue
        relative = child.relative_to(base).as_posix()
        items.append({
            "name": child.name,
            "path": relative,
            "absolutePath": str(child),
            "kind": "folder" if child.is_dir() else "file",
            "bytes": stat.st_size if child.is_file() else None,
            "mime": _mime(child) if child.is_file() else None,
        })
    return {"root": root, "path": _relative(directory, base), "items": items}


@router.get("/sessions/{session_id}/artifacts")
async def artifacts(session_id: str):
    items = []
    for name in _OUTPUT_DIRECTORIES:
        base = _output_root(session_id, name)
        if not base.exists():
            continue
        for path in sorted(base.rglob("*"), key=lambda item: item.as_posix().casefold()):
            if len(items) >= _MAX_ITEMS:
                break
            if not _safe_output_file(base, path):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            relative = f"{name}/{path.relative_to(base).as_posix()}"
            mime = _mime(path)
            items.append({
                "name": path.name,
                "path": relative,
                "absolutePath": str(path),
                "bytes": stat.st_size,
                "mtime": int(stat.st_mtime * 1000),
                "mime": mime,
                "kind": _kind(path, mime),
            })
    return {"items": items}


@router.get("/sessions/{session_id}/artifacts/{path:path}")
async def artifact_content(session_id: str, path: str, download: bool = False):
    file = _artifact_file(session_id, path)
    mime = _mime(file)
    if file.suffix.lower() == ".svg":
        download = True
    headers = {"X-Content-Type-Options": "nosniff"}
    if mime == "text/html":
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    return FileResponse(
        file,
        media_type=mime,
        filename=file.name if download else None,
        content_disposition_type="attachment" if download else "inline",
        headers=headers,
    )


@router.get("/sessions/{session_id}/artifact-preview")
async def artifact_preview(session_id: str, path: str, max_bytes: int = Query(_MAX_TEXT_PREVIEW_BYTES, ge=1, le=_MAX_TEXT_PREVIEW_BYTES)):
    file = _artifact_file(session_id, path)
    if file.suffix.lower() not in _TEXT_SUFFIXES:
        raise HTTPException(415, "This file cannot be previewed as text.")
    if file.stat().st_size > max_bytes:
        raise HTTPException(413, "File is too large to preview.")
    try:
        content = file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise HTTPException(415, "This file is not UTF-8 text.") from error
    return JSONResponse({"path": path, "content": content, "mime": _mime(file)})


@router.patch("/sessions/{session_id}/artifacts/{path:path}")
async def rename_artifact(session_id: str, path: str, request: Request):
    file = _artifact_file(session_id, path)
    try:
        payload = await request.json()
    except ValueError as error:
        raise HTTPException(400, "Invalid request.") from error
    name = payload.get("name") if isinstance(payload, dict) else None
    if not isinstance(name, str) or not _valid_name(name):
        raise HTTPException(400, "Enter a valid file name.")
    session_root = _session_root(session_id)
    target = _inside(session_root, (file.parent / name).relative_to(session_root).as_posix())
    if target.exists():
        raise HTTPException(409, "A file with this name already exists.")
    try:
        file.rename(target)
    except OSError as error:
        raise HTTPException(409, "File could not be renamed.") from error
    return {"path": target.relative_to(session_root).as_posix(), "name": target.name}


@router.delete("/sessions/{session_id}/artifacts/{path:path}")
async def delete_artifact(session_id: str, path: str):
    file = _artifact_file(session_id, path)
    try:
        file.unlink()
    except OSError as error:
        raise HTTPException(409, "File could not be deleted.") from error
    return {"deleted": True, "path": path}


async def _root(name: str, session_id: str | None) -> Path:
    if name == "project":
        workspace = await _workspace_root(session_id)
        if workspace:
            return workspace
    if name == "uploads":
        if config.UPLOAD_DIR.is_symlink():
            raise HTTPException(404, "File root not found.")
        return config.UPLOAD_DIR.resolve()
    if name == "session" and session_id:
        return _session_root(session_id)
    raise HTTPException(404, "File root not found.")


async def _workspace_root(session_id: str | None) -> Path | None:
    if not session_id or sessions.session_dir(session_id) is None:
        return None
    try:
        value = await daemon.call("sessions.get", {"accountId": ACCOUNT_ID, "sessionId": session_id})
    except Exception:
        return None
    cwd = value.get("cwd") if isinstance(value, dict) else None
    if not isinstance(cwd, str) or not cwd or not os.path.isabs(cwd):
        return None
    try:
        root = Path(cwd).resolve(strict=True)
    except OSError:
        return None
    if not root.is_dir() or root == Path(root.anchor) or root == Path.home().resolve() or not _is_visible(root):
        return None
    return root


def _session_root(session_id: str) -> Path:
    directory = sessions.session_dir(session_id)
    if not directory:
        raise HTTPException(404, "Conversation not found.")
    if directory.is_symlink():
        raise HTTPException(404, "Conversation files not found.")
    try:
        root = directory.resolve()
        root.relative_to(config.SESSIONS_DIR.resolve())
    except (OSError, ValueError) as error:
        raise HTTPException(404, "Conversation files not found.") from error
    return root


def _output_root(session_id: str, name: str) -> Path:
    if name not in _OUTPUT_DIRECTORIES:
        raise HTTPException(404, "Files folder not found.")
    session_root = _session_root(session_id)
    candidate = session_root / name
    if candidate.is_symlink():
        raise HTTPException(404, "Files folder not found.")
    try:
        root = candidate.resolve()
        root.relative_to(session_root)
    except (OSError, ValueError) as error:
        raise HTTPException(404, "Files folder not found.") from error
    return root


def _artifact_file(session_id: str, path: str) -> Path:
    normalized = path.replace("\\", "/").split("/")
    if len(normalized) < 2 or normalized[0] not in _OUTPUT_DIRECTORIES:
        raise HTTPException(404, "File not found.")
    base = _output_root(session_id, normalized[0])
    file = _inside(base, "/".join(normalized[1:]))
    if not file.is_file() or file.is_symlink() or not _is_visible(file):
        raise HTTPException(404, "File not found.")
    return file


def _inside(base: Path, relative: str) -> Path:
    if os.path.isabs(relative) or "\\" in relative:
        raise HTTPException(400, "Invalid path.")
    try:
        target = (base / relative).resolve()
        target.relative_to(base.resolve())
    except (OSError, ValueError):
        raise HTTPException(400, "Invalid path.")
    if any(not _is_visible(Path(part)) for part in Path(relative).parts):
        raise HTTPException(404, "Path not found.")
    current = base
    for part in Path(relative).parts:
        current /= part
        if current.is_symlink():
            raise HTTPException(404, "Path not found.")
    return target


def _safe_output_file(base: Path, path: Path) -> bool:
    try:
        relative = path.relative_to(base)
    except ValueError:
        return False
    if not path.is_file() or any(not _is_visible(Path(part)) for part in relative.parts):
        return False
    current = base
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            return False
    return True


def _relative(path: Path, base: Path) -> str:
    relative = path.relative_to(base).as_posix()
    return "" if relative == "." else relative


def _valid_name(name: str) -> bool:
    return name == name.strip() and name not in ("", ".", "..") and "/" not in name and "\\" not in name and _is_visible(Path(name))


def _is_visible(path: Path) -> bool:
    name = path.name
    return bool(name) and not name.startswith(".") and name not in _BLOCKED_NAMES and path.suffix.lower() not in _BLOCKED_SUFFIXES


def _mime(path: Path) -> str:
    return _MIME_BY_SUFFIX.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _kind(path: Path, mime: str) -> str:
    if path.suffix.lower() == ".csv":
        return "csv"
    if path.suffix.lower() == ".svg":
        return "text"
    if mime.startswith("image/"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    if mime == "text/html":
        return "html"
    if path.suffix.lower() in _TEXT_SUFFIXES:
        return "text"
    return "binary"
