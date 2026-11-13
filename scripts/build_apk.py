#!/usr/bin/env python3
"""Build with the official Android SDK and JDK, without Gradle dependencies."""
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from companion_config import VERSION
TOOLS = ROOT / '.android-tools'
SOURCE = ROOT / 'android/app/src/main'
BUILD = ROOT / 'android/build'
OUTPUT = ROOT / 'dist'


def run(command, **options):
    subprocess.run([str(part) for part in command], cwd=ROOT, check=True, **options)


def main():
    java_home = Path(os.environ.get('COMPANION_JAVA_HOME', str(TOOLS / 'jdk/jdk-17.0.21+9/Contents/Home')))
    build_tools = Path(os.environ.get('COMPANION_ANDROID_BUILD_TOOLS', str(TOOLS / 'build-tools/android-15')))
    android_jar = Path(os.environ.get('COMPANION_ANDROID_JAR', str(TOOLS / 'platform/android-35/android.jar')))
    for target in [java_home / 'bin/javac', build_tools / 'aapt2', android_jar]:
        if not target.exists():
            raise SystemExit(f'Missing Android build tool: {target}')
    os.environ['JAVA_HOME'] = str(java_home)
    os.environ['PATH'] = str(java_home / 'bin') + os.pathsep + os.environ['PATH']
    for target in [BUILD / 'classes', BUILD / 'dex', BUILD / 'test-classes', OUTPUT]:
        target.mkdir(parents=True, exist_ok=True)
    # Test the address trust boundary with the same JVM source used by the APK.
    run([java_home / 'bin/javac', '-d', BUILD / 'test-classes', SOURCE / 'java/cn/codex/companion/PairingAddress.java', ROOT / 'android/tests/PairingAddressTest.java'])
    run([java_home / 'bin/java', '-cp', BUILD / 'test-classes', 'cn.codex.companion.PairingAddressTest'])
    run([build_tools / 'aapt2', 'compile', '--dir', SOURCE / 'res', '-o', BUILD / 'resources.zip'])
    run([build_tools / 'aapt2', 'link', '-I', android_jar, '--manifest', SOURCE / 'AndroidManifest.xml', '-o', BUILD / 'base.apk', '--min-sdk-version', '26', '--target-sdk-version', '35', BUILD / 'resources.zip'])
    java_files = sorted((SOURCE / 'java').rglob('*.java'))
    run([java_home / 'bin/javac', '-source', '8', '-target', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-bootclasspath', str(android_jar) + os.pathsep + str(build_tools / 'core-lambda-stubs.jar'), '-d', BUILD / 'classes', *java_files])
    class_files = sorted((BUILD / 'classes').rglob('*.class'))
    run([java_home / 'bin/java', '-cp', build_tools / 'lib/d8.jar', 'com.android.tools.r8.D8', '--release', '--min-api', '26', '--lib', android_jar, '--output', BUILD / 'dex', *class_files])
    unsigned = BUILD / 'unsigned.apk'
    shutil.copyfile(BUILD / 'base.apk', unsigned)
    with zipfile.ZipFile(unsigned, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
        for dex in sorted((BUILD / 'dex').glob('*.dex')):
            archive.write(dex, dex.name)
    run([build_tools / 'zipalign', '-f', '-p', '4', unsigned, BUILD / 'aligned.apk'])
    signing = ROOT / 'android/signing'
    signing.mkdir(exist_ok=True, mode=0o700)
    keystore = signing / 'companion.jks'
    password_file = signing / 'password.txt'
    if not keystore.exists():
        if not password_file.exists():
            password_file.write_text(secrets.token_urlsafe(32))
            password_file.chmod(0o600)
        run([java_home / 'bin/keytool', '-genkeypair', '-noprompt', '-keystore', keystore, '-storepass:file', password_file, '-keypass:file', password_file, '-alias', 'companion', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Codex Companion Personal, O=Personal, C=CN'])
        keystore.chmod(0o600)
    apk = OUTPUT / f'codex-companion-{VERSION}.apk'
    signer = [java_home / 'bin/java', '-jar', build_tools / 'lib/apksigner.jar']
    run([*signer, 'sign', '--ks', keystore, '--ks-pass', f'file:{password_file}', '--ks-key-alias', 'companion', '--out', apk, BUILD / 'aligned.apk'])
    run([*signer, 'verify', '--verbose', apk])
    run([build_tools / 'zipalign', '-c', '-v', '4', apk], stdout=subprocess.DEVNULL)
    run([build_tools / 'aapt2', 'dump', 'badging', apk])
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    (OUTPUT / (apk.name + '.sha256')).write_text(f'{digest}  {apk.name}\n')
    print(f'APK ready: {apk}\nSize: {apk.stat().st_size:,} bytes\nSHA-256: {digest}')


if __name__ == '__main__':
    main()
