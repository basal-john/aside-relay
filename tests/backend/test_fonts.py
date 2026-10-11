import asyncio
from unittest.mock import patch

import httpx

from tests.backend import support
import fonts


class FontsTest(support.IsolatedBackendTest):
    def setUp(self):
        super().setUp()
        cache = self.root / "fonts"
        cache.mkdir()
        self.enterContext(patch.object(fonts, "CACHE", cache))
        self.enterContext(patch.object(fonts, "_INDEX_FILE", cache / "index.json"))
        self.enterContext(patch.object(fonts, "_index", {}))

    def test_allowlisted_css_rewrites_subset_urls_and_caches_woff2(self):
        calls = []
        url = "https://fonts.gstatic.com/s/notosanskr/v40/subset.woff2"

        def handle(request):
            calls.append(request)
            if request.url.host == "fonts.googleapis.com":
                self.assertIn("AppleWebKit/537.36", request.headers["User-Agent"])
                return httpx.Response(200, text=f"@font-face{{src:url({url}) format('woff2');unicode-range:U+AC00-D7A3}}")
            return httpx.Response(200, content=b"wOF2font-data", headers={"content-type": "font/woff2"})

        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                css = await fonts.css(client, "noto-sans-kr")
                self.assertNotIn("fonts.gstatic.com", css)
                self.assertIn("unicode-range:U+AC00-D7A3", css)
                fid = next(iter(fonts._index))
                self.assertEqual(await fonts.file(client, fid), (b"wOF2font-data", "font/woff2"))
                self.assertEqual(await fonts.css(client, "noto-sans-kr"), css)
                self.assertEqual(await fonts.file(client, fid), (b"wOF2font-data", "font/woff2"))
                self.assertEqual(len(calls), 2)
        asyncio.run(run())

    def test_unknown_fonts_and_untrusted_registered_urls_never_fetch(self):
        def handle(request):
            self.fail(f"Unexpected font request: {request.url}")

        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                self.assertIn("system font", await fonts.css(client, "unknown"))
                for url in ["https://fonts.gstatic.com.attacker.test/s/inter/font.woff2", "https://fonts.gstatic.com/s/unknown/font.woff2", "http://127.0.0.1/private", "https://cdn.jsdelivr.net/gh/untrusted/font.woff2"]:
                    fid = fonts._register(url)
                    self.assertIsNone(await fonts.file(client, fid))
        asyncio.run(run())
