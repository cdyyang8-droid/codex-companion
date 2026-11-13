import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import companion_config
from scripts.package_release import source_files


class PackagingTests(unittest.TestCase):
    def test_export_excludes_private_and_generated_files(self):
        files = [path.relative_to(companion_config.ROOT) for path in source_files()]
        self.assertIn(Path('LICENSE'), files)
        self.assertIn(Path('public/vendor/marked-LICENSE.md'), files)
        self.assertIn(Path('desktop/Launcher.swift'), files)
        for path in files:
            self.assertFalse(set(path.parts) & {'.runtime', 'signing', '.android-tools', 'outputs', 'node_modules', '__pycache__', 'build', 'dist'})

    def test_versions_are_consistent(self):
        root = companion_config.ROOT
        android = ET.parse(root / 'android/app/src/main/AndroidManifest.xml').getroot()
        self.assertEqual(android.attrib['{http://schemas.android.com/apk/res/android}versionName'], companion_config.VERSION)
        self.assertEqual(json.loads((root / 'package.json').read_text())['version'], companion_config.VERSION)
        self.assertIn(f'data-page-version="{companion_config.VERSION}"', (root / 'public/index.html').read_text())

    def test_runtime_overrides_and_frozen_data_location(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict('os.environ', {'COMPANION_DATA_DIR': directory}):
                self.assertEqual(companion_config.default_runtime_dir(), Path(directory).resolve())
            with patch.dict('os.environ', {}, clear=True), patch('sys.frozen', True, create=True):
                self.assertEqual(companion_config.default_runtime_dir(), Path.home() / 'Library/Application Support/Codex Companion')


if __name__ == '__main__':
    unittest.main()
