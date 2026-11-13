"""Explicit, authenticated desktop actions. Never executes commands itself."""
import copy
import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


class ActionError(Exception):
    def __init__(self, message, status=409, uncertain=False):
        super().__init__(message)
        self.status, self.uncertain = status, uncertain


def request_fingerprint(request):
    return hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def latest_live_turn(state):
    history = state.get('turnHistory') or {}
    if history.get('kind') == 'canonical':
        data = history.get('history') or {}
        islands = data.get('islands') or []
        entries = islands[-1].get('entries', []) if islands else []
        entities = data.get('entitiesByKey') or {}
        if entries:
            return entities.get(entries[-1].get('value')) or {}
    return (state.get('turns') or [{}])[-1]


class RemoteActions:
    METHODS = {
        'item/commandExecution/requestApproval': 'thread-follower-command-approval-decision',
        'item/fileChange/requestApproval': 'thread-follower-file-approval-decision',
        'item/permissions/requestApproval': 'thread-follower-permissions-request-approval-response',
        'item/tool/requestUserInput': 'thread-follower-submit-user-input',
    }

    def __init__(self, monitor, directory):
        self.monitor, self.stream = monitor, monitor.stream
        self.path = Path(directory) / 'actions.sqlite'
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.Lock()
        self.thread_locks = {}
        with self.database() as db:
            db.execute('CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, digest TEXT, state TEXT, result TEXT, created REAL, claim TEXT)')
            if 'claim' not in {column[1] for column in db.execute('PRAGMA table_info(actions)')}:
                db.execute('ALTER TABLE actions ADD COLUMN claim TEXT')
        self.path.chmod(0o600)

    @contextmanager
    def database(self):
        db = sqlite3.connect(self.path)
        try:
            with db:
                yield db
        finally:
            db.close()

    def execute(self, body, device):
        if not isinstance(body, dict) or not isinstance(body.get('threadId'), str) or not body['threadId']:
            raise ActionError('请选择需要操作的会话。', 400)
        action_id = body.get('actionId')
        if not isinstance(action_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{16,80}', action_id):
            raise ActionError('操作编号无效，请刷新后重试。', 400)
        digest = hashlib.sha256(json.dumps([device, body], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        # Persist the attempt before dispatch, including across a service restart.
        with self.lock, self.database() as db:
            old = db.execute('SELECT digest,state,result FROM actions WHERE id=?', (action_id,)).fetchone()
            if old:
                if old[0] != digest:
                    raise ActionError('操作编号已被使用，请检查提交内容。')
                if old[1] == 'done':
                    return json.loads(old[2])
                raise ActionError('此操作已提交，结果尚未确认；请查看会话，勿重复操作。', uncertain=True)
            claim = hashlib.sha256(json.dumps([body['threadId'], body.get('requestId'), body.get('fingerprint')]).encode()).hexdigest() if body.get('kind') in {'approval', 'answer'} else None
            if claim and db.execute("SELECT 1 FROM actions WHERE claim=? AND state IN ('pending','done','uncertain')", (claim,)).fetchone():
                raise ActionError('这条请求已经提交处理，请等待电脑同步，勿重复操作。', uncertain=True)
            db.execute('INSERT INTO actions(id,digest,state,result,created,claim) VALUES(?,?,?,?,?,?)', (action_id, digest, 'pending', None, time.time(), claim))
            thread_lock = self.thread_locks.setdefault(body['threadId'], threading.Lock())
        try:
            if not thread_lock.acquire(blocking=False):
                raise ActionError('这个会话正在处理另一条手机操作，请稍后查看结果。')
            try:
                result = self._dispatch(body, action_id)
            finally:
                thread_lock.release()
        except ActionError as error:
            with self.lock, self.database() as db:
                db.execute('UPDATE actions SET state=? WHERE id=?', ('uncertain' if error.uncertain else 'rejected', action_id))
            raise
        except Exception as exc:
            raise ActionError('处理结果未确认，请查看电脑会话后再操作。', 502, uncertain=True) from exc
        with self.lock, self.database() as db:
            db.execute('UPDATE actions SET state=?,result=? WHERE id=?', ('done', json.dumps(result, ensure_ascii=False), action_id))
        self.monitor.refresh()
        return result

    def _dispatch(self, body, action_id):
        tid = body['threadId']
        if tid.startswith('phone-approval-test-'):
            return self.monitor.approval_test.resolve(body)
        data = self.monitor.get()
        thread = next((t for t in data['threads'] if t['id'] == tid), None)
        snapshot = self.stream.control_view(tid)
        if not thread or data['source'] != 'live' or not snapshot:
            raise ActionError('该会话没有实时连接，请在电脑打开会话并等待同步。', 503)
        live, owner = snapshot['state'], snapshot['owner']
        if body.get('kind') in {'approval', 'answer'}:
            raw = next((r for r in live.get('requests', []) if str(r.get('id')) == body.get('requestId')), None)
            if not raw or body.get('fingerprint') != request_fingerprint(raw):
                raise ActionError('这条请求已被处理或发生变化，已刷新状态。')
            method = self.METHODS.get(raw.get('method'))
            if not method:
                raise ActionError('此类请求暂需在电脑上处理。')
            params = {'conversationId': tid, 'requestId': raw['id']}
            request_params = raw.get('params') or {}
            if raw['method'] == 'item/tool/requestUserInput':
                if body['kind'] != 'answer':
                    raise ActionError('请填写问题答案。', 400)
                supplied = body.get('answers')
                questions = request_params.get('questions') or []
                if not isinstance(supplied, dict) or not questions or set(supplied) != {q['id'] for q in questions}:
                    raise ActionError('请回答所有问题。', 400)
                answers = {}
                for question in questions:
                    answer = supplied[question['id']]
                    if not isinstance(answer, str) or not answer.strip() or len(answer) > 4000:
                        raise ActionError('答案不能为空，且每项不超过 4000 字。', 400)
                    options = question.get('options') or []
                    if options and not question.get('isOther') and answer not in [o['label'] for o in options]:
                        raise ActionError('请选择问题提供的选项。', 400)
                    answers[question['id']] = {'answers': [answer.strip()]}
                params['response'] = {'answers': answers}
            else:
                decision = body.get('decision')
                if body['kind'] != 'approval' or decision not in {'accept', 'decline'}:
                    raise ActionError('审批只能选择同意本次或拒绝。', 400)
                available = request_params.get('availableDecisions')
                if available and raw['method'] != 'item/permissions/requestApproval' and decision not in available:
                    raise ActionError('电脑没有提供这个审批选项，请在电脑上处理。')
                if raw['method'] == 'item/permissions/requestApproval':
                    params['response'] = {'permissions': copy.deepcopy(request_params.get('permissions') or {}) if decision == 'accept' else {}, 'scope': 'turn'}
                else:
                    params['decision'] = decision
            response = self.stream.request(method, params, owner)
            if response.get('ok') is not True:
                raise ActionError('电脑未确认处理结果，请查看会话。', 502, uncertain=True)
            return {'ok': True, 'message': '已提交到电脑，正在同步处理结果。'}
        if body.get('kind') != 'message':
            raise ActionError('不支持的操作。', 400)
        text = body.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 8000:
            raise ActionError('请输入 1～8000 字的消息。', 400)
        turn = latest_live_turn(live)
        turn_id = turn.get('turnId') or thread.get('turnId')
        if not turn_id or body.get('turnId') != turn_id:
            raise ActionError('会话轮次已经变化，请查看最新进展后重新发送。')
        if live.get('requests'):
            raise ActionError('请先处理当前待审批或待回答的请求。')
        runtime = (live.get('threadRuntimeStatus') or {}).get('type')
        if runtime not in {'active', 'idle'}:
            raise ActionError('会话运行状态尚未确认，请稍后重试。')
        input_items = [{'type': 'text', 'text': text.strip(), 'text_elements': []}]
        client_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'codex-companion:' + action_id))
        if runtime == 'active':
            if turn.get('status') != 'inProgress' or not turn.get('turnId'):
                raise ActionError('任务正在切换轮次，请稍后重试。')
            context = {'prompt': text.strip(), 'workspaceRoots': [], 'addedFiles': [], 'fileAttachments': [],
                       'imageAttachments': [], 'pastedTextAttachments': [], 'uploadedFileAttachments': [], 'commentAttachments': []}
            params = {'conversationId': tid, 'input': input_items, 'clientUserMessageId': client_id,
                      'restoreMessage': {'id': client_id, 'context': context}, 'attachments': []}
            method = 'thread-follower-steer-turn'
        else:
            params = {'conversationId': tid, 'turnStart': {'request': {'threadId': tid, 'input': input_items,
                      'clientUserMessageId': client_id}, 'context': {'inheritThreadSettings': True, 'attachments': []}}}
            method = 'thread-follower-start-turn'
        self.stream.request(method, params, owner, timeout=30)
        return {'ok': True, 'message': '消息已发送到电脑会话。'}
