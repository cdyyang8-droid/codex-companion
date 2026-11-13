import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from control import ActionError, RemoteActions, request_fingerprint, latest_live_turn


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.live = {'threadRuntimeStatus': {'type': 'active'}, 'turns': [{'turnId': 'turn-1', 'status': 'inProgress'}], 'requests': []}
        self.stream = Mock()
        self.stream.control_view.side_effect = lambda tid: {'state': copy.deepcopy(self.live), 'owner': 'owner'}
        self.stream.request.return_value = {'ok': True}
        self.monitor = Mock(stream=self.stream)
        self.monitor.get.return_value = {'source': 'live', 'threads': [{'id': 'thread-1', 'turnId': 'turn-1'}]}
        self.actions = RemoteActions(self.monitor, self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def request_body(self, method, **params):
        raw = {'id': 42, 'method': method, 'params': params}
        self.live['requests'] = [raw]
        return {'actionId': 'action-12345678901234', 'threadId': 'thread-1', 'requestId': '42',
                'fingerprint': request_fingerprint(raw), 'kind': 'approval', 'decision': 'accept'}

    def test_approval_routes_original_numeric_id_and_deduplicates_across_restart(self):
        body = self.request_body('item/commandExecution/requestApproval', command='npm install')
        result = self.actions.execute(body, 'device')
        self.stream.request.assert_called_once_with('thread-follower-command-approval-decision', {'conversationId': 'thread-1', 'requestId': 42, 'decision': 'accept'}, 'owner')
        restored = RemoteActions(self.monitor, self.temp.name)
        self.assertEqual(restored.execute(body, 'device'), result)
        self.assertEqual(self.stream.request.call_count, 1)
        with self.assertRaises(ActionError):
            restored.execute({**body, 'decision': 'decline'}, 'device')
        with self.assertRaises(ActionError):
            restored.execute({**body, 'actionId': 'another-action-123456', 'decision': 'decline'}, 'another-device')
        self.assertEqual(self.stream.request.call_count, 1)
        self.assertNotIn('npm install', (Path(self.temp.name) / 'actions.sqlite').read_bytes().decode(errors='ignore'))

    def test_stale_request_cannot_be_approved(self):
        body = self.request_body('item/fileChange/requestApproval', reason='write file')
        self.live['requests'][0]['params']['reason'] = 'changed request'
        with self.assertRaises(ActionError):
            self.actions.execute(body, 'device')
        self.stream.request.assert_not_called()

    def test_permissions_use_only_requested_permissions_and_turn_scope(self):
        body = self.request_body('item/permissions/requestApproval', permissions={'network': {'enabled': True}})
        self.actions.execute(body, 'device')
        params = self.stream.request.call_args.args[1]
        self.assertEqual(params['response'], {'permissions': {'network': {'enabled': True}}, 'scope': 'turn'})

    def test_input_requires_all_answers_and_forwards_exact_options(self):
        body = self.request_body('item/tool/requestUserInput', questions=[{'id': 'q1', 'options': [{'label': 'A'}]}, {'id': 'q2'}])
        body.update(kind='answer', answers={'q1': 'A', 'q2': 'hello'})
        self.actions.execute(body, 'device')
        self.assertEqual(self.stream.request.call_args.args[1]['response'], {'answers': {'q1': {'answers': ['A']}, 'q2': {'answers': ['hello']}}})
        with self.assertRaises(ActionError):
            self.actions.execute({**body, 'actionId': 'action-another-123456', 'answers': {'q1': 'A'}}, 'device')

    def test_message_steers_running_and_inherits_settings_when_idle(self):
        body = {'actionId': 'message-action-123456', 'threadId': 'thread-1', 'turnId': 'turn-1', 'kind': 'message', 'text': '请改成蓝色'}
        self.actions.execute(body, 'device')
        method, params, owner = self.stream.request.call_args.args
        self.assertEqual(method, 'thread-follower-steer-turn')
        self.assertEqual(params['input'][0]['text'], '请改成蓝色')
        self.assertEqual(params['restoreMessage']['context']['prompt'], '请改成蓝色')
        self.live['threadRuntimeStatus']['type'] = 'idle'
        self.live['turns'][0]['status'] = 'completed'
        self.actions.execute({**body, 'actionId': 'message-action-234567'}, 'device')
        method, params, owner = self.stream.request.call_args.args
        self.assertEqual(method, 'thread-follower-start-turn')
        self.assertEqual(params['turnStart']['context']['inheritThreadSettings'], True)
        self.assertNotIn('approvalPolicy', params['turnStart']['request'])

    def test_wrong_turn_offline_and_unconfirmed_are_never_retried(self):
        body = {'actionId': 'message-action-123456', 'threadId': 'thread-1', 'turnId': 'old-turn', 'kind': 'message', 'text': 'hello'}
        with self.assertRaises(ActionError):
            self.actions.execute(body, 'device')
        self.stream.request.assert_not_called()
        body.update(actionId='message-action-234567', turnId='turn-1')
        self.stream.request.side_effect = ActionError('timeout', 504, uncertain=True)
        for _ in range(2):
            with self.assertRaises(ActionError):
                self.actions.execute(body, 'device')
        self.assertEqual(self.stream.request.call_count, 1)
        self.monitor.get.return_value['source'] = 'history'
        with self.assertRaises(ActionError):
            self.actions.execute({**body, 'actionId': 'message-action-345678'}, 'device')
        self.assertEqual(self.stream.request.call_count, 1)

    def test_canonical_live_turn(self):
        data = {'turnHistory': {'kind': 'canonical', 'history': {'islands': [{'entries': [{'value': 'turn-key'}]}], 'entitiesByKey': {'turn-key': {'turnId': 'canonical-turn'}}}}}
        self.assertEqual(latest_live_turn(data)['turnId'], 'canonical-turn')


if __name__ == '__main__':
    unittest.main()
