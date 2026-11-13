#!/usr/bin/env python3
"""Export only reviewed public sources; never archive the working directory."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from companion_config import VERSION, apk_path

FILES = ['.gitignore', 'VERSION', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
         'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'requirements.txt', 'requirements-build.txt',
         'package.json', 'package-lock.json', 'monitor.py', 'control.py', 'pairing.py',
         'approval_test.py', 'companion_config.py', '启动副屏.command', '启动APK下载.command']
DIRECTORIES = ['public', 'desktop', 'scripts', 'tests', 'docs', '.github', 'android/app/src', 'android/tests']
BLOCKED = {'.runtime', '.android-tools', 'signing', 'node_modules', '__pycache__', '.git', '.venv-build'}
SECRETS = [re.compile(rb'\bsk-[A-Za-z0-9_-]{20,}'), re.compile(rb'\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}'),
           re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')]


def source_files():
    paths = [ROOT / name for name in FILES]
    for folder in DIRECTORIES:
        paths.extend(p for p in (ROOT / folder).rglob('*') if p.is_file())
    return sorted(set(path for path in paths if not any(part in BLOCKED for part in path.relative_to(ROOT).parts)
                      and path.suffix not in {'.pyc', '.log', '.jks', '.keystore', '.key', '.pem'} and path.name != '.DS_Store'))


def main():
    release = ROOT / 'release'
    release.mkdir(exist_ok=True)
    stage = release / 'codex-companion-source'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    manifest = []
    for source in source_files():
        if source.is_symlink():
            raise SystemExit(f'Symlink not allowed in source export: {source.name}')
        data = source.read_bytes()
        if any(pattern.search(data) for pattern in SECRETS):
            raise SystemExit(f'Potential secret in {source.relative_to(ROOT)}; review before release.')
        if re.search(rb'/Users/[A-Za-z0-9._-]+/', data):
            raise SystemExit(f'Local developer path in {source.relative_to(ROOT)}')
        relative = source.relative_to(ROOT)
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest.append({'path': relative.as_posix(), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    (stage / 'SOURCE_MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    archive = release / f'codex-companion-{VERSION}-source.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
        for source in sorted(stage.rglob('*')):
            if source.is_file():
                output.write(source, Path('codex-companion') / source.relative_to(stage))
    if apk_path().is_file():
        shutil.copyfile(apk_path(), release / apk_path().name)
    artifacts = sorted(p for p in release.iterdir() if p.is_file() and p.suffix in {'.zip', '.apk'})
    (release / 'SHA256SUMS.txt').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in artifacts))
    print(f'Clean source: {stage}\nSource archive: {archive.name}\nReviewed source files: {len(manifest)}')


if __name__ == '__main__':
    main()
