"""Behavioral coverage for persistent follow-up queues."""
import asyncio
import json
import uuid
from unittest.mock import AsyncMock, patch

from tests.backend import support

import followups
from native_queue import NativeQueueRestoreError, NativeQueueSteerError


SESSION_ID = support.SESSION_ID


def message(item_id=None, prompt="Follow up", attachments=None):
    return {
        "id": item_id or str(uuid.uuid4()),
        "prompt": prompt,
        "attachments": attachments or [],
    }


def native_item(item, key="native-1", prompt=None):
    text = prompt if prompt is not None else item["prompt"]
    native_message = {
        "role": "user",
        "timestamp": key,
        "content": [{"type": "text", "text": text}],
    }
    return {
        **item,
        "prompt": text,
        "status": "queued",
        "native": {"key": key, "message": native_message, "metadata": None},
        "nativePrompt": text,
    }


class NativeQueueStub:
    def __init__(self):
        self.items = []
        self.enqueue_calls = 0
        self.steer_error = None

    def prompt(self, item):
        names = "".join(f"\n{value['path']}" for value in item.get("attachments", []))
        return f"{item['prompt']}{names}".strip()

    async def list(self, _session_id):
        return [dict(value) for value in self.items]

    async def enqueue(self, _session_id, item):
        self.enqueue_calls += 1
        value = native_item(item, f"native-{self.enqueue_calls}", self.prompt(item))
        self.items.append(value)
        return value

    async def update(self, _session_id, original, update):
        value = native_item(update, original["native"]["key"], self.prompt(update))
        self.items = [value if candidate["native"]["key"] == original["native"]["key"]
                      else candidate for candidate in self.items]
        return value

    async def delete(self, _session_id, item):
        self.items = [value for value in self.items
                      if value["native"]["key"] != item["native"]["key"]]

    async def contains(self, _session_id, item):
        return any(value["native"]["key"] == item["native"]["key"]
                   for value in self.items)

    async def steer(self, _session_id, item):
        if self.steer_error is not None:
            raise self.steer_error
        await self.delete(_session_id, item)
        return True


