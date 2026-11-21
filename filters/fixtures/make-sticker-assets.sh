#!/usr/bin/env bash
# Rebuilds the synthetic assets of the sticker fixtures (`sticker/`, `sticker-screen/`): flat shapes and colors
# generated with ImageMagick 7 and ffmpeg (libx264), no image of anyone. CC0, like the fixtures.
set -euo pipefail
cd "$(dirname "$0")"
A=sticker/assets
S=sticker-screen/assets
mkdir -p "$A" "$S"
im() { magick "$@"; }

# Images, one per format: a magenta disc on transparency (PNG), flat squares (WebP, JPEG, AVIF), mid-gray squares.
im -size 128x128 xc:none -fill '#ff00ff' -draw 'circle 64,64 64,4' -strip "$A/disc.png"
im -size 64x64 xc:'#00ffff' -strip -define webp:lossless=true "$A/badge.webp"
cp "$A/disc.png" "$S/magenta.png"
cp "$A/badge.webp" "$S/cyan.webp"
im -size 64x64 xc:'#ff8000' -strip -quality 95 "$S/orange.jpg"
im -size 64x64 xc:'#80ff00' -strip "$S/lime.avif"
im -size 64x64 xc:'#808080' -strip "$S/gray.png"
im -size 64x64 xc:'#ffffff' -strip "$S/white.png"

# Spritesheet: 4 × 2 frames of 64 px, alternately red and green, a black mark moving right with the frame number.
tile() {
  local color x
  color=$([ $(($1 % 2)) -eq 0 ] && echo '#ff0000' || echo '#00ff00')
  x=$((4 + $1 * 7))
  im -size 64x64 "xc:$color" -fill black -draw "rectangle $x,4 $((x + 5)),9" "$A/tile$1.png"
}
for i in 0 1 2 3 4 5 6 7; do tile "$i"; done
im \( "$A"/tile[0-3].png +append \) \( "$A"/tile[4-7].png +append \) -append -strip "$A/walk.png"
rm "$A"/tile[0-7].png
cp "$A/walk.png" "$S/walk.png"

# Video with packed alpha (spec §10.2): color on the left (blue, a white mark sweeping across), mask on the right
# (a white disc whose radius pulses). 256×128, 2 s at 15 fps, H.264.
ffmpeg -v error -y \
  -f lavfi -i "color=c=0x0000ff:s=128x128:r=15:d=2,format=yuv420p,drawbox=x='mod(t*64,116)':y=84:w=12:h=10:color=white:t=fill" \
  -f lavfi -i "nullsrc=s=128x128:r=15:d=2,format=yuv420p,geq=lum='if(lt(hypot(X-63.5,Y-63.5),46+12*sin(PI*T)),255,0)':cb=128:cr=128" \
  -filter_complex '[0:v][1:v]hstack,format=yuv420p' \
  -c:v libx264 -profile:v main -crf 16 -g 30 -threads 1 -movflags +faststart -an -fflags +bitexact -flags:v +bitexact \
  "$A/flame.mp4"
cp "$A/flame.mp4" "$S/flame.mp4"
ls -l "$A" "$S"
