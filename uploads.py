"""첨부 파일 저장/조회.

핵심 제약(실측):
  · `aside exec` 에는 첨부 옵션이 없다. 이미지를 프롬프트에 실어 보낼 방법이 없다.
  · repl 의 fs 는 "Project and session roots" 밖을 거부한다.
    ~/aside-remote/cache 에 두면 에이전트가 못 읽는다.
  · 반면 Aside 유저 루트(~/.aside/u/0) 안은 읽힌다. 세션 디렉토리가 생기기 전에도 쓸 수 있어
    새 대화의 경쟁 상태도 없다.
→ 그래서 업로드는 ~/.aside/u/0/uploads/ 에 두고, 프롬프트에 그 경로를 적어
  에이전트가 fs.readFile + display() 로 직접 보게 한다.
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import time
import zipfile
from pathlib import Path

import config

log = logging.getLogger("aside-remote.uploads")

# 매직 바이트로 판별한다. 확장자나 클라이언트가 보낸 content-type 을 믿지 않는다.
_MAGIC = [
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
    (b"GIF8", "image/gif", "gif"),
    (b"RIFF", "image/webp", "webp"),
    (b"%PDF-", "application/pdf", "pdf"),
    (b"\x1aE\xdf\xa3", "video/webm", "webm"),
]

_TEXT_EXTENSIONS = {
    "c", "cc", "conf", "cpp", "css", "csv", "go", "h", "hpp", "html", "ini",
    "java", "js", "json", "jsx", "kt", "log", "md", "mjs", "py", "rb", "rs",
    "sh", "sql", "svg", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
}
_TEXT_MIME = {
    "csv": "text/csv", "css": "text/css", "html": "text/html", "js": "text/javascript",
    "json": "application/json", "jsx": "text/javascript", "md": "text/markdown", "mjs": "text/javascript",
    "py": "text/x-python", "sh": "text/x-shellscript", "svg": "image/svg+xml", "ts": "text/typescript",
    "tsx": "text/typescript", "xml": "application/xml", "yaml": "application/yaml", "yml": "application/yaml",
}
_OFFICE_KINDS = {
    "word/": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    "xl/": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
    "ppt/": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
}


def sniff(raw: bytes, name: str | None = None) -> tuple[str, str] | None:
    for magic, mime, ext in _MAGIC:
        if raw.startswith(magic):
            if ext == "webp" and raw[8:12] != b"WEBP":
                continue
            return mime, ext
    if len(raw) >= 12 and raw[4:8] == b"ftyp":
        brand = raw[8:12]
        return ("video/quicktime", "mov") if brand == b"qt  " else ("video/mp4", "mp4")
    if raw.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                names = archive.namelist()
                if "[Content_Types].xml" not in names:
                    return None
                for prefix, kind in _OFFICE_KINDS.items():
                    if any(item.startswith(prefix) for item in names):
                        return kind
        except (OSError, zipfile.BadZipFile):
            return None
    extension = Path(name or "").suffix.lower().lstrip(".")
    if extension not in _TEXT_EXTENSIONS or b"\x00" in raw:
        return None
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return _TEXT_MIME.get(extension, "text/plain"), extension


def save(raw: bytes, name: str | None = None) -> dict:
    if not raw or len(raw) > config.UPLOAD_MAX_BYTES:
        raise ValueError("File is empty or exceeds the upload size limit")
    kind = sniff(raw, name)
    if not kind:
        raise ValueError("Choose an image, PDF, video, Office document, or UTF-8 text/code file")
    mime, ext = kind
    digest = hashlib.sha256(raw).hexdigest()[:16]
    fid = f"{digest}.{ext}"
    if not _safe_upload_root():
        raise ValueError("Upload storage is unavailable")
    path = config.UPLOAD_DIR / fid
    if path.is_symlink():
        raise ValueError("Upload path is unsafe")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError:
        existing = path_of(fid)
        try:
            is_same_file = existing is not None and existing.stat().st_size == len(raw) and existing.read_bytes() == raw
        except OSError:
            is_same_file = False
        if not is_same_file:
            raise ValueError("Upload path is unsafe")
    except OSError as error:
        raise ValueError("Upload path is unsafe") from error
    else:
        with os.fdopen(descriptor, "wb") as file:
            file.write(raw)
    return {
        "id": fid,
        "path": str(path),        # 에이전트가 읽을 절대경로
        "name": _safe_name(name) or fid,
        "mime": mime,
        "bytes": len(raw),
        "url": f"/api/upload/{fid}",
    }


def path_of(fid: str) -> Path | None:
    if "/" in fid or "\\" in fid or ".." in fid:
        return None
    if not _safe_upload_root():
        return None
    base = config.UPLOAD_DIR
    candidate = base / fid
    if base.is_symlink() or candidate.is_symlink():
        return None
    p = candidate.resolve()
    try:
        p.relative_to(base.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def _safe_upload_root() -> bool:
    root = config.UPLOAD_DIR
    if root.is_symlink():
        return False
    try:
        return root.resolve(strict=True).is_dir()
    except OSError:
        return False


def metadata(fid: str, name: str | None = None) -> dict | None:
    path = path_of(fid)
    if path is None:
        return None
    try:
        if path.stat().st_size > config.UPLOAD_MAX_BYTES:
            return None
        raw = path.read_bytes()
        clean_name = _safe_name(name)
        kind = sniff(raw, clean_name or path.name)
    except OSError:
        return None
    if kind is None:
        return None
    mime, _extension = kind
    return {
        "id": fid,
        "name": clean_name or path.name,
        "mime": mime,
        "bytes": len(raw),
        "url": f"/api/upload/{fid}",
    }


# 프롬프트 앞에 붙는 첨부 블록. 사람이 읽어도 자연스럽고, UI 가 파싱하기도 쉽게.
MARK = "[첨부 파일]"


def prompt_prefix(atts: list[dict]) -> str:
    if not atts:
        return ""
    lines = [MARK]
    for a in atts:
        lines.append(f"- {a['name']} → {a['path']}")
    lines.append("위 파일을 필요한 도구로 먼저 확인한 뒤 답해줘.")
    lines.append("")
    return "\n".join(lines)


def _safe_name(name: str | None) -> str:
    if not isinstance(name, str) or not name:
        return ""
    normalized = name.replace("\\", "/")
    parts = [part.strip() for part in normalized.split("/") if part.strip() not in ("", ".", "..")]
    clean = "/".join("".join(character for character in part if character >= " " and character != "\x7f") for part in parts)
    return clean[:120]


def sweep(max_age_days: int = 30) -> int:
    """오래된 업로드 정리. 세션 로그에 경로가 남아 있으므로 너무 짧게 잡지 않는다."""
    cutoff = time.time() - max_age_days * 86400
    n = 0
    for f in config.UPLOAD_DIR.glob("*"):
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink(); n += 1
        except OSError:
            pass
    return n