class FollowupQueueTests(support.IsolatedBackendTest):
    def setUp(self):
        super().setUp()
        self.enterContext(patch("followups.log.exception"))

    def make_queue(self, *, running=False, native=None, start_prompt=None):
        self.events = []
        self.running = running
        self.deliveries = []

        async def deliver(session_id, item):
            self.deliveries.append((session_id, dict(item)))
            return True

        return followups.FollowupQueue(
            self.root / "followups.json",
            AsyncMock(return_value=running),
            start_prompt or deliver,
            AsyncMock(side_effect=lambda _sid, state: self.events.append(state)),
            native,
        )

    async def test_stopped_run_delivers_one_local_message_exactly_once(self):
        queue = self.make_queue(running=False)
        item = message()

        await asyncio.gather(queue.enqueue(SESSION_ID, item), queue.enqueue(SESSION_ID, item))
        await asyncio.gather(queue._drain_one(SESSION_ID), queue._drain_one(SESSION_ID))

        self.assertEqual([entry[1]["id"] for entry in self.deliveries], [item["id"]])
        self.assertEqual((await queue.get(SESSION_ID))["items"], [])

    async def test_running_run_queues_native_message_without_local_delivery(self):
        native = NativeQueueStub()
        queue = self.make_queue(running=True, native=native)
        item = message()

        result = await queue.enqueue(SESSION_ID, item)

        self.assertEqual(native.enqueue_calls, 1)
        self.assertEqual(result["items"][0]["status"], "queued")
        self.assertNotIn("native", result["items"][0])
        self.assertEqual(self.deliveries, [])

    async def test_edit_lease_blocks_delivery_until_editor_releases_it(self):
        queue = self.make_queue(running=False)
        item = message()
        await queue.enqueue(SESSION_ID, item)

        editing = await queue.edit(SESSION_ID, item["id"], None, True)
        await queue._drain_one(SESSION_ID)
        released = await queue.edit(SESSION_ID, item["id"], None, False)
        await queue._drain_one(SESSION_ID)

        self.assertTrue(editing["items"][0]["isEditing"])
        self.assertFalse(released["items"][0]["isEditing"])
        self.assertEqual(len(self.deliveries), 1)

    async def test_pause_resume_and_cancel_are_immediately_persisted(self):
        queue = self.make_queue(running=False)
        first, second = message(), message()
        await queue.enqueue(SESSION_ID, first)
        await queue.enqueue(SESSION_ID, second)

        await queue.pause(SESSION_ID)
        await queue._drain_one(SESSION_ID)
        resumed = await queue.resume(SESSION_ID)
        cancelled = await queue.delete(SESSION_ID, first["id"])

        self.assertTrue(self.events[-3]["isPaused"])
        self.assertFalse(resumed["isPaused"])
        self.assertEqual([value["id"] for value in cancelled["items"]], [second["id"]])
        restarted = self.make_queue(running=False)
        self.assertEqual([value["id"] for value in (await restarted.get(SESSION_ID))["items"]],
                         [second["id"]])

    async def test_restart_preserves_attachment_prompt_and_exact_native_identity(self):
        native = NativeQueueStub()
        item = message(attachments=[{"id": "upload-1", "path": "/tmp/photo.png"}])
        queue = self.make_queue(running=True, native=native)
        await queue.enqueue(SESSION_ID, item)

        restarted = self.make_queue(running=True, native=native)
        result = await restarted.get(SESSION_ID)
        stored = json.loads((self.root / "followups.json").read_text())
        persisted = stored["sessions"][SESSION_ID]["items"][0]

        self.assertEqual(result["items"][0]["attachments"], item["attachments"])
        self.assertEqual(persisted["native"]["key"], "native-1")
        self.assertEqual(persisted["nativePrompt"], native.prompt(item))
        self.assertEqual(len(result["items"]), 1)

    async def test_reconciliation_imports_external_native_and_removes_consumed_item(self):
        native = NativeQueueStub()
        queue = self.make_queue(running=True, native=native)
        external = native_item(message(prompt="From Aside"), "external")
        native.items = [external]

        imported = await queue.get(SESSION_ID)
        native.items = []
        consumed = await queue.get(SESSION_ID)

        self.assertEqual(imported["items"][0]["prompt"], "From Aside")
        self.assertEqual(consumed["items"], [])

    async def test_native_steer_success_removes_message(self):
        native = NativeQueueStub()
        queue = self.make_queue(running=True, native=native)
        item = message()
        await queue.enqueue(SESSION_ID, item)

        result = await queue.steer(SESSION_ID, item["id"], AsyncMock())

        self.assertEqual(result["items"], [])
        self.assertEqual(native.items, [])

    async def test_native_steer_rejection_is_observable_and_retains_message(self):
        native = NativeQueueStub()
        queue = self.make_queue(running=True, native=native)
        item = message()
        await queue.enqueue(SESSION_ID, item)
        native.steer_error = NativeQueueSteerError("unsupported rich content")

        with self.assertRaises(NativeQueueSteerError):
            await queue.steer(SESSION_ID, item["id"], AsyncMock())

        result = await queue.get(SESSION_ID)
        self.assertEqual(result["items"][0]["status"], "queued")
        self.assertFalse(result["isPaused"])

    async def test_native_restore_failure_retains_local_message_and_pauses(self):
        native = NativeQueueStub()
        queue = self.make_queue(running=True, native=native)
        item = message()
        await queue.enqueue(SESSION_ID, item)
        native.items = []
        native.steer_error = NativeQueueRestoreError("restore failed")

        with self.assertRaises(NativeQueueRestoreError):
            await queue.steer(SESSION_ID, item["id"], AsyncMock())

        result = await queue.get(SESSION_ID)
        self.assertEqual(result["items"][0]["prompt"], item["prompt"])
        self.assertEqual(result["items"][0]["status"], "error")
        self.assertTrue(result["isPaused"])

    async def test_failed_native_edit_rolls_back_but_consumed_race_does_not_resurrect(self):
        native = NativeQueueStub()
        queue = self.make_queue(running=True, native=native)
        item = message(prompt="Before")
        await queue.enqueue(SESSION_ID, item)
        native.update = AsyncMock(side_effect=RuntimeError("update failed"))

        with self.assertRaises(RuntimeError):
            await queue.edit(SESSION_ID, item["id"], {"prompt": "After"}, False)
        self.assertEqual((await queue.get(SESSION_ID))["items"][0]["prompt"], "Before")

        native.items = []
        result = await queue.edit(SESSION_ID, item["id"], {"prompt": "After"}, False)
        self.assertEqual(result["items"], [])
