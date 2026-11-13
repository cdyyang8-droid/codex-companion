"""Clearly labelled, short-lived phone approval smoke test. No Codex actions."""
import copy
import threading
import time
import uuid

from control import ActionError, request_fingerprint


class ApprovalTest:
    def __init__(self, clock=time.time):
        self.clock = clock
        self.lock = threading.RLock()
        self.test = None

    def start(self):
        with self.lock:
            now = self.clock()
            test_id = 'phone-approval-test-' + str(uuid.uuid4())
            raw = {'id': test_id, 'method': 'companion/testApproval', 'params': {'createdAt': now}}
            self.test = {'id': test_id, 'startedAt': now, 'expiresAt': now + 600,
                         'status': 'approval', 'fingerprint': request_fingerprint(raw),
                         'decision': None, 'receivedAt': None, 'fromLan': None}
            return self.status()

    def status(self):
        with self.lock:
            if self.test and self.test['status'] == 'approval' and self.clock() >= self.test['expiresAt']:
                self.test['status'] = 'expired'
            return copy.deepcopy(self.test) if self.test else {'status': 'none'}

    def thread(self):
        with self.lock:
            test = self.status()
            if test['status'] not in {'approval', 'completed'}:
                return None
            if test['status'] == 'completed' and self.clock() - test['receivedAt'] >= 60:
                return None
            now = test['receivedAt'] or test['startedAt']
            text = '等待你在手机上点「同意本次」或「拒绝」。这是副屏连接测试，不执行命令、不修改项目，也不代表真实 Codex 请求已获批准。'
            if test['status'] == 'completed':
                text = '电脑已收到：' + ('同意本次' if test['decision'] == 'accept' else '拒绝') + '。手机 → 副屏服务的审批回传已完成；未执行任何命令。'
            return {'id': test['id'], 'turnId': test['id'], 'title': '手机审批测试 · 不执行操作',
                    'project': '副屏连接测试', 'model': '仅测试', 'status': test['status'], 'live': True,
                    'canControl': True, 'testOnly': True, 'startedAt': test['startedAt'],
                    'completedAt': test['receivedAt'], 'updatedAt': now, 'summary': text, 'error': None,
                    'events': [{'id': test['id'] + '-' + test['status'], 'at': now * 1000,
                                'kind': 'agentMessage', 'status': 'completed' if test['receivedAt'] else 'info',
                                'label': '副屏审批测试', 'text': text}],
                    'requests': [{'id': test['id'], 'kind': 'approval', 'label': '测试：请在手机确认',
                                  'reason': text, 'fingerprint': test['fingerprint'], 'actionable': True,
                                  'canAccept': True, 'canDecline': True}] if test['status'] == 'approval' else []}

    def resolve(self, body):
        with self.lock:
            if body.get('kind') != 'approval':
                raise ActionError('这是审批测试卡片，不能发送文字。请返回并通过「打开会话」选择真实的 Codex 会话；输入内容未发送。', 400)
            test = self.status()
            if test.get('id') != body.get('threadId') or test['status'] != 'approval':
                raise ActionError('测试已结束或过期，请在电脑重新发起。')
            if body.get('kind') != 'approval' or body.get('requestId') != test['id'] or body.get('fingerprint') != test['fingerprint'] or body.get('decision') not in {'accept', 'decline'}:
                raise ActionError('测试请求不匹配，请刷新后重试。', 400)
            self.test.update(status='completed', decision=body['decision'], receivedAt=self.clock())
            return {'ok': True, 'testOnly': True, 'message': '电脑已收到你的测试审批；未执行任何命令。'}

    def record_source(self, thread_id, from_lan):
        with self.lock:
            if self.test and self.test['id'] == thread_id and self.test['status'] == 'completed' and self.test['fromLan'] is None:
                self.test['fromLan'] = from_lan
