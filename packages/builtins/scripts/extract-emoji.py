"""Extracts the emoji images of Noto Color Emoji (CBDT/CBLC bitmap font) into one PNG per emoji.

    python3 -I extract-emoji.py <NotoColorEmoji.ttf> <emoji-test.txt> <emoji_aliases.txt> <fonts-dir> <out-dir>

Writes `<out-dir>/<key>.png` (the font's PNG bytes, untouched) and `<out-dir>/index.json`, for every emoji of the
Unicode RGI set (`emoji-test.txt`: fully-qualified and component sequences) that the font draws. A key is the
emoji's code points in lowercase hex without padding, joined by "-", with U+FE0F removed (e.g. "1f600", "23-20e3",
"1f468-200d-1f469-200d-1f467"). RGI sequences drawn with the same image as another one are listed under "aliases"
(Noto's `emoji_aliases.txt` picks which one owns the file).

Emoji with a default text presentation (©, ❤, ☺…) are drawn from the set even without U+FE0F, so they look the same
on every device: the built-in text fonts do not have them and system fonts differ. The exceptions, listed under
"text", are the ones every built-in font of `<fonts-dir>` draws (©, ®, ™): they stay text unless followed by U+FE0F.

Requires fontTools (`pip install fonttools`). See make.sh.
"""
import glob
import json
import os
import sys

from fontTools.ttLib import TTFont

VS16 = 0xFE0F


def key_of(cps):
    return '-'.join('%x' % cp for cp in cps if cp != VS16)


def read_rgi(path):
    """RGI sequences (key -> code points) and the code points whose default presentation is text."""
    rgi, text = {}, []
    with open(path, encoding='utf-8') as f:
        for line in f:
            data, _, comment = line.partition('#')
            if ';' not in data:
                continue
            seq, status = (s.strip() for s in data.split(';'))
            if status not in ('fully-qualified', 'component'):
                continue
            cps = [int(h, 16) for h in seq.split()]
            rgi[key_of(cps)] = cps
            # A single code point that needs U+FE0F to be an emoji ("263a fe0f" is fully qualified).
            if len(cps) == 2 and cps[1] == VS16:
                text.append('%x' % cps[0])
    return rgi, sorted(text)


def read_aliases(path):
    """Noto's alias table: keys drawn with another key's image."""
    out = set()
    with open(path, encoding='utf-8') as f:
        for line in f:
            data = line.partition('#')[0].strip()
            if ';' in data:
                out.add(data.split(';')[0].strip().replace('_', '-'))
    return out


def main():
    font_path, test_path, aliases_path, fonts_dir, out_dir = sys.argv[1:6]
    rgi, text = read_rgi(test_path)
    text_fonts = [set(TTFont(f).getBestCmap()) for f in sorted(glob.glob(os.path.join(fonts_dir, '*.woff2')))]
    assert text_fonts, f'no built-in font in {fonts_dir}: build the fonts first'
    text = [k for k in text if all(int(k, 16) in cmap for cmap in text_fonts)]
    noto_aliases = read_aliases(aliases_path)
    font = TTFont(font_path)
    strike = font['CBDT'].strikeData[0]
    size = font['CBLC'].strikes[0].bitmapSizeTable
    cmap = font.getBestCmap()
    glyph_cp = {}
    for cp, glyph in cmap.items():
        glyph_cp.setdefault(glyph, cp)

    # key -> glyph name, for the single code points (cmap) and the sequences (ligatures of the first `ccmp` lookup:
    # keycaps, modifiers, ZWJ sequences, flags).
    glyph_of = {'%x' % cp: glyph for cp, glyph in cmap.items()}
    gsub = font['GSUB'].table
    ccmp = next(fr.Feature for fr in gsub.FeatureList.FeatureRecord if fr.FeatureTag == 'ccmp')
    lookup = gsub.LookupList.Lookup[ccmp.LookupListIndex[0]]
    assert lookup.LookupType == 4, 'expected the ligature lookup first'
    for sub in lookup.SubTable:
        for first, ligs in sub.ligatures.items():
            for lig in ligs:
                glyph_of.setdefault(key_of(glyph_cp[g] for g in [first] + lig.Component), lig.LigGlyph)

    # glyph -> RGI keys drawn with it
    by_glyph, missing = {}, []
    for key in rgi:
        glyph = glyph_of.get(key)
        if glyph is None or glyph not in strike:
            missing.append(key)
        else:
            by_glyph.setdefault(glyph, []).append(key)

    os.makedirs(out_dir, exist_ok=True)
    for name in os.listdir(out_dir):
        if name.endswith('.png'):
            os.remove(os.path.join(out_dir, name))
    keys, aliases, cell = [], {}, None
    for glyph, glyph_keys in by_glyph.items():
        glyph_keys.sort(key=lambda k: (k in noto_aliases, k.count('-'), k))
        key = glyph_keys[0]
        bitmap = strike[glyph]
        m = bitmap.metrics
        metrics = {'width': m.width, 'height': m.height, 'bearingX': m.BearingX, 'bearingY': m.BearingY,
                   'advance': m.Advance}
        assert cell is None or cell == metrics, f'{glyph}: all bitmaps must share one cell'
        assert bitmap.imageData[:8] == b'\x89PNG\r\n\x1a\n', f'{glyph}: not a PNG'
        cell = metrics
        with open(os.path.join(out_dir, f'{key}.png'), 'wb') as out:
            out.write(bitmap.imageData)
        keys.append(key)
        for alias in glyph_keys[1:]:
            aliases[alias] = key

    index = {
        'source': 'Noto Color Emoji ' + font['name'].getDebugName(5),
        'format': 'png',
        # Pixel metrics shared by every image, at `ppem` pixels per em (the font's bitmap strike): the image's
        # top-left corner is `bearingX` px right of the pen and `bearingY` px above the baseline, then the pen
        # advances by `advance` px. Scale by fontSize / ppem.
        'ppem': size.ppemY,
        **cell,
        'emoji': sorted(keys),
        'aliases': dict(sorted(aliases.items())),
        # Single code points drawn as emoji only when followed by U+FE0F: the text-default emoji that every built-in
        # font draws.
        'text': [k for k in text if k in aliases or k in keys],
        # RGI sequences the font does not draw (fall back to text).
        'missing': sorted(missing),
    }
    with open(os.path.join(out_dir, 'index.json'), 'w') as out:
        json.dump(index, out, separators=(',', ':'))
        out.write('\n')
    print(f'{len(keys)} images, {len(aliases)} aliases, {len(missing)} RGI sequences missing -> {out_dir}')


main()
