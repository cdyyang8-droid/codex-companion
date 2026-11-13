#!/usr/bin/env python3
"""Build a Python-free macOS menu-bar app and a user distribution ZIP."""
import hashlib
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from companion_config import VERSION, apk_path


def run(*args):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('Build the macOS app on macOS. See docs/DEVELOPMENT.md.')
    if not apk_path().is_file():
        raise SystemExit('Build Android first: python3 scripts/build_apk.py')
    build = ROOT / 'build' / 'desktop'
    build.mkdir(parents=True, exist_ok=True)
    os.environ['PYINSTALLER_CONFIG_DIR'] = str(build / 'pyinstaller-cache')
    backend = build / 'backend'
    # Stage only application modules, without development data or credentials.
    packaged_source = build / 'source'
    packaged_source.mkdir(exist_ok=True)
    for module in ['monitor.py', 'pairing.py', 'control.py', 'approval_test.py', 'companion_config.py']:
        shutil.copyfile(ROOT / module, packaged_source / module)
    shutil.copyfile(ROOT / 'scripts/desktop_server.py', packaged_source / 'desktop_server.py')
    command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
               '--name', 'companion-server', '--distpath', str(backend), '--workpath', str(build / 'work'),
               '--specpath', str(build), '--paths', str(packaged_source),
               '--add-data', f'{ROOT / "public"}:public', '--add-data', f'{ROOT / "VERSION"}:.',
               '--add-data', f'{apk_path()}:dist', '--hidden-import', 'qrcode.image.svg',
               str(packaged_source / 'desktop_server.py')]
    run(*command)
    app = build / 'Codex Companion.app'
    if app.exists():
        shutil.rmtree(app)
    macos = app / 'Contents/MacOS'
    resources = app / 'Contents/Resources'
    macos.mkdir(parents=True)
    resources.mkdir()
    shutil.copytree(backend / 'companion-server', resources / 'backend/companion-server', symlinks=True)
    with (app / 'Contents/Info.plist').open('wb') as stream:
        plistlib.dump({'CFBundleName': 'Codex Companion', 'CFBundleDisplayName': 'Codex 副屏',
                      'CFBundleIdentifier': 'cn.codex.companion.desktop', 'CFBundleExecutable': 'CodexCompanion',
                      'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': VERSION,
                      'CFBundleVersion': VERSION, 'LSUIElement': True, 'LSMinimumSystemVersion': '13.0'}, stream)
    env = os.environ.copy()
    env['CLANG_MODULE_CACHE_PATH'] = str(build / 'module-cache')
    env['SWIFT_MODULECACHE_PATH'] = str(build / 'module-cache')
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O', '-framework', 'AppKit',
                    '-target', f'{platform.machine()}-apple-macos13.0', str(ROOT / 'desktop/Launcher.swift'),
                    '-o', str(macos / 'CodexCompanion')], env=env, cwd=ROOT, check=True)
    run('codesign', '--force', '--deep', '--sign', '-', app)
    run('codesign', '--verify', '--deep', '--strict', app)
    release = ROOT / 'release'
    release.mkdir(exist_ok=True)
    stage = build / 'user-package'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    shutil.copytree(app, stage / app.name, symlinks=True)
    for file in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
        shutil.copyfile(ROOT / file, stage / file)
    shutil.copyfile(ROOT / 'docs/QUICKSTART.md', stage / '使用说明.md')
    shutil.copyfile(apk_path(), stage / apk_path().name)
    # Include licenses for libraries bundled into the Python executable.
    run(sys.executable, ROOT / 'scripts/bundled_licenses.py', stage / 'licenses')
    arch = 'apple-silicon' if platform.machine() == 'arm64' else 'intel'
    archive = release / f'codex-companion-{VERSION}-macos-{arch}.zip'
    run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', stage, archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + '.sha256').write_text(f'{digest}  {archive.name}\n')
    print(f'Built {archive.name} ({archive.stat().st_size / 1024 / 1024:.1f} MB)')


if __name__ == '__main__':
    main()
