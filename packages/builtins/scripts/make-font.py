"""Instantiates a variable font at fixed axis values and subsets it into a WOFF2 file.

    python3 -I make-font.py <in.ttf> <out.woff2> <axis=value,...> <unicode-ranges>

Example: make-font.py Inter.ttf sans-bold.woff2 wght=700,opsz=14 U+0000-00FF,U+0100-024F

Requires fontTools with brotli (`pip install fonttools brotli`). See make.sh.
"""
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def parse_ranges(spec: str) -> list[int]:
    cps: list[int] = []
    for part in spec.split(','):
        lo, _, hi = part.strip().removeprefix('U+').partition('-')
        cps.extend(range(int(lo, 16), int(hi or lo, 16) + 1))
    return cps


def main():
    src, dst, axes_spec, ranges = sys.argv[1:5]
    font = TTFont(src)
    if 'fvar' in font:
        axes = {k: float(v) for k, v in (a.split('=') for a in axes_spec.split(','))}
        # Pin every axis (defaults for the ones not given) to get a static font.
        for axis in font['fvar'].axes:
            axes.setdefault(axis.axisTag, axis.defaultValue)
        try:
            font = instancer.instantiateVariableFont(font, axes, updateFontNames=True)
        except ValueError:  # no STAT entry for that location: keep the family's names
            font = instancer.instantiateVariableFont(TTFont(src), axes)
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']  # keep kerning, ligatures, contextual alternates, case forms...
    options.name_IDs = ['*']  # keep the copyright and licence entries (OFL)
    options.name_languages = ['*']
    options.notdef_outline = True
    options.hinting = False  # no TrueType hinting: text is rasterized by the browser at display size
    options.desubroutinize = True
    sub = subset.Subsetter(options)
    sub.populate(unicodes=parse_ranges(ranges))
    sub.subset(font)
    font.flavor = 'woff2'
    font.recalcTimestamp = False  # keep the upstream date: reproducible output
    font.save(dst)


main()
