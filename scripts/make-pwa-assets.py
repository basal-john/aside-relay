#!/usr/bin/env python3
"""Regenerates the maskable icon, the light and dark iOS launch screens, and the matching launch layer in web/index.html.

One SVG composition drives both outputs, so the launch image iOS shows and the first frame the page paints are the same picture.
Requires rsvg-convert (Homebrew librsvg).
"""
import math
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "web" / "icons"
INDEX = ROOT / "web" / "index.html"
ARROWS = '<path d="M16 24h30l-8-8M48 40H18l8 8" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'

DEVICES = [
    (440, 956, 3), (402, 874, 3), (430, 932, 3), (393, 852, 3), (420, 912, 3), (428, 926, 3),
    (390, 844, 3), (375, 812, 3), (414, 896, 3), (414, 896, 2), (375, 667, 2),
]

THEMES = {
    "light": {"bg": "#ffffff", "ink": "#171717"},
    "dark": {"bg": "#000000", "ink": "#f3f3f3"},
}

STEP = 5.4
FIELD_RADIUS = 5.2
DOT_RADIUS = 0.55
DOT_OPACITY = 0.16
WAVE_DELAY_S = 0.11


def art(theme: str, attrs: str) -> str:
    """Returns the launch composition in a 100 x 300 box that is cropped to fill any portrait screen.

    A round field of faint dots on the app canvas. Each dot carries the delay of the wave that index.html plays over it,
    so the still image is the first frame of the loading motion.
    """
    c = THEMES[theme]
    cx, cy = 50, 150
    dots = "".join(
        f'<circle class="boot-dot" cx="{round(cx + x * STEP, 2):g}" cy="{round(cy + y * STEP, 2):g}" r="{DOT_RADIUS}" fill="{c["ink"]}" '
        f'opacity="{DOT_OPACITY}" style="animation-delay:{math.hypot(x, y) * WAVE_DELAY_S:.2f}s"/>'
        for y in range(-5, 6)
        for x in range(-5, 6)
        if math.hypot(x, y) <= FIELD_RADIUS
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 300" preserveAspectRatio="xMidYMid slice" {attrs}>'
        f'<rect x="-100" y="-100" width="300" height="500" fill="{c["bg"]}"/>'
        f'{dots}'
        f'</svg>'
    )


def render(svg: str, out: Path) -> None:
    subprocess.run(["rsvg-convert", "-o", str(out)], input=svg.encode(), check=True)


def replace_block(html: str, name: str, body: str) -> str:
    pattern = re.compile(rf"(<!-- {name}:start -->)(.*?)(\s*<!-- {name}:end -->)", re.S)
    html, count = pattern.subn(lambda m: m.group(1) + "\n" + body + m.group(3), html)
    assert count == 1, f"expected one {name} block in index.html, found {count}"
    return html


def main() -> None:
    render(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64"><rect width="64" height="64" fill="#a34dff"/>{ARROWS}</svg>',
        ICONS / "icon-maskable-512.png",
    )
    links = []
    for w, h, dpr in DEVICES:
        pw, ph = w * dpr, h * dpr
        for theme in THEMES:
            name = f"splash-{pw}x{ph}{'' if theme == 'light' else '-dark'}.png"
            render(art(theme, f'width="{pw}" height="{ph}"'), ICONS / name)
            links.append(
                f'    <link rel="apple-touch-startup-image" media="(prefers-color-scheme: {theme}) and (device-width: {w}px) and (device-height: {h}px) '
                f'and (-webkit-device-pixel-ratio: {dpr}) and (orientation: portrait)" href="/icons/{name}" />'
            )
    html = INDEX.read_text()
    html = replace_block(html, "splash", "\n".join(links))
    boot = "\n".join("      " + art(theme, 'class="boot-%s" aria-hidden="true"' % theme) for theme in THEMES)
    html = replace_block(html, "boot", boot)
    INDEX.write_text(html)
    print(f"wrote icon-maskable-512.png, {len(links)} launch screens and the index.html launch layer")


if __name__ == "__main__":
    main()
