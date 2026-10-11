"""Persistent, editable follow-up messages for Aside sessions."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable

if TYPE_CHECKING:
    from native_queue import NativeQueue

log = logging.getLogger("aside-relay.followups")
EDIT_LEASE_SEC = 300
RECEIPT_LIMIT = 256

QueueItem = dict[str, object]
IsRunning = Callable[[str], Awaitable[bool]]
StartPrompt = Callable[[str, QueueItem], Awaitable[bool]]
QueueChanged = Callable[[str, dict], Awaitable[None]]


class ItemNotFound(Exception):
    pass


class ItemSending(Exception):
    pass


class EmptyItem(Exception):
    pass


class RetryLater(Exception):
    pass


class FollowupQueue:
    def __init__(self, path: Path, is_running: IsRunning, start_prompt: StartPrompt,
                 queue_changed: QueueChanged, native_queue: NativeQueue | None = None) -> None:
        self.path = path
        self.is_running = is_running
        self.start_prompt = start_prompt
        self.queue_changed = queue_changed
        self.native_queue = native_queue
        self._sessions: dict[str, dict] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._drain_tasks: dict[str, asyncio.Task] = {}
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text())
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError):
            log.exception("follow-up queue load failed path=%s", self.path)
            return
        sessions = raw.get("sessions") if isinstance(raw, dict) else None
        if not isinstance(sessions, dict):
            return
        changed = False
        for session_id, state in sessions.items():
            if not isinstance(session_id, str) or not isinstance(state, dict):
                continue
            items = state.get("items")
            if not isinstance(items, list):
                continue
            clean_items = []
            for item in items:
                if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                    continue
                status = item.get("status")
                if status not in ("queued", "sending", "error"):
                    continue
                clean = {
                    "id": item["id"],
                    "prompt": item.get("prompt") if isinstance(item.get("prompt"), str) else "",
                    "attachments": item.get("attachments") if isinstance(item.get("attachments"), list) else [],
                    "status": status,
                }
                held_until = item.get("heldUntil")
                if isinstance(held_until, (int, float)) and held_until > time.time():
                    clean["heldUntil"] = held_until
                if isinstance(item.get("acceptanceSeq"), int):
                    clean["acceptanceSeq"] = item["acceptanceSeq"]
                if isinstance(item.get("acceptanceText"), str):
                    clean["acceptanceText"] = item["acceptanceText"]
                if isinstance(item.get("nativePrompt"), str):
                    clean["nativePrompt"] = item["nativePrompt"]
                native = item.get("native")
                if (isinstance(native, dict) and isinstance(native.get("key"), str)
                        and isinstance(native.get("message"), dict)):
                    clean["native"] = native
                if status == "sending":
                    clean["status"] = "error"
                    clean["error"] = "Delivery was interrupted. Review the message and resume the queue."
                    changed = True
                elif isinstance(item.get("error"), str):
                    clean["error"] = item["error"]
                clean_items.append(clean)
            completed_ids = state.get("completedIds")
            clean_completed_ids = [item_id for item_id in completed_ids
                                   if isinstance(item_id, str)][-RECEIPT_LIMIT:] if isinstance(completed_ids, list) else []
            if clean_items or clean_completed_ids:
                self._sessions[session_id] = {
                    "items": clean_items,
                    "paused": bool(state.get("paused")) or any(
                        item["status"] == "error" for item in clean_items
                    ),
                    "completedIds": clean_completed_ids,
                }
        if changed:
            self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(json.dumps({"version": 1, "sessions": self._sessions}, ensure_ascii=False))
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)

    def _state(self, session_id: str) -> dict:
        return self._sessions.setdefault(
            session_id, {"items": [], "paused": False, "completedIds": []}
        )

    def _lock(self, session_id: str) -> asyncio.Lock:
        return self._locks.setdefault(session_id, asyncio.Lock())

    def _public(self, session_id: str) -> dict:
        state = self._sessions.get(session_id, {"items": [], "paused": False})
        return {
            "items": [self._public_item(item) for item in state["items"]],
            "isPaused": bool(state["paused"]),
        }

    @staticmethod
    def _public_item(item: QueueItem) -> dict:
        public = {key: value for key, value in item.items()
                  if key not in ("heldUntil", "acceptanceSeq", "acceptanceText",
                                 "native", "nativePrompt")}
        public["isEditing"] = bool(
            isinstance(item.get("heldUntil"), (int, float))
            and item["heldUntil"] > time.time()
        )
        return public

    async def get(self, session_id: str) -> dict:
        await self._sync_native(session_id)
        async with self._lock(session_id):
            return self._public(session_id)

    async def enqueue(self, session_id: str, item: QueueItem) -> dict:
        if self.native_queue is not None and await self.is_running(session_id):
            return await self._enqueue_native(session_id, item)
        async with self._lock(session_id):
            state = self._state(session_id)
            is_known = item["id"] in state["completedIds"] or any(
                existing["id"] == item["id"] for existing in state["items"]
            )
            if not is_known:
                state["items"].append({**item, "status": "queued"})
                self._save()
            result = self._public(session_id)
        await self.queue_changed(session_id, result)
        self._wake.set()
        return result

    async def edit(self, session_id: str, item_id: str, update: QueueItem | None,
                   is_editing: bool) -> dict:
        async with self._lock(session_id):
            item = self._find(session_id, item_id)
            if item["status"] == "sending":
                raise ItemSending
            original = dict(item)
            if update is not None:
                prompt = update.get("prompt", item["prompt"])
                attachments = update.get("attachments", item["attachments"])
                if not prompt and not attachments:
                    raise EmptyItem
                if prompt != item["prompt"] or attachments != item["attachments"]:
                    item.pop("acceptanceSeq", None)
                    item.pop("acceptanceText", None)
                item.update(prompt=prompt, attachments=attachments, status="queued")
                item.pop("error", None)
            if is_editing:
                item["heldUntil"] = time.time() + EDIT_LEASE_SEC
            else:
                item.pop("heldUntil", None)
            self._save()
            result = self._public(session_id)
        await self.queue_changed(session_id, result)
        if update is not None and self.native_queue is not None and "native" in original:
            try:
                native = await self.native_queue.update(session_id, original, item)
            except Exception:
                if not await self._native_contains(session_id, original):
                    async with self._lock(session_id):
                        state = self._state(session_id)
                        try:
                            current = self._find(session_id, item_id)
                        except ItemNotFound:
                            return self._public(session_id)
                        state["items"].remove(current)
                        self._remember_completed(state, item_id)
                        self._drop_empty(session_id)
                        self._save()
                        result = self._public(session_id)
                    await self.queue_changed(session_id, result)
                    return result
                async with self._lock(session_id):
                    current = self._find(session_id, item_id)
                    current.clear()
                    current.update(original)
                    self._save()
                    result = self._public(session_id)
                await self.queue_changed(session_id, result)
                raise
            async with self._lock(session_id):
                current = self._find(session_id, item_id)
                current["native"] = native["native"]
                current["nativePrompt"] = native["prompt"]
                self._save()
        self._wake.set()
        return result

    async def delete(self, session_id: str, item_id: str) -> dict:
        async with self._lock(session_id):
            item = self._find(session_id, item_id)
            if item["status"] == "sending":
                raise ItemSending
            state = self._state(session_id)
            index = state["items"].index(item)
            state["items"].remove(item)
            self._remember_completed(state, item_id)
            self._drop_empty(session_id)
            self._save()
            result = self._public(session_id)
        await self.queue_changed(session_id, result)
        if self.native_queue is not None and "native" in item:
            try:
                await self.native_queue.delete(session_id, item)
            except Exception:
                if not await self._native_contains(session_id, item):
                    return result
                async with self._lock(session_id):
                    state = self._state(session_id)
                    state["items"].insert(min(index, len(state["items"])), item)
                    state["completedIds"] = [value for value in state["completedIds"]
                                             if value != item_id]
                    self._save()
                    result = self._public(session_id)
                await self.queue_changed(session_id, result)
                raise
        return result

    async def steer(self, session_id: str, item_id: str,
                    deliver: StartPrompt) -> dict:
        async with self._lock(session_id):
            state = self._state(session_id)
            if item_id in state["completedIds"]:
                return self._public(session_id)
            item = self._find(session_id, item_id)
            if item["status"] == "sending":
                raise ItemSending
            item["status"] = "sending"
            item.pop("heldUntil", None)
            item.pop("error", None)
            self._save()
            sending = self._public(session_id)
            delivery_item = dict(item)
        await self.queue_changed(session_id, sending)
        native_queue = self.native_queue
        is_native_delivery = native_queue is not None and "native" in delivery_item
        delivery_error: Exception | None = None
        try:
            if native_queue is not None and "native" in delivery_item:
                is_delivered = await native_queue.steer(session_id, delivery_item)
            else:
                is_delivered = await deliver(session_id, delivery_item)
        except Exception as error:
            delivery_error = error
            is_delivered = False
            was_removed = getattr(error, "queue_removed", False)
            log.exception("follow-up steering failed session=%s item=%s", session_id, item_id)
        else:
            was_removed = False
        async with self._lock(session_id):
            state = self._state(session_id)
            try:
                item = self._find(session_id, item_id)
            except ItemNotFound:
                if delivery_error is not None and is_native_delivery:
                    raise delivery_error
                return self._public(session_id)
            is_native = "native" in item
            if is_delivered:
                state["items"].remove(item)
                self._remember_completed(state, item_id)
                self._drop_empty(session_id)
            elif was_removed:
                item.pop("native", None)
                item.pop("nativePrompt", None)
                item["status"] = "error"
                item["error"] = "The message is saved here. Resume the queue to retry it."
                state["paused"] = True
            elif is_native:
                if isinstance(delivery_item.get("native"), dict):
                    item["native"] = delivery_item["native"]
                if isinstance(delivery_item.get("nativePrompt"), str):
                    item["nativePrompt"] = delivery_item["nativePrompt"]
                item["status"] = "queued"
                item.pop("error", None)
            else:
                item["status"] = "error"
                item["error"] = "The message could not be delivered. Review it and resume the queue."
                self._state(session_id)["paused"] = True
            self._save()
            result = self._public(session_id)
        await self.queue_changed(session_id, result)
        if delivery_error is not None and is_native_delivery:
            raise delivery_error
        return result

    async def pause(self, session_id: str) -> None:
        async with self._lock(session_id):
            state = self._sessions.get(session_id)
            if state and state["items"]:
                state["paused"] = True
                self._save()
                result = self._public(session_id)
            else:
                result = None
        if result:
            await self.queue_changed(session_id, result)

    async def resume(self, session_id: str) -> dict:
        async with self._lock(session_id):
            state = self._state(session_id)
            state["paused"] = False
            for item in state["items"]:
                if item["status"] == "error":
                    item["status"] = "queued"
                    item.pop("error", None)
            self._drop_empty(session_id)
            self._save()
            result = self._public(session_id)
        await self.queue_changed(session_id, result)
        self._wake.set()
        return result

    async def clear(self, session_id: str) -> None:
        async with self._lock(session_id):
            if self._sessions.pop(session_id, None) is not None:
                self._save()
                should_notify = True
            else:
                should_notify = False
        if should_notify:
            await self.queue_changed(session_id, {"items": [], "isPaused": False})

    async def set_acceptance(self, session_id: str, item_id: str,
                             next_seq: int, expected_text: str) -> None:
        async with self._lock(session_id):
            item = self._find(session_id, item_id)
            item["acceptanceSeq"] = next_seq
            item["acceptanceText"] = expected_text
            self._save()

    @asynccontextmanager
    async def launch(self, session_id: str, *, allow_paused: bool = False):
        async with self._lock(session_id):
            state = self._sessions.get(session_id)
            if not allow_paused and state and state["paused"]:
                raise RetryLater
            yield

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._drain_loop())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        tasks = list(self._drain_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._drain_tasks.clear()

    async def _drain_loop(self) -> None:
        while True:
            self._wake.clear()
            pending_session_ids = [session_id for session_id, state in self._sessions.items()
                                   if state["items"]]
            for session_id in pending_session_ids:
                task = self._drain_tasks.get(session_id)
                if task is None or task.done():
                    self._drain_tasks[session_id] = asyncio.create_task(
                        self._drain_safely(session_id)
                    )
            self._drain_tasks = {
                session_id: task for session_id, task in self._drain_tasks.items()
                if not task.done()
            }
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=0.5)
            except TimeoutError:
                pass

    async def _drain_safely(self, session_id: str) -> None:
        try:
            await self._drain_one(session_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("follow-up queue check failed session=%s", session_id)

    async def _enqueue_native(self, session_id: str, item: QueueItem) -> dict:
        async with self._lock(session_id):
            state = self._state(session_id)
            if item["id"] in state["completedIds"]:
                return self._public(session_id)
            existing = next((value for value in state["items"]
                             if value["id"] == item["id"]), None)
            if existing is not None:
                return self._public(session_id)
            pending = {**item, "status": "sending",
                       "nativePrompt": self.native_queue.prompt(item)}
            state["items"].append(pending)
            self._save()
            sending = self._public(session_id)
        await self.queue_changed(session_id, sending)
        try:
            native = await self.native_queue.enqueue(session_id, pending)
        except Exception:
            async with self._lock(session_id):
                pending = self._find(session_id, str(item["id"]))
                pending["status"] = "error"
                pending["error"] = "The message could not be queued in Aside."
                self._state(session_id)["paused"] = True
                self._save()
                result = self._public(session_id)
            await self.queue_changed(session_id, result)
            raise
        async with self._lock(session_id):
            state = self._state(session_id)
            try:
                pending = self._find(session_id, str(item["id"]))
            except ItemNotFound:
                return self._public(session_id)
            if native is None:
                state["items"].remove(pending)
                self._remember_completed(state, str(item["id"]))
                self._drop_empty(session_id)
            else:
                pending["status"] = "queued"
                pending["native"] = native["native"]
                pending["nativePrompt"] = native["prompt"]
            self._save()
            result = self._public(session_id)
        await self.queue_changed(session_id, result)
        return result

    async def _sync_native(self, session_id: str) -> None:
        if self.native_queue is None:
            return
        try:
            native_items = await self.native_queue.list(session_id)
        except Exception:
            log.warning("native queue refresh failed session=%s", session_id, exc_info=True)
            return
        async with self._lock(session_id):
            state = self._state(session_id)
            native_by_key = {
                item["native"]["key"]: item for item in native_items
                if isinstance(item.get("native"), dict)
            }
            changed = False
            for item in list(state["items"]):
                native = item.get("native")
                if not isinstance(native, dict):
                    continue
                key = native.get("key")
                current = native_by_key.pop(key, None)
                if current is None:
                    state["items"].remove(item)
                    self._remember_completed(state, str(item["id"]))
                    changed = True
                    continue
                expected_prompt = item.get("nativePrompt")
                if (expected_prompt != current["prompt"] or native != current["native"]
                        or item.get("status") != "queued" or "error" in item):
                    if not isinstance(expected_prompt, str):
                        item["prompt"] = current["prompt"]
                    item["nativePrompt"] = current["prompt"]
                    item["native"] = current["native"]
                    item["status"] = "queued"
                    item.pop("error", None)
                    changed = True
            unbound = [item for item in state["items"] if "native" not in item]
            for current in native_by_key.values():
                match = next((item for item in unbound
                              if item.get("status") in ("queued", "error")
                              and (item.get("nativePrompt") == current["prompt"]
                                   or item.get("prompt") == current["prompt"])), None)
                if match is not None:
                    match["native"] = current["native"]
                    match["nativePrompt"] = current["prompt"]
                    match["status"] = "queued"
                    match.pop("error", None)
                    unbound.remove(match)
                else:
                    state["items"].append(current)
                changed = True
            self._drop_empty(session_id)
            if changed:
                self._save()
                result = self._public(session_id)
            else:
                result = None
        if result is not None:
            await self.queue_changed(session_id, result)

    async def _native_contains(self, session_id: str, item: QueueItem) -> bool:
        try:
            return await self.native_queue.contains(session_id, item)
        except Exception:
            log.warning("native queue verification failed session=%s", session_id,
                        exc_info=True)
            return True

    async def _drain_one(self, session_id: str) -> None:
        async with self._lock(session_id):
            state = self._sessions.get(session_id)
            if not state or state["paused"] or not state["items"]:
                return
            item = state["items"][0]
            held_until = item.get("heldUntil")
            if isinstance(held_until, (int, float)):
                if held_until > time.time():
                    return
                item.pop("heldUntil", None)
                state["paused"] = True
                self._save()
                expired = self._public(session_id)
            else:
                expired = None
            if item["status"] != "queued":
                return
            if "native" in item:
                return
            item_id = str(item["id"])
        if expired:
            await self.queue_changed(session_id, expired)
            return
        if await self.is_running(session_id):
            return
        async with self._lock(session_id):
            state = self._sessions.get(session_id)
            if not state or state["paused"] or not state["items"]:
                return
            item = state["items"][0]
            held_until = item.get("heldUntil")
            if item["id"] != item_id or item["status"] != "queued":
                return
            if "native" in item:
                return
            if isinstance(held_until, (int, float)):
                if held_until > time.time():
                    return
                item.pop("heldUntil", None)
                state["paused"] = True
                self._save()
                expired = self._public(session_id)
            else:
                expired = None
            if expired:
                sending = None
                delivery_item = None
            else:
                item.pop("heldUntil", None)
                item["status"] = "sending"
                self._save()
                sending = self._public(session_id)
                delivery_item = dict(item)
        if expired:
            await self.queue_changed(session_id, expired)
            return
        await self.queue_changed(session_id, sending)
        try:
            is_started = await self.start_prompt(session_id, delivery_item)
            should_retry = False
        except RetryLater:
            is_started = False
            should_retry = True
        except Exception:
            is_started = False
            should_retry = False
            log.exception("queued follow-up failed session=%s item=%s", session_id, item_id)
        async with self._lock(session_id):
            state = self._sessions.get(session_id)
            if not state:
                return
            try:
                item = self._find(session_id, item_id)
            except ItemNotFound:
                return
            if should_retry:
                item["status"] = "queued"
                self._save()
            elif is_started:
                state["items"].remove(item)
                self._remember_completed(state, item_id)
                self._drop_empty(session_id)
            else:
                item["status"] = "error"
                item["error"] = "The message could not start. Review it and resume the queue."
                state["paused"] = True
            self._save()
            result = self._public(session_id)
        await self.queue_changed(session_id, result)

    def _find(self, session_id: str, item_id: str) -> QueueItem:
        state = self._sessions.get(session_id)
        if state:
            for item in state["items"]:
                if item["id"] == item_id:
                    return item
        raise ItemNotFound

    def _drop_empty(self, session_id: str) -> None:
        state = self._sessions.get(session_id)
        if state is not None and not state["items"] and not state["completedIds"]:
            self._sessions.pop(session_id, None)

    @staticmethod
    def _remember_completed(state: dict, item_id: str) -> None:
        completed_ids = state["completedIds"]
        if item_id not in completed_ids:
            completed_ids.append(item_id)
            del completed_ids[:-RECEIPT_LIMIT]
