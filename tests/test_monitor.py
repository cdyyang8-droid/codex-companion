import copy
import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import socket
import struct
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from monitor import DesktopStream, Handler, Monitor, apply_patches, item_event, normalized_request, redact
from pairing import DevicePairing, PairingError
from control import RemoteActions, ActionError, request_fingerprint


class PairingTests(unittest.TestCase):
    def test_device_survives_restart_and_can_be_revoked(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [1000]
            store = DevicePairing(directory, 'Test Mac', clock=lambda: now[0])
            code = store.info()['code']
            self.assertRegex(code, r'^\d{6}$')
            token = store.pair_code(code, 'My Phone', '192.168.0.2')
            self.assertNotIn(token, (Path(directory) / 'devices.json').read_text())
            restored = DevicePairing(directory, 'Test Mac', clock=lambda: now[0])
            self.assertEqual(store.server_id, restored.server_id)
            self.assertTrue(restored.authorized(token))
            device = restored.info()['devices'][0]
            restored.revoke(device['id'])
            self.assertFalse(restored.authorized(token))
            self.assertFalse(DevicePairing(directory, 'Test Mac').authorized(token))

    def test_short_code_expiry_consumption_and_attempt_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [1000]
            store = DevicePairing(directory, 'Mac', clock=lambda: now[0])
            code = store.info()['code']
            store.pair_code(code, 'Phone', 'client-1')
            with self.assertRaises(PairingError):
                store.pair_code(code, 'Phone', 'client-2')
            code = store.info()['code']
            now[0] += store.CODE_LIFETIME + 1
            with self.assertRaises(PairingError):
                store.pair_code(code, 'Phone', 'client-2')
            for _ in range(5):
                with self.assertRaises(PairingError):
                    store.pair_code('wrong', 'Phone', 'attacker')
            with self.assertRaises(PairingError) as error:
                store.pair_code(store.info()['code'], 'Phone', 'attacker')
            self.assertEqual(error.exception.status, 429)
            now[0] += 301
            token = store.pair_code(store.info()['code'], 'Phone', 'attacker')
            self.assertTrue(store.authorized(token))
            now[0] += store.DEVICE_LIFETIME + 1
            self.assertFalse(store.authorized(token))


class Fixture:
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.now = int(time.time())
        state = sqlite3.connect(self.root / 'state_5.sqlite')
        state.execute('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,source TEXT,updated_at INTEGER,created_at INTEGER,archived INTEGER,model TEXT)')
        rows = [('active', '写一个页面', 'vscode'), ('done', '已经结束', 'vscode'), ('error', '任务报错', 'vscode'), ('stale', '旧的执行记录', 'vscode'), ('guardian', 'Guardian review', '{"subagent":{}}')]
        for tid, title, source in rows:
            state.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)', (tid, title, '/projects/example', source, self.now - (600 if tid == 'stale' else 0), self.now - 700, 0, 'codex-model'))
        state.commit()
        state.close()
        history = sqlite3.connect(self.root / 'thread_history_1.sqlite')
        history.execute('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,error_json TEXT,rollout_ordinal INTEGER)')
        history.execute('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER,rollout_ordinal INTEGER)')
        for tid, status in [('active', 'inProgress'), ('done', 'completed'), ('error', 'failed'), ('stale', 'inProgress')]:
            history.execute('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?)', (tid, 'turn-' + tid, status, self.now - 100, self.now if status in ['completed', 'failed'] else None, 'failed' if status == 'failed' else None, 1))
        for i, item in enumerate([
            {'type': 'agentMessage', 'id': 'message', 'text': '已完成首页，正在验证布局。', 'phase': 'commentary'},
            {'type': 'commandExecution', 'id': 'command', 'command': 'npm run build', 'exitCode': 1, 'status': 'failed', 'aggregatedOutput': 'build failed'},
            {'type': 'userMessage', 'id': 'user', 'content': [{'type': 'text', 'text': 'private user prompt'}]},
            {'type': 'reasoning', 'id': 'rs', 'content': ['private reasoning']},
        ]):
            history.execute('INSERT INTO thread_items VALUES(?,?,?,?,?,?)', ('active', 'turn-active', item['type'], json.dumps(item), self.now * 1000, i))
        history.commit()
        history.close()
        self.stream = DesktopStream(self.root)
        self.monitor = Monitor(self.root, self.stream)

    def clean(self):
        self.directory.cleanup()


class StateTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()

    def tearDown(self):
        self.fixture.clean()

    def test_command_failure_does_not_mark_running_task_as_failed(self):
        data = self.fixture.monitor.collect()
        threads = {t['id']: t for t in data['threads']}
        self.assertEqual(threads['active']['status'], 'running')
        self.assertEqual(threads['done']['status'], 'completed')
        self.assertEqual(threads['error']['status'], 'error')
        self.assertEqual(threads['stale']['status'], 'unknown')
        self.assertNotIn('guardian', threads)
        self.assertNotIn('private user prompt', json.dumps(data))
        self.assertNotIn('private reasoning', json.dumps(data))
        self.assertEqual(data['source'], 'history')

    def test_waiting_request_turns_yellow_then_clears(self):
        f = self.fixture
        f.stream.connected = True
        snapshot = {'state': {'threadRuntimeStatus': {'type': 'active', 'activeFlags': ['waitingOnApproval']}, 'requests': [{'id': 'req-7', 'method': 'item/commandExecution/requestApproval', 'params': {'reason': '需要联网下载依赖', 'command': 'npm install'}}]}, 'revision': 1, 'owner': 'desktop', 'at': time.time()}
        f.stream.snapshots['active'] = snapshot
        data = f.monitor.collect()
        self.assertEqual(data['threads'][0]['status'], 'approval')
        self.assertEqual(data['threads'][0]['requests'][0]['id'], 'req-7')
        snapshot['state']['requests'] = []
        snapshot['state']['threadRuntimeStatus']['activeFlags'] = []
        self.assertEqual(next(t for t in f.monitor.collect()['threads'] if t['id'] == 'active')['status'], 'running')

    def test_state_files_are_never_modified(self):
        files = list(self.fixture.root.glob('*.sqlite'))
        original = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        self.fixture.monitor.collect()
        self.assertEqual(original, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in files})
        with self.fixture.monitor.connect_db('state_*.sqlite') as db:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("UPDATE threads SET title='changed'")

    def test_corrupt_history_degrades_and_does_not_look_completed(self):
        self.fixture.monitor.refresh()
        (self.fixture.root / 'thread_history_1.sqlite').write_bytes(b'broken db')
        self.fixture.monitor.refresh()
        result = self.fixture.monitor.get()
        self.assertEqual(result['source'], 'unavailable')
        self.assertTrue(result['threads'])
        self.assertEqual(next(t for t in result['threads'] if t['id'] == 'active')['status'], 'running')

    def test_redaction_and_public_event_exclusions(self):
        self.assertNotIn('sk-' + 'a' * 36, redact('key: sk-' + 'a' * 36))
        self.assertNotIn('secretpass', redact('password=secretpass'))
        self.assertNotIn('abcxyz1234567890', redact('Bearer abcxyz1234567890'))
        self.assertIsNone(item_event({'type': 'reasoning', 'content': ['private']}))
        self.assertIsNone(item_event({'type': 'userMessage', 'content': ['private']}))
        self.assertIsNone(normalized_request({'method': 'account/chatgptAuthTokens/refresh', 'params': {}}))


