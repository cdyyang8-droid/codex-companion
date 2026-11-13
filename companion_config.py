"""Paths shared by source checkouts and the standalone desktop distribution."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
VERSION = (ROOT / 'VERSION').read_text().strip()


def default_runtime_dir():
    override = os.environ.get('COMPANION_DATA_DIR')
    if override:
        return Path(override).expanduser().resolve()
    if getattr(sys, 'frozen', False):
        return Path.home() / 'Library/Application Support/Codex Companion'
    return ROOT / '.runtime'


def apk_path():
    return ROOT / 'dist' / f'codex-companion-{VERSION}.apk'
