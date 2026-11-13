"""Persistent device pairing, short-lived six-digit codes and attempt limits."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
import uuid


class PairingError(Exception):
    def __init__(self, message, status=401):
        super().__init__(message)
        self.status = status


class DevicePairing:
    CODE_LIFETIME = 10 * 60
    DEVICE_LIFETIME = 365 * 24 * 60 * 60

    def __init__(self, directory, name, clock=time.time):
        self.path = Path(directory) / 'devices.json'
        self.lock = threading.RLock()
        self.clock = clock
        self.name = name
        self.code = None
        self.code_expires = 0
        self.attempts = {}
        self.global_attempts = []
        self.data = {'serverId': str(uuid.uuid4()), 'devices': {}}
        if self.path.exists():
            # Fail visibly if the pairing store is corrupt; never silently trust a reset.
            loaded = json.loads(self.path.read_text())
            if not isinstance(loaded.get('devices'), dict) or not isinstance(loaded.get('serverId'), str):
                raise ValueError('设备配对文件损坏，请保留备份后重新配对。')
            self.data = loaded
        self._save()

    @property
    def server_id(self):
        return self.data['serverId']

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix('.tmp')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(self.data, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.path)
        self.path.chmod(0o600)

    @staticmethod
    def _hash(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def info(self, rotate=False):
        with self.lock:
            now = self.clock()
            if rotate or not self.code or self.code_expires <= now:
                self.code = f'{secrets.randbelow(1000000):06d}'
                self.code_expires = now + self.CODE_LIFETIME
            devices = [dict(id=value['id'], name=value['name'], pairedAt=value['pairedAt'], expiresAt=value['expiresAt']) for value in self.data['devices'].values() if value['expiresAt'] > now]
            return {'code': self.code, 'expiresAt': self.code_expires, 'serverId': self.server_id, 'computerName': self.name, 'devices': devices}

    def _limit(self, client):
        now = self.clock()
        self.attempts = {key: [stamp for stamp in values if stamp > now - 300] for key, values in self.attempts.items() if any(stamp > now - 300 for stamp in values)}
        self.global_attempts = [stamp for stamp in self.global_attempts if stamp > now - 300]
        recent = self.attempts.setdefault(client, [])
        if len(recent) >= 5 or len(self.global_attempts) >= 30:
            raise PairingError('尝试过于频繁，请在 5 分钟后重试。', 429)
        recent.append(now)
        self.global_attempts.append(now)

    def pair_code(self, code, name, client):
        with self.lock:
            self._limit(client)
            if not isinstance(code, str) or not re.fullmatch(r'[0-9]{6}', code) or not self.code or self.code_expires <= self.clock() or not hmac.compare_digest(code, self.code):
                raise PairingError('配对码不正确或已过期，请查看电脑上的新配对码。')
            token = self.issue(name)
            # Successful pairing consumes the short code. Other devices need a new code.
            self.code = None
            self.code_expires = 0
            return token

    def issue(self, name='手机或浏览器'):
        with self.lock:
            token = secrets.token_urlsafe(32)
            now = self.clock()
            self.data['devices'] = {key: value for key, value in self.data['devices'].items() if value['expiresAt'] > now}
            label = re.sub(r'[\x00-\x1f\x7f]', '', str(name))[:60].strip() or '手机或浏览器'
            self.data['devices'][self._hash(token)] = {'id': str(uuid.uuid4()), 'name': label, 'pairedAt': now, 'expiresAt': now + self.DEVICE_LIFETIME}
            self._save()
            return token

    def authorized(self, token):
        if not isinstance(token, str) or not 32 <= len(token) <= 256:
            return False
        with self.lock:
            record = self.data['devices'].get(self._hash(token))
            return bool(record and record['expiresAt'] > self.clock())

    def revoke(self, device_id):
        with self.lock:
            matching = [key for key, value in self.data['devices'].items() if value['id'] == device_id]
            for key in matching:
                del self.data['devices'][key]
            if matching:
                self._save()
            return bool(matching)
