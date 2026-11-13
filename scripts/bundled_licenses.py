"""Collect licenses of third-party code shipped inside the desktop bundle."""
from importlib import metadata
from pathlib import Path
import shutil
import sys
import sysconfig

destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
for package in ['qrcode', 'pyinstaller']:
    distribution = metadata.distribution(package)
    for entry in distribution.files or []:
        if 'license' in str(entry).lower() or 'copying' in str(entry).lower():
            source = Path(distribution.locate_file(entry))
            if source.is_file():
                shutil.copyfile(source, destination / f'{package}-{source.name}')
for folder in [Path(sys.base_prefix), Path(sysconfig.get_path('stdlib'))]:
    for name in ['LICENSE.txt', 'LICENSE', 'LICENSE.rst']:
        source = folder / name
        if source.is_file():
            shutil.copyfile(source, destination / 'Python-LICENSE.txt')
            break
if not (destination / 'Python-LICENSE.txt').exists():
    raise SystemExit('Python license missing; supply its license before distributing the bundle.')
root = Path(__file__).resolve().parent.parent
shutil.copyfile(root / 'public/vendor/marked-LICENSE.md', destination / 'Marked-LICENSE.md')
shutil.copytree(root / 'desktop/licenses/python-build-standalone',
                destination / 'python-build-standalone', dirs_exist_ok=True)
