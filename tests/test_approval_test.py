import unittest

from approval_test import ApprovalTest
from control import ActionError


class ApprovalSmokeTests(unittest.TestCase):
    def setUp(self):
        self.now = [1000]
        self.test = ApprovalTest(clock=lambda: self.now[0])

    def test_waits_for_explicit_matching_decision_and_records_receipt(self):
        info = self.test.start()
        thread = self.test.thread()
        self.assertEqual(thread['status'], 'approval')
        self.assertTrue(thread['testOnly'])
        self.assertIn('不执行', thread['title'])
        body = {'threadId': info['id'], 'requestId': info['id'], 'kind': 'approval',
                'fingerprint': info['fingerprint'], 'decision': 'accept'}
        with self.assertRaises(ActionError):
            self.test.resolve({**body, 'fingerprint': 'wrong'})
        self.assertEqual(self.test.thread()['status'], 'approval')
        self.now[0] += 20
        result = self.test.resolve(body)
        self.assertTrue(result['testOnly'])
        self.test.record_source(info['id'], True)
        self.assertTrue(self.test.status()['fromLan'])
        self.assertEqual(self.test.status()['receivedAt'], 1020)
        self.assertEqual(self.test.thread()['status'], 'completed')
        with self.assertRaises(ActionError):
            self.test.resolve(body)
        self.now[0] += 61
        self.assertIsNone(self.test.thread(), 'completed tests leave the task list after a minute')

    def test_messages_show_real_session_guidance_even_after_test_ends(self):
        info = self.test.start()
        self.now[0] += 601
        with self.assertRaisesRegex(ActionError, '不能发送文字'):
            self.test.resolve({'threadId': info['id'], 'kind': 'message', 'text': 'hello'})

    def test_expires_and_rejects_previous_tests(self):
        first = self.test.start()
        second = self.test.start()
        with self.assertRaises(ActionError):
            self.test.resolve({'threadId': first['id']})
        self.now[0] += 601
        self.assertEqual(self.test.status()['status'], 'expired')
        self.assertIsNone(self.test.thread())
        with self.assertRaises(ActionError):
            self.test.resolve({'threadId': second['id']})


if __name__ == '__main__':
    unittest.main()
