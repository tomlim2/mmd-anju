"""Stage tracked runtime files and validate deployment without a bundler."""

import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '_site'


def main():
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    public = [name for name in tracked if name == 'index.html' or name.startswith(('js/', 'vendor/', 'samples/'))]
    if OUTPUT.is_symlink():
        raise ValueError('Output must not be a symlink')
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    for name in public:
        source = ROOT / name
        if source.is_symlink() or not source.resolve().is_relative_to(ROOT):
            raise ValueError(f'Unsafe source: {name}')
        target = OUTPUT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    (OUTPUT / '.nojekyll').touch()

    def require(path):
        path = path.resolve()
        if not path.is_relative_to(OUTPUT) or not path.is_file():
            raise ValueError(f'Missing or invalid deployment file: {path}')

    require(OUTPUT / 'index.html')
    require(OUTPUT / 'js/main.js')
    count = 0
    # Check relative static and dynamic ES module imports and JavaScript syntax.
    for path in sorted(OUTPUT.rglob('*.js')):
        code = path.read_text()
        result = subprocess.run(['node', '--input-type=module', '--check'], input=code, text=True, capture_output=True)
        if result.returncode:
            raise ValueError(f'Invalid JavaScript: {path.relative_to(OUTPUT)}\n{result.stderr}')
        for relative in re.findall(r'''(?:from\s*|import\s*\(\s*|import\s*)['"](\.{1,2}/[^'"]+)['"]''', code):
            require(path.parent / relative)
        count += 1
    sample_count = 0
    for kind, keys in [('pmx', ('path',)), ('vmd', ('vmd', 'audio'))]:
        manifest = OUTPUT / 'samples' / kind / 'manifest.json'
        require(manifest)
        entries = json.loads(manifest.read_text())
        if not isinstance(entries, list):
            raise ValueError(f'Expected sample list: {manifest}')
        for entry in entries:
            if entry.get('deployed') is False:
                continue
            required = keys[0]
            if not entry.get(required):
                raise ValueError(f'Missing {required} in {manifest}: {entry}')
            for key in keys:
                if entry.get(key):
                    require(manifest.parent / entry[key])
            sample_count += 1
    print(f'Published {len(public)} tracked runtime files; checked {count} JavaScript files and {sample_count} sample entries.')


if __name__ == '__main__':
    main()
