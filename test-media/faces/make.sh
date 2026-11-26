#!/usr/bin/env bash
# Rebuilds the reference face set of this folder from its sources on Wikimedia Commons (see README.md).
# Requires curl, sha256sum, ImageMagick 7 (magick) and ffmpeg (built with libx264). Not run by CI: the files are
# committed. Made with ImageMagick 7.1.1-43 and ffmpeg 6.1.1; other versions may produce different bytes.
#
#   test-media/faces/make.sh [work-dir]   (default: test-media/.work/faces, gitignored)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=${1:-$here/../.work/faces}
mkdir -p "$work"
# Wikimedia requires a descriptive User-Agent with a contact, and limits the request rate.
ua="ouaf-test-media/0.1 (https://github.com/open-ar-filter/ouaf)"
base="https://upload.wikimedia.org/wikipedia/commons"

# id  sha256  path-on-commons
sources=(
  "dark-frontal 7356daa8fd4ad53b946ce0036f06b014431dc89b7ae29ecd8ef18fc54edce6b5 0/04/Face_portrait_%28Unsplash%29.jpg"
  "flower-crown 6754b485dce1780342a332e9af9a374269893abddd019bd9f39427c3e8888783 7/70/Mother_Nature%2C_Summer_%28Unsplash%29.jpg"
  "glasses-dim b47563f98419e027701e983070288b8796cd64b851879ef312533730cbc6abce 5/53/Irenio_Dionzio_%28Unsplash%29.jpg"
  "glasses-crowd ebc0d39c6c13322c47af584f813aa1ad3d73d816f89b9edeab54cb6c73ce4397 e/e1/Street_portrait_of_a_smiling_man_with_glasses%2C_S%C3%A3o_Paulo.jpg"
  "elder-beard-bw 1152ae148a110a5272d297ae4456ba621a5d1872acc89bcd7e46c2b288063dda f/f9/Man_with_a_white_beard_and_glasses%2C_by_Angelina_Litvin%2C_2015-10-05_%28Unsplash%29.jpg"
  "elder-smile 03f80f34457f0f15c20251de8ca93fc9c97e379c6ebcee815ef64fe5fde03108 8/80/Close-up_portrait_of_an_old_woman.jpg"
  "elder-sari 509dcd13cd7fde56f33610261d014a41f8ea59afbfe39072aaf2ef5c12343321 5/5b/Old_Indian_woman_with_a_sari.jpg"
  "headscarf-smile d9856f53375af46646ee1b06b4765533f684950e25f1b9ff2f2c6b98dffce697 8/8e/Smiling_older_woman_in_a_patterned_headscarf_in_Santa_Luc%C3%ADa%2C_Maracaibo%2C_Venezuela.jpg"
  "mask-hijab 22a336c82bfe52a5b5c5749d2bd2f56ab0cece4467283bdc36f4eeead5cfb11b d/d0/Iranian_surgical_technologist_with_hijab_01.jpg"
  "full-body 01067eab7a6c5a230d8a5dd8f9916d317b5ec9be92efcda822238556122cf0f0 9/9c/Young_North_Indian_man_with_beard_in_white_t-shirt.jpg"
  "night-phone 8072d5e747ad2d08ef0fe44ede41750945f2a421a83257493c962132aa81348e c/c5/Asian_woman_playing_with_her_smartphone_outside_at_night.jpg"
  "shadow-cap cadb489a4f18f1cf259c7d66a621e1b97cb474071987189ebe3dc68e7d292b1d f/f5/Shadowed_Portrait_%28Unsplash%29.jpg"
  "profile dab4d8e5d82abeb8c173a71eea4bdf53a1a0e79ad6be76d187fe4b8333431302 8/8f/Woman_in_a_headwrap_in_Quebec_City.jpg"
  "sunglasses e97da0704836315fe80511cfe472cb92bb34c0b5a9a87dc62358a0061b9ce8fd f/f3/Expresion%21_%28Unsplash%29.jpg"
  "three-quarter 5fa8b63e7439e9a2fe48aa041fdf385ecee6fb3d32505dc86b729272728fb9dd 7/74/Soft_Curls_%28Unsplash%29.jpg"
  "side-light aca3b45787b17c66309eaa10483d7c29d5689fbd82e773dce0f6fa299f735203 4/49/Bearded_man_smoking_pipe-3013924.jpg"
  "hand-pencil 20067b4537bf7adc28760c391c552af9a83602c05607bd958967e4ec69d638a8 f/f3/Laptop_and_girl_biting_pencil-pixabay.jpg"
  "selfie-lowres 8b37b6da6b59b7dbb3494c19af7e5a3d37209a87817c64ecd1995a6ea5ca3319 5/5d/Moise_speaking_French%2C_English%2C_Lingala%2C_Hunde%2C_Congo_Swahili.webm"
  "elder-glasses bed6be8d9367d93491850376fd5b52c2d3fa417808dedeed61dc9adfb8229f23 c/c2/Lina_speaking_Calabrese%2C_Savuto_variety.webm"
  "selfie-bali ec55ff5eb7e42cac280220e767b0060b889719c01fa1be9d86e6e046fe9d20f0 a/a1/Man_Speak_Bali_Aga_Balinese_dialect.webm"
  "webcam-ladakhi 7ce345d59fef4c686b481cffab590bcd4da860b4bf3d4207a25b44633f82e8fb 6/64/Kunzang_speaking_Ladakhi.webm"
  "backlit bb7dee17fc448fec1a44fcfee4d0925ed31063a7966795ff88e1e4171285e60d 5/58/Pavel_speaking_Emilian.webm"
)
for s in "${sources[@]}"; do
  read -r id sha path <<<"$s"
  file="$work/$id.${path##*.}"
  if [ ! -f "$file" ]; then
    curl -fsSL -A "$ua" -o "$file" "$base/$path"
    sleep 5
  fi
  echo "$sha  $file" | sha256sum -c --quiet
