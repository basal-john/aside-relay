"""Aside's native queued-message adapter.

Native queue entries live in the daemon session record. Mutations identify an
entry with the complete user-message object, not with its timestamp alone.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections.abc import Callable

from daemon import ACCOUNT_ID, daemon
import runner

QueueItem = dict[str, object]
PromptForItem = Callable[[QueueItem], str]
_NATIVE_ID_NAMESPACE = uuid.UUID("5891289b-e530-47fe-923e-526425181aae")
_POLL_DELAYS = (0.05, 0.1, 0.2, 0.35, 0.5)


class NativeQueueError(Exception):
    pass


class NativeQueueRestoreError(NativeQueueError):
    queue_removed = True


class NativeQueueSteerError(NativeQueueError):
    pass


class NativeQueue:
    def __init__(self, prompt_for_item: PromptForItem) -> None:
        self.prompt_for_item = prompt_for_item

    def prompt(self, item: QueueItem) -> str:
        return self.prompt_for_item(item).strip()

    async def list(self, session_id: str) -> list[QueueItem]:
        session = await _call("sessions.get", {
            "accountId": ACCOUNT_ID,
            "sessionId": session_id,
        })
        raw = session.get("queuedMessages") if isinstance(session, dict) else None
        return _queued_items(session_id, raw if isinstance(raw, list) else [])

    async def enqueue(self, session_id: str, item: QueueItem) -> QueueItem | None:
        prompt = self.prompt(item)
        if not prompt:
            raise NativeQueueError("Queued message is empty")
        return await self._enqueue_prompt(session_id, prompt)

    async def _enqueue_prompt(self, session_id: str, prompt: str) -> QueueItem | None:
        before = {_native_key(value) for value in await self.list(session_id)}
        if not await runner.queue(session_id, prompt):
            raise NativeQueueError("Aside did not accept the queued message")
        for delay in _POLL_DELAYS:
            await asyncio.sleep(delay)
            values = await self.list(session_id)
            added = [value for value in values if _native_key(value) not in before]
            if added:
                return added[-1]
        return None

    async def update(self, session_id: str, item: QueueItem, update: QueueItem) -> QueueItem:
        native = _native_reference(item)
        text = self.prompt(update)
        if not text:
            raise NativeQueueError("Queued message is empty")
        await _call("sessions.updateQueuedMessage", {
            "accountId": ACCOUNT_ID,
            "sessionId": session_id,
            "message": native["message"],
            "text": text,
        }, mutation=True)
        return await self._find(session_id, str(native["key"]))

    async def delete(self, session_id: str, item: QueueItem) -> None:
        native = _native_reference(item)
        await _call("sessions.removeQueuedMessage", {
            "accountId": ACCOUNT_ID,
            "sessionId": session_id,
            "message": native["message"],
        }, mutation=True)

    async def contains(self, session_id: str, item: QueueItem) -> bool:
        key = _native_key(item)
        return any(_native_key(value) == key for value in await self.list(session_id))

    async def steer(self, session_id: str, item: QueueItem) -> bool:
        native = _native_reference(item)
        prompt = _message_text(native["message"]).strip()
        if (not prompt or native.get("metadata") is not None
                or not _is_plain_text_message(native["message"])):
            raise NativeQueueSteerError(
                "This native queued message cannot be steered as plain text"
            )
        await self.delete(session_id, item)
        if await runner.steer(session_id, prompt):
            return True
        try:
            restored = await self._enqueue_prompt(session_id, prompt)
        except Exception as error:
            raise NativeQueueRestoreError(
                "Steering failed; the message is retained for manual retry"
            ) from error
        if restored is None:
            return True
        item["native"] = restored["native"]
        item["nativePrompt"] = restored["prompt"]
        raise NativeQueueSteerError("Aside did not accept the steering message")

    async def move(self, session_id: str, item: QueueItem,
                   before: QueueItem | None) -> list[QueueItem]:
        native = _native_reference(item)
        before_native = _native_reference(before) if before is not None else None
        await _call("sessions.moveQueuedMessage", {
            "accountId": ACCOUNT_ID,
            "sessionId": session_id,
            "message": native["message"],
            "beforeTimestamp": before_native["message"].get("timestamp")
            if before_native is not None else None,
        }, mutation=True)
        return await self.list(session_id)

    async def _find(self, session_id: str, key: str) -> QueueItem:
        for delay in (0, *_POLL_DELAYS):
            if delay:
                await asyncio.sleep(delay)
            for item in await self.list(session_id):
                if _native_key(item) == key:
                    return item
        raise NativeQueueError("Aside no longer contains the queued message")


def _queued_items(session_id: str, messages: list[object]) -> list[QueueItem]:
    items: list[QueueItem] = []
    metadata: dict | None = None
    for value in messages:
        if not isinstance(value, dict):
            metadata = None
            continue
        if value.get("role") == "user-message-metadata":
            metadata = value
            continue
        if value.get("role") != "user":
            metadata = None
            continue
        key = _message_key(session_id, value)
        items.append({
            "id": str(uuid.uuid5(_NATIVE_ID_NAMESPACE, key)),
            "prompt": _message_text(value),
            "attachments": [],
            "status": "queued",
            "native": {"key": key, "message": value, "metadata": metadata},
        })
        metadata = None
    return items


def _message_key(session_id: str, message: dict) -> str:
    timestamp = message.get("timestamp")
    if isinstance(timestamp, (int, float, str)):
        identity = str(timestamp)
    else:
        encoded = json.dumps(message, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        identity = hashlib.sha256(encoded.encode()).hexdigest()
    return f"{ACCOUNT_ID}:{session_id}:queued:{identity}"


def _native_key(item: QueueItem) -> str:
    return str(_native_reference(item)["key"])


def _native_reference(item: QueueItem | None) -> dict:
    native = item.get("native") if isinstance(item, dict) else None
    if (not isinstance(native, dict) or not isinstance(native.get("key"), str)
            or not isinstance(native.get("message"), dict)):
        raise NativeQueueError("Queued message is not linked to Aside")
    return native


def _message_text(message: object) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def _is_plain_text_message(message: dict) -> bool:
    content = message.get("content")
    return isinstance(content, str) or (
        isinstance(content, list)
        and all(isinstance(block, dict) and block.get("type") == "text" for block in content)
    )


async def _call(procedure: str, value: dict, *, mutation: bool = False):
    try:
        return await daemon.call(procedure, value, mutation=mutation)
    except NativeQueueError:
        raise
    except Exception as error:
        raise NativeQueueError("Aside could not update its queued messages") from error
