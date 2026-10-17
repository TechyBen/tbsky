"""Build the unpacked extension into dist/skytreeone.

Extensions (Manifest V3) can't load code from a CDN or use inline import maps,
so this copies playtreeone (web/) next to local copies of three.js and lil-gui
(vendor/) and rewrites the bare imports to relative paths.

    python build.py
"""
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB, EXT, VENDOR = ROOT / 'web', ROOT / 'ext', ROOT / 'vendor'
OUT = ROOT / 'dist' / 'skytreeone'

IMPORTS = {
    'three': '../vendor/three.module.js',
    'three/addons/controls/OrbitControls.js': '../vendor/OrbitControls.js',
    'lil-gui': '../vendor/lil-gui.esm.min.js',
}


def rewrite(text, table):
    def sub(m):
        return m.group(1) + table.get(m.group(2), m.group(2)) + m.group(3)
    return re.sub(r"""(from\s+['"])([^'"]+)(['"])""", sub, text)


def main():
    if not (WEB / 'src' / 'main.js').exists():
        raise SystemExit('web/ is empty: run  git submodule update --init')
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(EXT, OUT)

    # tree/: the playtreeone page, without its CDN import map, plus the bridge.
    tree = OUT / 'tree'
    (tree / 'src').mkdir(parents=True)
    for js in (WEB / 'src').glob('*.js'):
        (tree / 'src' / js.name).write_text(rewrite(js.read_text('utf-8'), IMPORTS), 'utf-8')
    html = (WEB / 'index.html').read_text('utf-8')
    html, n = re.subn(r'<script type="importmap">.*?</script>\s*', '', html, flags=re.S)
    if n != 1:
        raise SystemExit('index.html: import map not found')
    html = html.replace('<script type="module" src="src/main.js"></script>',
                        '<script type="module" src="src/main.js"></script>\n'
                        '<script type="module" src="bridge.js"></script>')
    (tree / 'index.html').write_text(html, 'utf-8')
    shutil.move(OUT / 'bridge.js', tree / 'bridge.js')

    vendor = tree / 'vendor'
    vendor.mkdir()
    for f in VENDOR.iterdir():
        text = f.read_text('utf-8')
        if f.name == 'OrbitControls.js':
            text = rewrite(text, {'three': './three.module.js'})
        (vendor / f.name).write_text(text, 'utf-8')

    lic = OUT / 'licenses'
    lic.mkdir()
    shutil.copy(WEB / 'licenses' / 'd3-celestial.txt', lic)
    for f in VENDOR.glob('LICENSE-*'):
        shutil.copy(f, lic)

    left = [str(p.relative_to(OUT)) for p in tree.rglob('*.js')
            if re.search(r"""from\s+['"](three|lil-gui)""", p.read_text('utf-8'))]
    if left:
        raise SystemExit(f'bare imports left in: {left}')
    print(f'built {OUT}')


if __name__ == '__main__':
    main()
