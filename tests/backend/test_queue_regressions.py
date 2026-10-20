"""Regression coverage for native follow-up queue races."""
import asyncio
from unittest.mock import AsyncMock, patch

from tests.backend import support

import followups
import native_queue


SESSION_ID = support.SESSION_ID


def message(item_id, prompt):
    return {"id": item_id, "prompt": prompt, "attachments": []}


def native_item(item, key):
    native_message = {
        "role": "user",
        "timestamp": key,
        "content": [{"type": "text", "text": item["prompt"]}],
    }
    return {
        **item,
        "status": "queued",
        "native": {"key": key, "message": native_message, "metadata": None},
        "nativePrompt": item["prompt"],
    }


class ControlledNativeQueue:
    def __init__(self):
        self.items = []
        self.enqueue_calls = 0
        self.active_enqueues = 0
        self.max_active_enqueues = 0
        self.enqueue_started = asyncio.Event()
        self.enqueue_release = asyncio.Event()
        self.should_block_enqueue = False
        self.list_started = asyncio.Event()
        self.list_release = asyncio.Event()
        self.should_block_list = False

    def prompt(self, item):
        return item["prompt"]

    async def enqueue(self, _session_id, item):
        self.enqueue_calls += 1
        self.active_enqueues += 1
        self.max_active_enqueues = max(self.max_active_enqueues, self.active_enqueues)
        self.enqueue_started.set()
        try:
            if self.should_block_enqueue:
                await self.enqueue_release.wait()
            value = native_item(item, f"native-{self.enqueue_calls}")
            self.items.append(value)
            return value
        finally:
            self.active_enqueues -= 1

    async def list(self, _session_id):
        snapshot = [dict(item) for item in self.items]
        if self.should_block_list:
            self.should_block_list = False
            self.list_started.set()
            await self.list_release.wait()
        return snapshot

    async def update(self, _session_id, original, update):
        value = native_item(update, original["native"]["key"])
        self.items = [
            value if item["native"]["key"] == original["native"]["key"] else item
            for item in self.items
        ]
        return value


class QueueRegressionTests(support.IsolatedBackendTest):
    def make_queue(self, native):
        return followups.FollowupQueue(
            self.root / "followups.json",
            AsyncMock(return_value=True),
            AsyncMock(return_value=True),
            AsyncMock(),
            native,
        )

    async def test_native_enqueue_ignores_another_clients_new_message(self):
        queue = native_queue.NativeQueue(lambda item: item["prompt"])
        old = native_item(message("old", "Old"), "old")["native"]["message"]
        own = native_item(message("own", "Mine"), "own")["native"]["message"]
        other = native_item(message("other", "Other"), "other")["native"]["message"]
        self.native_call.side_effect = [
            {"queuedMessages": [old]},
            {"queuedMessages": [old, own, other]},
        ]

        with patch("native_queue.runner.queue", new=AsyncMock(return_value=True)), \
                patch("native_queue.asyncio.sleep", new=AsyncMock()):
            result = await queue.enqueue(SESSION_ID, message("local", "Mine"))

        self.assertEqual(result["prompt"], "Mine")
        self.assertEqual(result["native"]["message"], own)

    async def test_same_session_native_enqueues_keep_their_local_ids(self):
        native = ControlledNativeQueue()
        native.should_block_enqueue = True
        queue = self.make_queue(native)

        first = asyncio.create_task(queue.enqueue(SESSION_ID, message("first", "Same")))
        await asyncio.wait_for(native.enqueue_started.wait(), timeout=1)
        native.enqueue_started.clear()
        second = asyncio.create_task(queue.enqueue(SESSION_ID, message("second", "Same")))
        await asyncio.sleep(0)

        self.assertEqual(native.enqueue_calls, 1)
        self.assertFalse(native.enqueue_started.is_set())
        native.enqueue_release.set()
        await asyncio.wait_for(asyncio.gather(first, second), timeout=1)
        result = await queue.get(SESSION_ID)

        self.assertEqual(native.max_active_enqueues, 1)
        self.assertEqual({item["id"] for item in result["items"]}, {"first", "second"})

    async def test_native_sync_cannot_apply_a_snapshot_taken_before_edit(self):
        native = ControlledNativeQueue()
        queue = self.make_queue(native)
        await queue.enqueue(SESSION_ID, message("edit", "Before"))
        native.should_block_list = True

        sync = asyncio.create_task(queue._sync_native(SESSION_ID))
        await asyncio.wait_for(native.list_started.wait(), timeout=1)
        edit = asyncio.create_task(
            queue.edit(SESSION_ID, "edit", {"prompt": "After"}, False)
        )
        await asyncio.sleep(0)
        native.list_release.set()
        await asyncio.wait_for(asyncio.gather(sync, edit), timeout=1)

        result = await queue.get(SESSION_ID)
        self.assertEqual(result["items"][0]["prompt"], "After")
        self.assertEqual(result["items"][0]["status"], "queued")
