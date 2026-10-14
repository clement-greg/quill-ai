"""Font work for subset-icons.mjs (needs: pip install fonttools brotli).

  subset-icons.py names  SOURCE.woff2 NAMES.json
      Writes every icon name the font understands, including legacy aliases
      such as "expand_more" that material-symbols' index.d.ts leaves out.
  subset-icons.py subset SOURCE.woff2 OUTPUT.woff2 ICONS.json
      Writes a font holding only the listed icons.
"""
import json
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def ligatures(font):
    """Maps each icon name to its glyph. Icon names are ligatures spelled from
    letter glyphs, and glyph names don't always match them, so read GSUB."""
    char_of = {glyph: chr(code) for code, glyph in font.getBestCmap().items()}
    result = {}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for table in lookup.SubTable:
            table = getattr(table, 'ExtSubTable', table)
            for first, ligs in getattr(table, 'ligatures', {}).items():
                for lig in ligs:
                    spelled = ''.join(char_of.get(g, '\0') for g in [first, *lig.Component])
                    if '\0' not in spelled:
                        result[spelled] = lig.LigGlyph
    return result


def write_names(source, names_out):
    with open(names_out, 'w') as f:
        json.dump(sorted(ligatures(TTFont(source))), f, indent=0)
        f.write('\n')


def write_subset(source, output, manifest):
    wanted = set(json.load(open(manifest)))
    font = TTFont(source)
    # Nothing in the app sets font-variation-settings, so pin every axis to its default.
    font = instancer.instantiateVariableFont(font, {'FILL': 0, 'wght': 400, 'GRAD': 0, 'opsz': 24})
    glyphs = {name: glyph for name, glyph in ligatures(font).items() if name in wanted}
    missing = sorted(wanted - glyphs.keys())
    if missing:
        sys.exit(f'No ligature for: {", ".join(missing)}')

    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['rlig', 'rclt']
    # Without this, every ligature spelled from the kept letters (all of them) survives.
    options.layout_closure = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(text='abcdefghijklmnopqrstuvwxyz0123456789_', glyphs=set(glyphs.values()))
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(output)


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    {'names': write_names, 'subset': write_subset}[command](*args)
