"""Parsing of `aside session list` output across CLI versions."""
from unittest.mock import AsyncMock, MagicMock, patch

from tests.backend import support

import sessions


def _proc(stdout: str, returncode: int = 0):
    proc = MagicMock()
    proc.communicate = AsyncMock(return_value=(stdout.encode(), b""))
    proc.returncode = returncode
    return proc


class SessionListTests(support.IsolatedBackendTest):
    async def _parse(self, stdout: str):
        with patch("sessions.asyncio.create_subprocess_exec", new=AsyncMock(return_value=_proc(stdout))):
            return await sessions.live_sessions()

    async def test_tab_separated_output_with_header(self):
        items = await self._parse(
            "ID\tSTATUS\tTYPE\tTITLE\tUPDATED\n"
            "6xXtyDhePebbMRdI\trunning\tpersistent\tInstagram reel ideas\t2026-11-17T10:22:00.000Z\n"
            "x5ZSr5oVrC3bEsCe\tidle\tephemeral\t\t2026-09-28T06:51:45.000Z\n"
            "routine-oX6ifBxCKBXYubMY\tidle\tpersistent\tWeekly digest\t2026-10-10T08:52:01.000Z\n"
        )

        self.assertEqual([i["id"] for i in items],
                         ["6xXtyDhePebbMRdI", "x5ZSr5oVrC3bEsCe", "routine-oX6ifBxCKBXYubMY"])
        self.assertEqual(items[0]["status"], "running")
        self.assertEqual(items[0]["title"], "Instagram reel ideas")
        self.assertTrue(items[1]["ephemeral"])
        self.assertEqual(items[1]["updatedAt"], "2026-09-28T06:51:45.000Z")

    async def test_legacy_two_space_output(self):
        items = await self._parse("6xXtyDhePebbMRdI  idle  persistent  Old title  2026-11-17T10:22:00.000Z\n")

        self.assertEqual(items[0]["id"], "6xXtyDhePebbMRdI")
        self.assertEqual(items[0]["title"], "Old title")

    async def test_unknown_output_still_fails_loudly(self):
        with self.assertRaises(RuntimeError):
            await self._parse("something unexpected\n")
