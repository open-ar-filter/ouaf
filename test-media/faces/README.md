# Reference face set

Free-licensed (CC0) faces that `ouaf preview` renders filters on and the browser tests track (#31). They vary what
face tracking and filters meet in practice:

- **Skin tones**: dark, brown, light; **ages**: young adults to people in their eighties.
- **Glasses** (`elder-beard-bw`, `glasses-dim`, `glasses-crowd`, `elder-glasses`, `hand-pencil`), **sunglasses**
  (`sunglasses`), **beards** (`elder-beard-bw`, `side-light`, `full-body`, `dark-frontal`).
- **Head coverings**: hijab, headscarves, sari, headwrap, cap, flower crown.
- **Occlusion**: surgical mask (`mask-hijab`), hand and pencil (`hand-pencil`), hair over a cheek (`three-quarter`).
- **Lighting**: studio, daylight, dim (`glasses-dim`), low-key from above (`shadow-cap`), hard side light
  (`side-light`), night street (`night-phone`), backlit silhouette (`backlit`); black and white photos.
- **Pose and size**: frontal, three-quarter, strict profile (`profile`), looking down, small faces (`full-body`,
  `webcam-ladakhi`); **inputs**: photos up to 1280 px, a 352×640 selfie clip, a landscape 1280×720 webcam clip.

[`all.json`](all.json) is the full set (these files and the licensed clips of `test-media/`), with a description of
each reference and `faces`, the number of faces the reference engine finds on it. Four are hard cases it misses
today (`faces: 0`): `profile` (expected: one eye visible), `side-light`, `hand-pencil` and `night-phone`. A filter
showing nothing there is not a bug of the filter; the browser test (`e2e/preview.spec.ts`) fails when a tracker change
finds more or fewer faces, so that the file is updated with it. [`../references.json`](../references.json), the default
set of `ouaf preview`, is a short selection that renders in about 12 s.

```sh
npx ouaf preview filters/glasses                                      # the default, short set
npx ouaf preview filters/glasses --references test-media/faces/all.json   # every reference (about 35 s)
```

## Credits and licence

All sources are on Wikimedia Commons under **CC0 1.0** (public domain dedication). The photos from Unsplash were
published before June 2017 and those from Pixabay before 2019, when both sites still used CC0; the clips are from
the Wikitongues collection, donated under CC0, and an own work.

| File | Source on Wikimedia Commons | Author | Original source |
|---|---|---|---|
| `dark-frontal.jpg` | [Face portrait (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Face_portrait_%28Unsplash%29.jpg) | William Stitt | [Unsplash](https://unsplash.com/photos/PgSu429ID5o) |
| `flower-crown.jpg` | [Mother Nature, Summer (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Mother_Nature%2C_Summer_%28Unsplash%29.jpg) | Autumn Goodman | [Unsplash](https://unsplash.com/photos/vTL_qy03D1I) |
| `glasses-dim.jpg` | [Irenio Dionzio (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Irenio_Dionzio_%28Unsplash%29.jpg) | Jascha Huisman | [Unsplash](https://unsplash.com/photos/_n2qRG0SvC4) |
| `glasses-crowd.jpg` | [Street portrait of a smiling man with glasses, São Paulo.jpg](https://commons.wikimedia.org/wiki/File:Street_portrait_of_a_smiling_man_with_glasses%2C_S%C3%A3o_Paulo.jpg) | Wilfredor | own work |
| `elder-beard-bw.jpg` | [Man with a white beard and glasses, by Angelina Litvin, 2015-10-05 (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Man_with_a_white_beard_and_glasses%2C_by_Angelina_Litvin%2C_2015-10-05_%28Unsplash%29.jpg) | Angelina Litvin | [Unsplash](https://unsplash.com/photos/52R7t7x8CPI) |
| `elder-smile.jpg` | [Close-up portrait of an old woman.jpg](https://commons.wikimedia.org/wiki/File:Close-up_portrait_of_an_old_woman.jpg) | aunhtet0 | [Pixabay](https://pixabay.com/fr/photos/vieille-dame-sourire-belle-femme-845225/) |
| `elder-sari.jpg` | [Old Indian woman with a sari.jpg](https://commons.wikimedia.org/wiki/File:Old_Indian_woman_with_a_sari.jpg) | Yolanda | [PxHere](https://pxhere.com/en/photo/723482) |
| `headscarf-smile.jpg` | [Smiling older woman in a patterned headscarf in Santa Lucía, Maracaibo, Venezuela.jpg](https://commons.wikimedia.org/wiki/File:Smiling_older_woman_in_a_patterned_headscarf_in_Santa_Luc%C3%ADa%2C_Maracaibo%2C_Venezuela.jpg) | Wilfredor | own work |
| `mask-hijab.jpg` | [Iranian surgical technologist with hijab 01.jpg](https://commons.wikimedia.org/wiki/File:Iranian_surgical_technologist_with_hijab_01.jpg) | SnowBink | own work |
| `full-body.jpg` | [Young North Indian man with beard in white t-shirt.jpg](https://commons.wikimedia.org/wiki/File:Young_North_Indian_man_with_beard_in_white_t-shirt.jpg) | Singhjayreena | own work |
| `night-phone.jpg` | [Asian woman playing with her smartphone outside at night.jpg](https://commons.wikimedia.org/wiki/File:Asian_woman_playing_with_her_smartphone_outside_at_night.jpg) | huweijie07170 | [Pixabay](https://pixabay.com/photos/portrait-night-view-female-woman-787518/) |
| `shadow-cap.jpg` | [Shadowed Portrait (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Shadowed_Portrait_%28Unsplash%29.jpg) | WillSpirit SBLN | [Unsplash](https://unsplash.com/photos/xOeQ71xAWwc) |
| `profile.jpg` | [Woman in a headwrap in Quebec City.jpg](https://commons.wikimedia.org/wiki/File:Woman_in_a_headwrap_in_Quebec_City.jpg) | Wilfredor | own work |
| `sunglasses.jpg` | [Expresion! (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Expresion%21_%28Unsplash%29.jpg) | Rikky Alves | [Unsplash](https://unsplash.com/photos/NmcZ5_4DcRQ) |
| `three-quarter.jpg` | [Soft Curls (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Soft_Curls_%28Unsplash%29.jpg) | Roksolana Zasiadko | [Unsplash](https://unsplash.com/photos/LyeduBb2Auk) |
| `side-light.jpg` | [Bearded man smoking pipe-3013924.jpg](https://commons.wikimedia.org/wiki/File:Bearded_man_smoking_pipe-3013924.jpg) | ThuyHaBich | [Pixabay](https://pixabay.com/en/portrait-old-people-man-scarf-3013924/) |
| `hand-pencil.jpg` | [Laptop and girl biting pencil-pixabay.jpg](https://commons.wikimedia.org/wiki/File:Laptop_and_girl_biting_pencil-pixabay.jpg) | Jan Vašek | [Pixabay](https://pixabay.com/photos/laptop-woman-education-study-young-3087585/) |
| `selfie-lowres.mp4` | [Moise speaking French, English, Lingala, Hunde, Congo Swahili.webm](https://commons.wikimedia.org/wiki/File:Moise_speaking_French%2C_English%2C_Lingala%2C_Hunde%2C_Congo_Swahili.webm) | Wikitongues | [Wikitongues](https://wikitongues.org/videos/moise) |
| `elder-glasses.mp4` | [Lina speaking Calabrese, Savuto variety.webm](https://commons.wikimedia.org/wiki/File:Lina_speaking_Calabrese%2C_Savuto_variety.webm) | Wikitongues | Wikitongues |
| `selfie-bali.mp4` | [Man Speak Bali Aga Balinese dialect.webm](https://commons.wikimedia.org/wiki/File:Man_Speak_Bali_Aga_Balinese_dialect.webm) | ÆleexBali | own work |
| `webcam-ladakhi.mp4` | [Kunzang speaking Ladakhi.webm](https://commons.wikimedia.org/wiki/File:Kunzang_speaking_Ladakhi.webm) | Wikitongues | [Wikitongues](https://wikitongues.org/videos/kunzang) |
| `backlit.mp4` | [Pavel speaking Emilian.webm](https://commons.wikimedia.org/wiki/File:Pavel_speaking_Emilian.webm) | Wikitongues | Wikitongues |

**Changes:** photos scaled down to at most 1280 px on the long side and re-encoded as JPEG (`night-phone` cropped
around the person); clips cut to 3 s, audio removed, scaled (`elder-glasses` and `selfie-bali` to 720×1280,
`webcam-ladakhi` and `backlit` to 1280×720, `selfie-lowres` kept at 352×640) and re-encoded to H.264. These files
are distributed under CC0 1.0 like their sources; this folder is not covered by the repository's Apache-2.0 licence.
The JSON sets are under the repository's licence.

The people shown appear in photos and videos their authors published under CC0; the files are used only to test face
tracking and to show what a filter does, never for identification or face recognition. Do not use them to train or
evaluate identification models, and do not add a photo of a real person whose licence is not CC0, public domain or
CC BY (`AGENTS.md`, test media).

## Rebuilding

[`make.sh`](make.sh) downloads the sources (pinned SHA-256) from Wikimedia Commons and recreates the files with
ImageMagick and ffmpeg.
