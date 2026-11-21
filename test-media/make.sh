#!/usr/bin/env bash
# Rebuilds the test clips of this folder from their sources (see README.md).
# Requires curl, ffmpeg (built with libx264) and sha256sum. Not run by CI: the clips are committed.
#
#   test-media/make.sh [work-dir]   (default: test-media/.work, gitignored)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=${1:-$here/.work}
mkdir -p "$work"
# Wikimedia requires a descriptive User-Agent with a contact.
ua="ouaf-test-media/0.1 (https://github.com/open-ar-filter/ouaf)"
base="https://upload.wikimedia.org/wikipedia/commons"

# id  path-on-commons  sha256
sources=(
  "57767 2/21 df22f449af8e02183acfe1d2234c6e0635a96ea922add2ca1eb52d2914b27b44"
  "57768 9/92 9dd320d950f281443ec6eedd22450a906a6b621246bd92a933d5207872a994a4"
  "57769 8/8a f44dc03078daffdb8614aca864bca75753a3baacc8950b481e078c3a1f0decd9"
  "57770 3/36 b3b15bcf03b57887f751ab3930884696973d23003cc955a51d50ea24d77817a4"
)
for s in "${sources[@]}"; do
  read -r id path sha <<<"$s"
  file="$work/$id.webm"
  if [ ! -f "$file" ]; then
    curl -fsSL -A "$ua" -o "$file" "$base/$path/Thomas_Pesquet_plonge_dans_le_Nautile_%28Ifremer_00985-109683_-_$id%29.webm"
  fi
  echo "$sha  $file" | sha256sum -c --quiet
done

# name  source  start  end  crf
clips=(
  "pesquet-walk    57770 39.0 47.5 26"
  "pesquet-talk    57770 50.0 58.0 26"
  "pesquet-closeup 57768  5.4  8.5 26"
  "pesquet-turn    57767 16.2 18.6 26"
  "two-faces       57770 89.1 92.2 26"
  "group-far       57770 60.6 65.6 26"
  "no-face         57769  2.6  5.0 30"
)
for c in "${clips[@]}"; do
  read -r name src start end crf <<<"$c"
  ffmpeg -nostdin -loglevel error -ss "$start" -to "$end" -i "$work/$src.webm" -an \
    -vf "scale=720:1280,fps=30" -c:v libx264 -profile:v main -pix_fmt yuv420p -crf "$crf" -preset slow \
    -g 30 -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact -y "$here/$name.mp4"
  echo "$name.mp4"
done

# Half-resolution variants (360×640), to measure whether the input resolution matters.
small=(
  "pesquet-closeup-360 57768  5.4  8.5 26"
  "pesquet-talk-360    57770 50.0 58.0 26"
)
for c in "${small[@]}"; do
  read -r name src start end crf <<<"$c"
  ffmpeg -nostdin -loglevel error -ss "$start" -to "$end" -i "$work/$src.webm" -an \
    -vf "scale=360:640,fps=30" -c:v libx264 -profile:v main -pix_fmt yuv420p -crf "$crf" -preset slow \
    -g 30 -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact -y "$here/$name.mp4"
  echo "$name.mp4"
done

# Two frontal faces stacked vertically (MediaPipe's short-range detector only finds large faces):
# top = 57770 89.1–92.2 s (cropped y 240–880), bottom = 57768 5.4–8.5 s (cropped y 400–1040).
ffmpeg -nostdin -loglevel error \
  -ss 89.1 -t 3.1 -i "$work/57770.webm" -ss 5.4 -t 3.1 -i "$work/57768.webm" -an \
  -filter_complex "[0:v]scale=720:1280,crop=720:640:0:240,fps=30[top];[1:v]scale=720:1280,crop=720:640:0:400,fps=30[bottom];[top][bottom]vstack=2" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -crf 26 -preset slow \
  -g 30 -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact -y "$here/two-faces-stacked.mp4"
echo two-faces-stacked.mp4


# Four (and three) frontal faces in a 2×2 grid, for the multi-face cost (#8). Each cell is 360×640: the source is
# scaled to 702×1248 (0.65) and cropped around the face, so that faces stay ≈ 35 % of the frame width, large enough
# for MediaPipe's short-range detector. Only two extracts have a frontal face for 3 s, so the bottom row reuses them
# played backwards and mirrored (different pose and side at every instant):
#   top-left  = 57770 89.1–92.2 s          top-right    = 57768 5.4–8.5 s
#   bottom-left = 57768, reversed, mirrored  bottom-right = 57770, reversed, mirrored
#                                            (three-faces-grid: 57769 6.0–9.1 s, underwater, no face)
cells="[0:v]scale=702:1248,crop=360:640:34:304,fps=30,split[a1][a2];[1:v]scale=702:1248,crop=360:640:184:408,fps=30,split[b1][b2];[a2]reverse,hflip[ar];[b2]reverse,hflip[br]"
ffmpeg -nostdin -loglevel error \
  -ss 89.1 -t 3.1 -i "$work/57770.webm" -ss 5.4 -t 3.1 -i "$work/57768.webm" -an \
  -filter_complex "$cells;[a1][b1][br][ar]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -crf 26 -preset slow \
  -g 30 -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact -y "$here/four-faces-grid.mp4"
echo four-faces-grid.mp4
ffmpeg -nostdin -loglevel error \
  -ss 89.1 -t 3.1 -i "$work/57770.webm" -ss 5.4 -t 3.1 -i "$work/57768.webm" -ss 6.0 -t 3.1 -i "$work/57769.webm" -an \
  -filter_complex "$cells;[ar]nullsink;[2:v]scale=702:1248,crop=360:640:171:304,fps=30[empty];[a1][b1][br][empty]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -crf 26 -preset slow \
  -g 30 -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact -y "$here/three-faces-grid.mp4"
echo three-faces-grid.mp4
