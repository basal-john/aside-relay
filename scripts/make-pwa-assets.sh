#!/bin/zsh
# Regenerates the maskable icon and the iOS launch screens in web/icons from the app mark.
set -euo pipefail
cd "${0:A:h}/../web/icons"
ARROWS='<g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 24h30l-8-8M48 40H18l8 8"/></g>'

print -r -- "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" fill=\"#a34dff\"/>$ARROWS</svg>" \
  | rsvg-convert -w 512 -h 512 -o icon-maskable-512.png

for spec in 1320x2868 1206x2622 1290x2796 1179x2556 1260x2736 1284x2778 1170x2532 1125x2436 1242x2688 828x1792 750x1334
do
  w=${spec%x*}
  h=${spec#*x}
  s=$(( w * 0.4 / 64.0 ))
  print -r -- "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"$w\" height=\"$h\"><rect width=\"$w\" height=\"$h\" fill=\"#a34dff\"/><g transform=\"translate($(printf %.2f $(( (w - 64 * s) / 2 ))) $(printf %.2f $(( (h - 64 * s) / 2 )))) scale($(printf %.4f $s))\">$ARROWS</g></svg>" \
    | rsvg-convert -o "splash-$spec.png"
done