done

# Stills: JPEG, at most 1280 px on the long side (never upscaled), the source framing unless a crop is given
# (WxH+X+Y in source pixels).
# id  crop
stills=(
  "dark-frontal    -"
  "flower-crown    -"
  "glasses-dim     -"
  "glasses-crowd   -"
  "elder-beard-bw  -"
  "elder-smile     -"
  "elder-sari      -"
  "headscarf-smile -"
  "mask-hijab      -"
  "full-body       -"
  "night-phone     1200x1600+700+300"
  "shadow-cap      -"
  "profile         -"
  "sunglasses      -"
  "three-quarter   -"
  "side-light      -"
  "hand-pencil     -"
)
for s in "${stills[@]}"; do
  read -r id crop <<<"$s"
  args=(-auto-orient)
  [ "$crop" != - ] && args+=(-crop "$crop" +repage)
  magick "$work/$id.jpg" "${args[@]}" -resize '1280x1280>' -strip -colorspace sRGB -type TrueColor \
    -sampling-factor 4:2:0 -quality 85 "$here/$id.jpg"
  echo "$id.jpg"
done

# Clips: 3 s, H.264 (Main profile), 30 fps, no audio, like the clips of test-media/.
# id  start(s)  scale
clips=(
  "selfie-lowres  20.0 352:640"
  "elder-glasses   9.0 720:1280"
  "selfie-bali    20.0 720:1280"
  "webcam-ladakhi 30.0 1280:720"
  "backlit        30.0 1280:720"
)
for c in "${clips[@]}"; do
  read -r id start scale <<<"$c"
  ffmpeg -nostdin -loglevel error -ss "$start" -t 3 -i "$work/$id.webm" -an \
    -vf "scale=$scale,fps=30" -c:v libx264 -profile:v main -pix_fmt yuv420p -crf 26 -preset slow \
    -g 30 -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact -y "$here/$id.mp4"
  echo "$id.mp4"
done
