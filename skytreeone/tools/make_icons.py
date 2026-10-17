"""Draw the pixel-art icon (a fir under a moon) and write ext/icons/*.png.

    python tools/make_icons.py
"""
from pathlib import Path
from PIL import Image

ART = [
    "................",
    "..........mm....",
    ".........mmm....",
    "..........mm....",
    ".......g........",
    "......ggg.......",
    ".....gGgGg......",
    "......ggg.......",
    ".....gGggGg.....",
    "....gggGgggg....",
    ".....ggggGg.....",
    "...gGgggggGgg...",
    "..gggGggggggGg..",
    "......bb........",
    "hhhhhhbbhhhhhhhh",
    "hhhhhhhhhhhhhhhh",
]
COL = {
    '.': (21, 29, 40), 'm': (236, 230, 196), 'g': (52, 112, 76), 'G': (96, 160, 104),
    'b': (98, 70, 52), 'h': (34, 58, 48),
}
out = Path(__file__).resolve().parent.parent / 'ext' / 'icons'
out.mkdir(parents=True, exist_ok=True)
base = Image.new('RGBA', (16, 16))
for y, row in enumerate(ART):
    for x, ch in enumerate(row):
        base.putpixel((x, y), COL[ch] + (255,))
for size in (16, 32, 48, 128):
    base.resize((size, size), Image.NEAREST).save(out / f'icon{size}.png')
print('wrote', out)