class StreamTests(unittest.TestCase):
    def test_action_frames_route_to_owner_and_wait_for_matching_response(self):
        stream = DesktopStream(Path('/tmp/not-real'))
        client, owner = socket.socketpair()
        stream.socket, stream.connected, stream.client_id = client, True, 'phone'
        result = []
        worker = threading.Thread(target=lambda: result.append(stream.request('thread-follower-command-approval-decision', {'conversationId': 'thread', 'requestId': 7, 'decision': 'decline'}, 'desktop', timeout=1)))
        try:
            worker.start()
            size = struct.unpack('<I', stream._exact(owner, 4))[0]
            request = json.loads(stream._exact(owner, size))
            self.assertEqual(request['targetClientId'], 'desktop')
            self.assertEqual(request['version'], 1)
            self.assertEqual(request['params']['decision'], 'decline')
            stream._handle({'type': 'response', 'requestId': 'wrong', 'resultType': 'success'})
            self.assertTrue(worker.is_alive())
            stream._handle({'type': 'response', 'requestId': request['requestId'], 'method': request['method'], 'resultType': 'success', 'handledByClientId': 'desktop', 'result': {'ok': True}})
            worker.join(2)
            self.assertEqual(result, [{'ok': True}])
        finally:
            client.close(); owner.close()

    def test_patch_array_insert_remove_replace_and_nested(self):
        state = {'requests': [{'id': 1}], 'runtime': {'type': 'active'}}
        patched = apply_patches(state, [{'op': 'add', 'path': ['requests', 1], 'value': {'id': 2}}, {'op': 'replace', 'path': ['runtime', 'type'], 'value': 'idle'}, {'op': 'remove', 'path': ['requests', 0]}])
        self.assertEqual(patched, {'requests': [{'id': 2}], 'runtime': {'type': 'idle'}})
        with self.assertRaises((KeyError, IndexError)):
            apply_patches(patched, [{'op': 'replace', 'path': ['missing', 0], 'value': 0}])

    def test_missing_revision_resyncs_and_wrong_hosts_are_ignored(self):
        stream = DesktopStream(Path('/tmp/not-real'))
        stream.wanted = {'active'}
        base = {'type': 'broadcast', 'method': 'thread-stream-state-changed', 'sourceClientId': 'owner', 'params': {'conversationId': 'active', 'hostId': 'local', 'change': {'type': 'snapshot', 'revision': 1, 'conversationState': {'requests': [], 'threadRuntimeStatus': {'type': 'active'}}}}}
        stream._handle(base)
        stream.connected = True
        self.assertIsNotNone(stream.view('active'))
        changed = copy.deepcopy(base)
        changed['params']['change'] = {'type': 'patches', 'baseRevision': 9, 'revision': 10, 'patches': []}
        with patch.object(stream, 'follow') as follow:
            stream._handle(changed)
            follow.assert_called_once_with('active')
        changed['params']['hostId'] = 'remote'
        with patch.object(stream, 'follow') as follow:
            stream._handle(changed)
            follow.assert_not_called()
        stream.snapshots['active']['at'] = time.time() - 100
        self.assertIsNone(stream.view('active'))

    def test_allowlist_blocks_arbitrary_commands(self):
        stream = DesktopStream(Path('/tmp/not-real'))
        for method in ['turn/start', 'command/exec', 'thread-follower-update-thread-settings']:
            with self.assertRaises(ValueError):
                stream.send({'method': method})


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = Fixture()
        cls.fixture.monitor.refresh()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.daemon_threads = True
        cls.server.monitor = cls.fixture.monitor
        cls.server.pairing_token = 'test-only-pairing-token'
        cls.server.pairing = DevicePairing(cls.fixture.root / 'pairing', 'Test Mac')
        cls.server.actions = RemoteActions(cls.fixture.monitor, cls.fixture.root / 'pairing')
        cls.server.stream_lock = threading.Lock()
        cls.server.stream_count = 0
        cls.server.lan_ips = ['192.168.0.2']
        cls.server.allowed_hosts = {f'127.0.0.1:{cls.server.server_port}'}
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.fixture.clean()

    def request(self, path, method='GET', data=None, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        headers = headers or {}
        if data is not None:
            data = json.dumps(data)
            headers['Content-Type'] = 'application/json'
        c.request(method, path, data, headers)
        return c, c.getresponse()

    def test_anonymous_api_and_events_rejected(self):
        for path in ['/api/state', '/api/events']:
            c, r = self.request(path)
            self.assertEqual(r.status, 401)
            r.read()
            c.close()

    def test_markdown_runtime_is_served_locally(self):
        c, response = self.request('/marked.js')
        self.assertEqual(response.status, 200)
        self.assertIn('text/javascript', response.getheader('Content-Type'))
        self.assertIn(b'marked v17.0.5', response.read())
        c.close()

    def test_packaged_apk_download_and_app_health(self):
        c, response = self.request('/api/health')
        self.assertEqual(json.loads(response.read())['app'], 'codex-companion')
        c.close()
        with tempfile.TemporaryDirectory() as folder:
            apk = Path(folder) / 'test.apk'
            apk.write_bytes(b'test-apk-content')
            with patch('monitor.apk_path', return_value=apk):
                c, response = self.request('/download.apk')
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader('Content-Type'), 'application/vnd.android.package-archive')
                self.assertEqual(response.read(), b'test-apk-content')
                c.close()

    def test_actions_require_pairing_and_same_origin(self):
        body = {'kind': 'message', 'threadId': 'active', 'actionId': 'test-action-12345678', 'text': 'hello'}
        c, r = self.request('/api/action', 'POST', body)
        self.assertEqual(r.status, 401)
        r.read(); c.close()
        token = self.server.pairing.issue('action test')
        headers = {'Cookie': 'companion_session=' + token, 'X-Companion-Action': '1'}
        c, r = self.request('/api/action', 'POST', body, headers)
        self.assertEqual(r.status, 403)
        r.read(); c.close()
        headers['Origin'] = 'http://evil.example'
        c, r = self.request('/api/action', 'POST', body, headers)
        self.assertEqual(r.status, 403)
        r.read(); c.close()
        headers['Origin'] = f'http://127.0.0.1:{self.server.server_port}'
        with patch.object(self.server.actions, 'execute', return_value={'ok': True}) as execute:
            c, r = self.request('/api/action', 'POST', body, headers)
            self.assertEqual(r.status, 200)
            r.read(); c.close()
            execute.assert_called_once()

    def test_pair_cookie_and_authenticated_state_and_event_stream(self):
        c, r = self.request('/api/session', 'POST', {'token': self.server.pairing_token})
        self.assertEqual(r.status, 200)
        cookie = r.getheader('Set-Cookie')
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie)
        r.read()
        c.close()
        cookie = cookie.split(';')[0]
        c, r = self.request('/api/state', headers={'Cookie': cookie})
        self.assertEqual(r.status, 200)
        self.assertTrue(json.loads(r.read())['threads'])
        c.close()
        c, r = self.request('/api/events', headers={'Cookie': cookie})
        self.assertEqual(r.status, 200)
        self.assertTrue(r.getheader('Content-Type').startswith('text/event-stream'))
        lines = [r.fp.readline().decode() for _ in range(3)]
        self.assertIn('event: state', ''.join(lines))
        self.assertIn('"threads"', ''.join(lines))
        c.close()

    def test_wrong_token_host_and_cross_origin_are_rejected(self):
        cases = [('/api/session', {'token': 'wrong'}, {}, 401), ('/api/session', {'token': self.server.pairing_token}, {'Origin': 'http://evil.example'}, 403), ('/api/session', {'token': self.server.pairing_token}, {'Host': 'evil.example'}, 403)]
        for path, data, headers, code in cases:
            c, r = self.request(path, 'POST', data, headers)
            self.assertEqual(r.status, code)
            r.read()
            c.close()

    def test_pairing_endpoint_is_local_only(self):
        c, r = self.request('/api/local-pair')
        self.assertEqual(r.status, 200)
        r.read()
        c.close()
        with patch.object(Handler, 'local', return_value=False):
            c, r = self.request('/api/local-pair')
            self.assertEqual(r.status, 403)
            r.read()
            c.close()

    def test_six_digit_pair_device_restore_and_revoke(self):
        c, r = self.request('/api/local-pair')
        info = json.loads(r.read())
        self.assertEqual(r.status, 200)
        c.close()
        c, r = self.request('/api/pair-code', 'POST', {'code': info['code'], 'deviceName': 'Test Android'})
        self.assertEqual(r.status, 200)
        cookie = r.getheader('Set-Cookie').split(';')[0]
        token = cookie.split('=', 1)[1]
        self.assertEqual(json.loads(r.read())['serverId'], info['serverId'])
        c.close()
        # Reload the disk store exactly as a service restart does.
        self.server.pairing = DevicePairing(self.fixture.root / 'pairing', 'Test Mac')
        c, r = self.request('/api/state', headers={'Cookie': cookie})
        self.assertEqual(r.status, 200)
        r.read()
        c.close()
        c, r = self.request('/api/device-session', 'POST', {'deviceToken': token})
        self.assertEqual(r.status, 200)
        r.read()
        c.close()
        device = next(device for device in self.server.pairing.info()['devices'] if device['name'] == 'Test Android')
        c, r = self.request('/api/local-revoke', 'POST', {'deviceId': device['id']})
        self.assertEqual(r.status, 200)
        r.read()
        c.close()
        c, r = self.request('/api/state', headers={'Cookie': cookie})
        self.assertEqual(r.status, 401)
        r.read()
        c.close()
        with patch.object(Handler, 'local', return_value=False):
            for endpoint in ['/api/local-revoke', '/api/local-code']:
                c, r = self.request(endpoint, 'POST', {})
                self.assertEqual(r.status, 403)
                r.read()
                c.close()

    def test_discovery_contains_no_code_or_device_secret(self):
        c, r = self.request('/api/discovery')
        data = json.loads(r.read())
        self.assertEqual(data['app'], 'codex-companion')
        self.assertNotIn('code', data)
        self.assertNotIn('devices', data)
        self.assertNotIn('token', data)
        c.close()


if __name__ == '__main__':
    unittest.main()
