#!/usr/bin/env bash
# Rebuilds the fonts and the emoji set of assets/ from their upstream sources (see assets/CREDITS.md).
# Requires curl, sha256sum, python3 with fontTools and brotli
# (`pip install fonttools brotli`).
# Not run by CI: the outputs are committed. The LUTs are our own work, see build-luts.ts (`npm run build:luts`).
#
#   packages/builtins/scripts/make.sh [fonts|emoji|all] [work-dir]   (default: all, packages/builtins/.work)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
assets=$here/../assets
what=${1:-all}
work=${2:-$here/../.work}
mkdir -p "$work"

fetch() { # url file sha256
  if [ ! -f "$2" ]; then
    mkdir -p "$(dirname "$2")"
    curl -fsSL -o "$2" "$1"
  fi
  echo "$3  $2" | sha256sum -c --quiet
}

# Latin (Basic Latin, Latin-1, Extended-A/B, IPA, spacing modifiers, combining diacritics, Latin Extended Additional
# with Vietnamese, Extended-C/D), general punctuation, currency, letterlike symbols, arrows, math minus/slash.
ranges='U+0000-036F,U+1D00-1DBF,U+1E00-1EFF,U+2000-206F,U+20A0-20C0,U+2100-214F,U+2190-2199,U+2212,U+2215,U+2C60-2C7F,U+A720-A7FF,U+FB00-FB06,U+FEFF,U+FFFD'

# google/fonts at a fixed commit: every font is OFL-1.1 without a Reserved Font Name.
gf=https://raw.githubusercontent.com/google/fonts/06bfe0d62a98375cb09c942fa18e68bd32cff057/ofl

# name  directory  upstream file (URL-encoded)  axes  sha256
fonts=(
  "sans          inter         Inter%5Bopsz,wght%5D.ttf          wght=400,opsz=14  29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031"
  "sans-bold     inter         Inter%5Bopsz,wght%5D.ttf          wght=700,opsz=14  29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031"
  "rounded-bold  nunito        Nunito%5Bwght%5D.ttf              wght=700          bb55a5ca5c2042335b3991af27c4d0705d0ef41cac6164ac737fd8f2a1e85207"
  "serif         notoserif     NotoSerif%5Bwdth,wght%5D.ttf      wght=400,wdth=100 4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713"
  "mono          jetbrainsmono JetBrainsMono%5Bwght%5D.ttf       wght=400          48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda"
  "handwritten   caveat        Caveat%5Bwght%5D.ttf              wght=500          0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988"
)

if [ "$what" = fonts ] || [ "$what" = all ]; then
  for f in "${fonts[@]}"; do
    read -r name dir file axes sha <<<"$f"
    fetch "$gf/$dir/$file" "$work/fonts/$dir.ttf" "$sha"
    curl -fsSL -o "$assets/licenses/OFL-$dir.txt" "$gf/$dir/OFL.txt"
    python3 -I "$here/make-font.py" "$work/fonts/$dir.ttf" "$assets/fonts/$name.woff2" "$axes" "$ranges"
  done
  ls -l "$assets/fonts"
fi

# Noto Color Emoji (googlefonts/noto-emoji, release v2026-09-24-unicode18_0): the CBDT font holds every emoji as a
# PNG, flags included (the repository's png/ folders have no flags). The Unicode 18.0 emoji-test.txt lists the RGI set.
noto=https://raw.githubusercontent.com/googlefonts/noto-emoji/e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e
if [ "$what" = emoji ] || [ "$what" = all ]; then
  fetch "$noto/2D/fonts/NotoColorEmoji.ttf" "$work/NotoColorEmoji.ttf" 15671215ab769fdc7162a045d56fd7d7e477c51b04e6b3c761d914d8fdd6cc44
  fetch "$noto/emoji_aliases.txt" "$work/emoji_aliases.txt" 8486155d242f84e8c04108705383b11f9f351cc60147734c15d50b8eaa4df370
  fetch https://www.unicode.org/Public/18.0.0/emoji/emoji-test.txt "$work/emoji-test.txt" \
    8f3735cda1f92a779d78af67cf86066bb1f07143dc22f2ac29394d9bc57ab21a
  curl -fsSL -o "$assets/licenses/OFL-noto-emoji.txt" "$noto/LICENSE"
  python3 -I "$here/extract-emoji.py" "$work/NotoColorEmoji.ttf" "$work/emoji-test.txt" "$work/emoji_aliases.txt" \
    "$assets/fonts" "$assets/emoji"
  du -sh --apparent-size "$assets/emoji"
fi
