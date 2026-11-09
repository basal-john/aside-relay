#!/usr/bin/env python3
"""Regenerates the maskable icon, the light and dark iOS launch screens, and the matching launch layer in web/index.html.

One SVG composition drives both outputs, so the launch image iOS shows and the first frame the page paints are the same picture.
Requires rsvg-convert (Homebrew librsvg).
"""
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
    "light": {"bg": "#ffffff", "halo": 0.30, "ring": 0.20, "shadow": 0.45},
    "dark": {"bg": "#000000", "halo": 0.42, "ring": 0.30, "shadow": 0.70},
}


def art(theme: str, attrs: str) -> str:
    """Returns the launch composition in a 100 x 300 box that is cropped to fill any portrait screen."""
    c = THEMES[theme]
    p = theme[0]
    t, cx, cy = 27, 50, 150
    x, y = cx - t / 2, cy - t / 2
    rings = "".join(
        f'<circle cx="{cx}" cy="{cy}" r="{t * k:.2f}" fill="none" stroke="#a34dff" stroke-opacity="{c["ring"] * (1.6 - k / 2):.3f}" stroke-width=".22"/>'
        for k in (1.05, 1.6, 2.25)
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 300" preserveAspectRatio="xMidYMid slice" {attrs}>'
        f'<defs>'
        f'<radialGradient id="{p}-halo" cx="{cx}" cy="{cy}" r="85" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#a34dff" stop-opacity="{c["halo"]}"/>'
        f'<stop offset=".45" stop-color="#a34dff" stop-opacity="{c["halo"] * 0.35:.3f}"/>'
        f'<stop offset="1" stop-color="#a34dff" stop-opacity="0"/></radialGradient>'
        f'<linearGradient id="{p}-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bb74ff"/><stop offset="1" stop-color="#8b34f2"/></linearGradient>'
        f'<linearGradient id="{p}-gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>'
        f'<filter id="{p}-shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="1.62" stdDeviation="2.43" flood-color="#7a1fe0" flood-opacity="{c["shadow"]}"/></filter>'
        f'</defs>'
        f'<rect x="-100" y="-100" width="300" height="500" fill="{c["bg"]}"/>'
        f'<rect x="-100" y="-100" width="300" height="500" fill="url(#{p}-halo)"/>'
        f'{rings}'
        f'<rect x="{x}" y="{y}" width="{t}" height="{t}" rx="6.35" fill="url(#{p}-tile)" filter="url(#{p}-shadow)"/>'
        f'<rect x="{x}" y="{y}" width="{t}" height="{t}" rx="6.35" fill="url(#{p}-gloss)"/>'
        f'<g transform="translate({x} {y}) scale({t / 64:.6f})">{ARROWS}</g>'
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
