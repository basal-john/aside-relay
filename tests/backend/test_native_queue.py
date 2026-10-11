"""Contract tests for Aside's native queued-message procedures."""
from unittest.mock import AsyncMock, patch

from tests.backend import support

import native_queue


SESSION_ID = support.SESSION_ID


def user_message(timestamp, text, *, extra=None):
    content = [{"type": "text", "text": text}]
    if extra is not None:
        content.append(extra)
    return {"role": "user", "timestamp": timestamp, "content": content}


class NativeQueueTests(support.IsolatedBackendTest):
    def setUp(self):
        super().setUp()
        self.queue = native_queue.NativeQueue(lambda item: item["prompt"])

    async def test_list_pairs_metadata_and_keeps_stable_identity(self):
        metadata = {"role": "user-message-metadata", "timestamp": 1, "files": ["a.png"]}
        message = user_message(2, "Hello")
        self.native_call.side_effect = None
        self.native_call.return_value = {"queuedMessages": [metadata, message]}

        first = await self.queue.list(SESSION_ID)
        second = await self.queue.list(SESSION_ID)

        self.assertEqual(first[0]["id"], second[0]["id"])
        self.assertEqual(first[0]["prompt"], "Hello")
        self.assertIs(first[0]["native"]["metadata"], metadata)

    async def test_update_delete_and_move_send_the_exact_native_message(self):
        first_message = user_message(1, "First")
        second_message = user_message(2, "Second")
        first, second = native_queue._queued_items(SESSION_ID, [first_message, second_message])
        responses = [None, {"queuedMessages": [user_message(1, "Edited")]}, None,
                     None, {"queuedMessages": [second_message, first_message]}]
        self.native_call.side_effect = responses

        updated = await self.queue.update(
            SESSION_ID, first, {"prompt": "Edited", "attachments": []}
        )
        await self.queue.delete(SESSION_ID, first)
        moved = await self.queue.move(SESSION_ID, first, second)

        update_call = self.native_call.await_args_list[0]
        delete_call = self.native_call.await_args_list[2]
        move_call = self.native_call.await_args_list[3]
        self.assertIs(update_call.args[1]["message"], first_message)
        self.assertIs(delete_call.args[1]["message"], first_message)
        self.assertIs(move_call.args[1]["message"], first_message)
        self.assertEqual(move_call.args[1]["beforeTimestamp"], 2)
        self.assertEqual(updated["prompt"], "Edited")
        self.assertEqual([value["prompt"] for value in moved], ["Second", "First"])

    async def test_enqueue_returns_only_the_new_native_entry(self):
        old = user_message(1, "Old")
        new = user_message(2, "New")
        self.native_call.side_effect = [
            {"queuedMessages": [old]},
            {"queuedMessages": [old, new]},
        ]
        with patch("native_queue.runner.queue", new=AsyncMock(return_value=True)), \
                patch("native_queue.asyncio.sleep", new=AsyncMock()):
            result = await self.queue.enqueue(
                SESSION_ID, {"prompt": "New", "attachments": []}
            )

        self.assertEqual(result["prompt"], "New")

    async def test_steer_deletes_before_delivery(self):
        item = native_queue._queued_items(SESSION_ID, [user_message(1, "Steer")])[0]
        order = []

        async def call(procedure, _value, **_kwargs):
            order.append(procedure)

        async def steer(_session_id, _prompt):
            order.append("runner.steer")
            return True

        self.native_call.side_effect = call
        with patch("native_queue.runner.steer", new=steer):
            self.assertTrue(await self.queue.steer(SESSION_ID, item))

        self.assertEqual(order, ["sessions.removeQueuedMessage", "runner.steer"])

    async def test_delete_failure_prevents_steer_delivery(self):
        item = native_queue._queued_items(SESSION_ID, [user_message(1, "Steer")])[0]
        self.native_call.side_effect = RuntimeError("remove failed")
        steer = AsyncMock(return_value=True)

        with patch("native_queue.runner.steer", new=steer), \
                self.assertRaises(native_queue.NativeQueueError):
            await self.queue.steer(SESSION_ID, item)

        steer.assert_not_awaited()

    async def test_delivery_failure_restores_and_exposes_rejection(self):
        original = native_queue._queued_items(SESSION_ID, [user_message(1, "Steer")])[0]
        restored = native_queue._queued_items(SESSION_ID, [user_message(2, "Steer")])[0]
        self.native_call.side_effect = None
        self.native_call.return_value = None
        with patch("native_queue.runner.steer", new=AsyncMock(return_value=False)), \
                patch.object(self.queue, "_enqueue_prompt", new=AsyncMock(return_value=restored)):
            with self.assertRaises(native_queue.NativeQueueSteerError):
                await self.queue.steer(SESSION_ID, original)

        self.assertEqual(original["native"]["key"], restored["native"]["key"])

    async def test_delivery_and_restoration_failure_marks_queue_removed(self):
        item = native_queue._queued_items(SESSION_ID, [user_message(1, "Steer")])[0]
        self.native_call.side_effect = None
        self.native_call.return_value = None
        with patch("native_queue.runner.steer", new=AsyncMock(return_value=False)), \
                patch.object(self.queue, "_enqueue_prompt",
                             new=AsyncMock(side_effect=RuntimeError("restore failed"))):
            with self.assertRaises(native_queue.NativeQueueRestoreError) as raised:
                await self.queue.steer(SESSION_ID, item)

        self.assertTrue(raised.exception.queue_removed)

    async def test_already_consumed_after_failed_steer_is_success(self):
        item = native_queue._queued_items(SESSION_ID, [user_message(1, "Steer")])[0]
        self.native_call.side_effect = None
        self.native_call.return_value = None
        with patch("native_queue.runner.steer", new=AsyncMock(return_value=False)), \
                patch.object(self.queue, "_enqueue_prompt", new=AsyncMock(return_value=None)):
            result = await self.queue.steer(SESSION_ID, item)

        self.assertTrue(result)

    async def test_rich_or_metadata_message_cannot_lose_context_through_steer(self):
        metadata = {"role": "user-message-metadata", "files": ["a.png"]}
        item = native_queue._queued_items(
            SESSION_ID, [metadata, user_message(1, "Caption")]
        )[0]
        steer = AsyncMock(return_value=True)

        with patch("native_queue.runner.steer", new=steer), \
                self.assertRaises(native_queue.NativeQueueSteerError):
            await self.queue.steer(SESSION_ID, item)

        self.native_call.assert_not_awaited()
        steer.assert_not_awaited()
