#!/usr/bin/env python3
"""Paired LAN companion for the local Codex desktop app. Python 3.10+, stdlib."""
from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import struct
import subprocess
import threading
import time
import uuid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from pairing import DevicePairing, PairingError
from control import RemoteActions, ActionError, request_fingerprint, latest_live_turn
from approval_test import ApprovalTest
from companion_config import VERSION, apk_path, default_runtime_dir

ROOT = Path(__file__).resolve().parent
STATES = {"running", "approval", "completed", "error", "idle", "unknown"}


def redact(value, limit=1800):
    text = str(value or "")
    text = re.sub(r"\b(?:sk|pk|sess|ghp|github_pat)[-_][A-Za-z0-9_\-]{12,}", "[密钥已隐藏]", text)
    text = re.sub(r"(?i)((?:api[_ -]?key|access[_ -]?token|password|authorization|密钥|key)\s*[:=：]\s*)[^\s,;\"']+", r"\1[已隐藏]", text)
    text = re.sub(r"(?i)Bearer\s+[\w.\-/+=]{8,}", "Bearer [已隐藏]", text)
    return text[:limit]


def apply_patches(state, patches):
    """Apply desktop Immer patches. Reject incomplete paths and resync upstream."""
    for patch in patches:
        path = patch["path"]
        operation = patch["op"]
        if operation not in {"replace", "add", "remove"}:
            raise ValueError("Unsupported patch")
        if not path:
            if operation == "remove":
                raise ValueError("Cannot delete root")
            state = copy.deepcopy(patch["value"])
            continue
        target = state
        for part in path[:-1]:
            target = target[int(part)] if isinstance(target, list) else target[part]
        key = path[-1]
        if isinstance(target, list):
            index = len(target) if key == "-" else int(key)
            if operation == "remove":
                target.pop(index)
            elif operation == "add":
                if not 0 <= index <= len(target):
                    raise ValueError("Array gap")
                target.insert(index, copy.deepcopy(patch["value"]))
            else:
                target[index] = copy.deepcopy(patch["value"])
        elif operation == "remove":
            del target[key]
        else:
            target[key] = copy.deepcopy(patch["value"])
    return state


class DesktopStream:
    """Version-specific desktop follower with a small, explicit action allowlist."""
    ACTION_VERSIONS = {"thread-follower-command-approval-decision": 1,
                       "thread-follower-file-approval-decision": 1,
                       "thread-follower-permissions-request-approval-response": 1,
                       "thread-follower-submit-user-input": 1,
                       "thread-follower-start-turn": 2, "thread-follower-steer-turn": 1,
                       "thread-follower-read-model-settings": 1}
    def __init__(self, codex_home):
        self.path = codex_home / "ipc/ipc.sock"
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.socket = None
        self.client_id = None
        self.connected = False
        self.snapshots = {}
        self.wanted = set()
        self.subscribed = set()
        self.error = None
        self.stop = threading.Event()
        self.pending = {}

    def start(self):
        threading.Thread(target=self._run, daemon=True, name="desktop-stream").start()

    def send(self, message):
        allowed = {"initialize", "thread-owner-discovery", "thread-stream-following-changed", *self.ACTION_VERSIONS}
        if message.get("method") not in allowed and message.get("type") != "client-discovery-response":
            raise ValueError("Unsupported desktop method")
        data = json.dumps(message, ensure_ascii=False).encode()
        with self.write_lock:
            if self.socket is None:
                raise ConnectionError("Desktop disconnected")
            self.socket.sendall(struct.pack("<I", len(data)) + data)

    def request(self, method, params, owner, timeout=20):
        if method not in self.ACTION_VERSIONS or not owner:
            raise ValueError("Unsupported desktop request")
        rid = str(uuid.uuid4())
        pending = {"event": threading.Event(), "method": method}
        with self.lock:
            if not self.connected:
                raise ActionError("电脑实时连接已断开，请重连后再试。", 503)
            self.pending[rid] = pending
        try:
            self.send({"type": "request", "requestId": rid, "sourceClientId": self.client_id,
                       "version": self.ACTION_VERSIONS[method], "method": method, "params": params,
                       "targetClientId": owner, "timeoutMs": timeout * 1000})
            if not pending["event"].wait(timeout + 1):
                raise ActionError("电脑未确认结果，请先查看会话；不要重复提交。", 504, uncertain=True)
            response = pending.get("response", {})
            if response.get("resultType") != "success":
                raise ActionError("电脑未能确认处理结果，请查看 Codex 会话后再操作。", 502, uncertain=True)
            if response.get("method") != method or response.get("handledByClientId") != owner:
                raise ActionError("电脑响应不匹配，请查看会话确认结果。", 502, uncertain=True)
            return response.get("result") or {}
        except (OSError, ConnectionError) as exc:
            raise ActionError("连接中断，处理结果未确认，请先查看电脑会话。", 503, uncertain=True) from exc
        finally:
            with self.lock:
                self.pending.pop(rid, None)

    def control_view(self, tid):
        with self.lock:
            snapshot = self.snapshots.get(tid)
            if not self.connected or not snapshot or time.time() - snapshot["at"] > 75 or not snapshot.get("owner"):
                return None
            return copy.deepcopy(snapshot)

    def follow(self, tid, following=True):
        self.send({"type": "broadcast", "method": "thread-stream-following-changed", "sourceClientId": self.client_id,
                   "version": 1, "params": {"conversationId": tid, "hostId": "local", "following": following}})
        if following:
            self.send({"type": "request", "method": "thread-owner-discovery", "requestId": str(uuid.uuid4()),
                       "sourceClientId": self.client_id, "version": 1, "hostId": "local", "params": {"conversationId": tid}, "timeoutMs": 3000})

    def set_threads(self, tids):
        with self.lock:
            self.wanted = set(tids)

    def view(self, tid):
        with self.lock:
            snapshot = self.snapshots.get(tid)
            if not self.connected or not snapshot or time.time() - snapshot["at"] > 75:
                return None
            # Keep the network payload limited to public runtime state and requests.
            state = snapshot["state"]
            return {"runtime": copy.deepcopy(state.get("threadRuntimeStatus") or {}),
                    "requests": copy.deepcopy(state.get("requests") or []), "receivedAt": snapshot["at"]}

    def _exact(self, sock, length):
        result = bytearray()
        while len(result) < length:
            chunk = sock.recv(length - len(result))
            if not chunk:
                raise ConnectionError("Desktop closed")
            result.extend(chunk)
        return bytes(result)

    def _handle(self, message):
        if message.get("type") == "response":
            with self.lock:
                pending = self.pending.get(message.get("requestId"))
                if pending:
                    pending["response"] = message
                    pending["event"].set()
        if message.get("type") == "client-discovery-request":
            self.send({"type": "client-discovery-response", "requestId": message["requestId"], "response": {"canHandle": False}})
            return
        if message.get("method") == "client-status-changed" and message.get("params", {}).get("status") == "disconnected":
            owner = message["params"].get("clientId")
            with self.lock:
                stale = [tid for tid, snapshot in self.snapshots.items() if snapshot["owner"] == owner]
                for tid in stale:
                    self.snapshots.pop(tid, None)
                    self.subscribed.discard(tid)
            return
        if message.get("method") == "initialize" and message.get("resultType") == "success":
            with self.lock:
                self.client_id = message["result"]["clientId"]
                self.connected = True
                self.error = None
            return
        if message.get("type") != "broadcast" or message.get("method") != "thread-stream-state-changed":
            return
        params = message.get("params", {})
        tid = params.get("conversationId")
        if params.get("hostId") != "local":
            return
        change = params.get("change", {})
        resync = False
        with self.lock:
            if tid not in self.wanted:
                return
            if change.get("type") == "snapshot":
                self.snapshots[tid] = {"state": change["conversationState"], "revision": change["revision"],
                                       "owner": message.get("sourceClientId"), "at": time.time()}
            elif change.get("type") == "patches":
                old = self.snapshots.get(tid)
                if not old or old["revision"] != change.get("baseRevision") or old["owner"] != message.get("sourceClientId"):
                    resync = True
                else:
                    try:
                        old["state"] = apply_patches(old["state"], change.get("patches", []))
                        old.update(revision=change["revision"], at=time.time())
                    except (KeyError, ValueError, TypeError, IndexError):
                        self.snapshots.pop(tid, None)
                        resync = True
        if resync:
            self.follow(tid)

    def _sync(self):
        with self.lock:
            wanted = self.wanted.copy()
            subscribed = self.subscribed.copy()
        for tid in subscribed - wanted:
            self.follow(tid, False)
            with self.lock:
                self.subscribed.discard(tid)
                self.snapshots.pop(tid, None)
        for tid in wanted - subscribed:
            self.follow(tid)
            with self.lock:
                self.subscribed.add(tid)

    def _run(self):
        while not self.stop.is_set():
            sock = None
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.settimeout(1)
                sock.connect(str(self.path))
                # A reader never times out in the middle of a frame. select handles idle time.
                sock.settimeout(15)
                self.socket = sock
                self.send({"type": "request", "method": "initialize", "requestId": str(uuid.uuid4()), "version": 0,
                           "sourceClientId": "initializing-client", "params": {"clientType": "codex-second-screen"}})
                import select
                refreshed = 0
                while not self.stop.is_set():
                    if self.connected:
                        self._sync()
                        if time.monotonic() - refreshed > 30:
                            # Refresh snapshots in case a desktop owner changed without closing the router.
                            with self.lock:
                                tids = list(self.subscribed)
                            for tid in tids:
                                self.follow(tid)
                            refreshed = time.monotonic()
                    if not select.select([sock], [], [], 1)[0]:
                        continue
                    size = struct.unpack("<I", self._exact(sock, 4))[0]
                    if not 0 < size <= 64 * 1024 * 1024:
                        raise ValueError("Invalid desktop frame")
                    self._handle(json.loads(self._exact(sock, size)))
            except (OSError, ValueError, KeyError, ConnectionError) as exc:
                with self.lock:
                    self.error = type(exc).__name__
            finally:
                with self.lock:
                    self.connected = False
                    self.client_id = None
                    self.subscribed.clear()
                    self.snapshots.clear()
                    for pending in self.pending.values():
                        pending["event"].set()
                self.socket = None
                if sock:
                    sock.close()
            self.stop.wait(3)


def item_event(item, created_at=0):
    kind = item.get("type")
    stamp = int(created_at or 0)
    result = {"id": item.get("id", ""), "at": stamp, "kind": kind, "status": "info", "text": ""}
    if kind == "agentMessage":
        result.update(text=redact(item.get("text"), 3500), status="completed" if item.get("phase") in {"final_answer", "final"} else "info", label="Codex 进度")
    elif kind == "commandExecution":
        result.update(text=redact(item.get("command"), 500), status=item.get("status", "running"), label="执行命令")
        if item.get("exitCode") not in (None, 0):
            result["detail"] = redact(item.get("aggregatedOutput"), 1200)
    elif kind == "fileChange":
        paths = [Path(c.get("path", "")).name for c in item.get("changes", [])]
        result.update(text="、".join(paths[:6]), status=item.get("status", "running"), label="更新文件")
    elif kind in {"mcpToolCall", "dynamicToolCall"}:
        result.update(text=redact(" / ".join(str(item.get(k) or "") for k in ["server", "tool"]).strip(" / ")), status=item.get("status", "running"), label="调用工具")
        if item.get("error"):
            result["detail"] = redact(item["error"], 800)
    else:
        return None  # No user prompts, raw tool results, or private reasoning on the phone.
    return result if result["text"] else None


def normalized_request(request):
    method = str(request.get("method", ""))
    params = request.get("params") or {}
    if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval", "item/permissions/requestApproval"}:
        kind, label = "approval", "等待你审批"
    elif method in {"item/tool/requestUserInput", "mcpServer/elicitation/request", "item/plan/requestImplementation"}:
        kind, label = "input", "等待你的选择"
    else:
        return None
    result = {"id": str(request.get("id", "")), "kind": kind, "label": label,
              "reason": redact(params.get("reason") or params.get("message") or "请查看下方请求内容。", 1000),
              "command": redact(params.get("command"), 4000), "fingerprint": request_fingerprint(request),
              "actionable": method in RemoteActions.METHODS}
    if method == 'item/tool/requestUserInput':
        result['questions'] = [{"id": q['id'], "header": redact(q.get('header'), 100),
                                "question": redact(q.get('question'), 2000), "isOther": bool(q.get('isOther')),
                                "isSecret": bool(q.get('isSecret')),
                                "options": [{"label": redact(o.get('label'), 300), "description": redact(o.get('description'), 1000)} for o in q.get('options') or []]}
                               for q in params.get('questions') or []]
    if method == 'item/permissions/requestApproval':
        result['scope'] = '仅本轮任务'
        result['command'] = redact(json.dumps(params.get('permissions') or {}, ensure_ascii=False, indent=2), 4000)
    context = {label: params[key] for key, label in [('cwd', '工作目录'), ('grantRoot', '申请写入路径'), ('networkApprovalContext', '网络访问')] if params.get(key)}
    if context:
        result['context'] = redact(json.dumps(context, ensure_ascii=False, indent=2), 4000)
    # Never offer acceptance when the operation shown on the phone is truncated.
    if len(str(params.get('command') or '')) > 4000 or len(json.dumps(context, ensure_ascii=False)) > 4000 or method == 'item/permissions/requestApproval' and len(json.dumps(params.get('permissions') or {}, ensure_ascii=False, indent=2)) > 4000:
        result['actionable'] = False
    result['canAccept'] = not params.get('availableDecisions') or 'accept' in params['availableDecisions']
    result['canDecline'] = not params.get('availableDecisions') or 'decline' in params['availableDecisions']
    return result


class Monitor:
    def __init__(self, codex_home, stream):
        self.home = codex_home
        self.stream = stream
        self.lock = threading.Lock()
        self.snapshot = {"threads": [], "source": "connecting", "message": "正在连接本机 Codex…"}
        self.version = ""
        self.approval_test = ApprovalTest()

    def connect_db(self, pattern):
        files = list(self.home.glob(pattern))
        if not files:
            raise FileNotFoundError(pattern)
        path = max(files, key=lambda p: (int(re.search(r"_(\d+)\.sqlite", p.name)[1]), p.stat().st_mtime))
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)
        connection.execute("PRAGMA query_only=ON")
        connection.row_factory = sqlite3.Row
        return connection

    def collect(self):
        now = time.time()
        state = self.connect_db("state_*.sqlite")
        history = None
        try:
            columns = {row[1] for row in state.execute("PRAGMA table_info(threads)")}
            fields = [k for k in ["id", "title", "name", "cwd", "source", "updated_at", "created_at", "model", "agent_role", "agent_path"] if k in columns]
            rows = state.execute(f"SELECT {','.join(fields)} FROM threads WHERE archived=0 AND source NOT LIKE '{{%' ORDER BY updated_at DESC LIMIT 24").fetchall()
            try:
                history = self.connect_db("thread_history_*.sqlite")
            except FileNotFoundError:
                pass
            threads = []
            for row in rows:
                row = dict(row)
                if row.get("agent_role") or (row.get("agent_path") and row["agent_path"] != "/root"):
                    continue
                tid = row["id"]
                turn, events, summary = {}, [], ""
                if history:
                    latest = history.execute("SELECT * FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1", (tid,)).fetchone()
                    turn = dict(latest) if latest else {}
                    if turn:
                        items = history.execute("SELECT item_json,created_at_ms FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type IN ('agentMessage','commandExecution','fileChange','mcpToolCall','dynamicToolCall') ORDER BY rollout_ordinal DESC LIMIT 30", (tid, turn["turn_id"])).fetchall()
                        for entry in items:
                            try:
                                item = json.loads(entry["item_json"])
                                event = item_event(item, entry["created_at_ms"])
                                if event:
                                    events.append(event)
                                if not summary and item.get("type") == "agentMessage":
                                    summary = redact(item.get("text"), 600)
                            except (ValueError, TypeError):
                                continue
                live = self.stream.view(tid)
                control_snapshot = self.stream.control_view(tid)
                live_turn = latest_live_turn(control_snapshot['state']) if control_snapshot else {}
                requests = [r for raw in (live or {}).get("requests", []) if (r := normalized_request(raw))]
                runtime = (live or {}).get("runtime", {})
                flags = runtime.get("activeFlags") or []
                status = {"inProgress": "running", "completed": "completed", "failed": "error", "interrupted": "idle"}.get(turn.get("status"), "idle")
                if live and runtime.get("type") in {"active", "systemError"}:
                    status = "error" if runtime["type"] == "systemError" else "running"
                if status == "running" and not live and now - row["updated_at"] > 180:
                    status = "unknown"
                if runtime.get("type") in {"idle", "notLoaded"} and status == "running":
                    status = "unknown"
                if requests or "waitingOnApproval" in flags or "waitingOnUserInput" in flags:
                    status = "approval"
                title = row.get("name") or row.get("title") or "未命名会话"
                title = redact(title, 350).splitlines()[0]
                threads.append({"id": tid, "title": title, "project": Path(row.get("cwd") or "工作区").name,
                                "status": status, "live": live is not None, "updatedAt": row["updated_at"],
                                "turnId": live_turn.get('turnId') or turn.get('turn_id'),
                                "canControl": bool(control_snapshot),
                                "startedAt": turn.get("started_at"), "completedAt": turn.get("completed_at"),
                                "summary": summary or (events[0]["label"] + "：" + events[0]["text"] if events else "暂无进度消息"),
                                "events": events[:18], "requests": requests,
                                "error": redact(turn.get("error_json"), 1000) if status == "error" else None,
                                "model": row.get("model") or "Codex"})
            self.stream.set_threads(t["id"] for t in threads[:16])
            priority = {"approval": 0, "error": 1, "running": 2, "unknown": 3, "completed": 4, "idle": 5}
            threads.sort(key=lambda t: (priority[t["status"]], -t["updatedAt"]))
            connected = self.stream.connected
            result = {"threads": threads, "source": "live" if connected else "history", "collectedAt": now,
                      "message": "桌面实时同步" if connected else "实时连接不可用 · 正在读取本机记录，审批状态可能不完整",
                      "capabilities": {"monitor": True, "remoteApproval": True, "sendMessage": True}, "pollSeconds": 2}
            return result
        finally:
            state.close()
            if history:
                history.close()

    def refresh(self):
        try:
            data = self.collect()
        except (OSError, sqlite3.Error, ValueError, KeyError, TypeError) as exc:
            with self.lock:
                data = copy.deepcopy(self.snapshot)
            data.update(source="unavailable", message="无法读取 Codex 状态，请确认桌面应用正在运行。", collectedAt=time.time())
            data["diagnostic"] = type(exc).__name__
        # Timestamps are heartbeat data, not content revisions.
        significant = {k: v for k, v in data.items() if k != "collectedAt"}
        digest = hashlib.sha256(json.dumps(significant, sort_keys=True).encode()).hexdigest()[:16]
        with self.lock:
            self.snapshot, self.version = data, digest

    def get(self):
        with self.lock:
            result = copy.deepcopy({**self.snapshot, "version": self.version, "serverTime": time.time()})
        test = self.approval_test.thread()
        if test:
            result['threads'].insert(0, test)
            result['version'] += ':' + str(test['id']) + ':' + test['status']
        return result

    def run(self):
        while True:
            self.refresh()
            time.sleep(2)


def lan_addresses():
    addresses = []
    if os.name == "posix":
        try:
            output = subprocess.check_output(["/sbin/ifconfig"], text=True, timeout=3, stderr=subprocess.DEVNULL)
            addresses = re.findall(r"\binet (\d+\.\d+\.\d+\.\d+)\b", output)
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        addresses += socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    return sorted({a for a in addresses if ipaddress.ip_address(a).is_private and not ipaddress.ip_address(a).is_loopback and not ipaddress.ip_address(a).is_link_local})


class Handler(BaseHTTPRequestHandler):
    server_version = "CodexCompanion/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Do not log URLs, pairing credentials, or session cookies.
        pass

    def headers_common(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")

    def reply(self, code, data, content_type="application/json; charset=utf-8", cookie=None):
        body = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, (dict, list)) else data
        self.send_response(code)
        self.headers_common()
        self.send_header("Content-Type", content_type)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        try:
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            session = cookies.get("companion_session")
            if session:
                return self.server.pairing.authorized(session.value)
        except Exception:
            pass
        return False

    def local(self):
        return ipaddress.ip_address(self.client_address[0]).is_loopback

    def valid_host(self):
        if hasattr(self.server, 'network_updated') and time.monotonic() - self.server.network_updated > 15:
            self.server.lan_ips = lan_addresses()
            self.server.allowed_hosts = {f'{host}:{self.server.server_port}' for host in ['localhost', '127.0.0.1', *self.server.lan_ips]}
            self.server.network_updated = time.monotonic()
        host = self.headers.get("Host", "").lower()
        return host in self.server.allowed_hosts

    def paired(self, token):
        return self.reply(200, {'ok': True, 'serverId': self.server.pairing.server_id}, cookie=f"companion_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={DevicePairing.DEVICE_LIFETIME}")

    def do_POST(self):
        if not self.valid_host():
            return self.reply(403, {"error": "host_not_allowed"})
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            return self.reply(403, {"error": "origin_not_allowed"})
        if self.path not in {"/api/session", "/api/pair-code", "/api/device-session", "/api/local-code", "/api/local-revoke", "/api/action", "/api/local-test-approval"}:
            return self.reply(404, {"error": "not_found"})
        if self.path == '/api/action':
            if not self.authorized():
                return self.reply(401, {'error': '设备配对已失效，请重新连接。'})
            if origin != 'http://' + self.headers.get('Host', '') or self.headers.get('X-Companion-Action') != '1':
                return self.reply(403, {'error': '操作来源无效，请在副屏页面内提交。'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 65536 or not self.headers.get('Content-Type', '').startswith('application/json'):
                    return self.reply(400, {'error': '请求格式错误或消息过长。'})
                body = json.loads(self.rfile.read(length))
                cookie = SimpleCookie(self.headers.get('Cookie', ''))['companion_session'].value
                result = self.server.actions.execute(body, hashlib.sha256(cookie.encode()).hexdigest())
                if result.get('testOnly'):
                    self.server.monitor.approval_test.record_source(body.get('threadId'), not self.local())
                return self.reply(200, result)
            except ActionError as error:
                self.server.monitor.refresh()
                return self.reply(error.status, {'error': str(error), 'uncertain': error.uncertain})
            except (ValueError, TypeError, KeyError):
                return self.reply(400, {'error': '请求格式错误。'})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2048 or not self.headers.get("Content-Type", "").startswith("application/json"):
                return self.reply(400, {"error": "bad_request"})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                return self.reply(400, {"error": "bad_request"})
            if self.path in {'/api/local-code', '/api/local-revoke', '/api/local-test-approval'}:
                if not self.local():
                    return self.reply(403, {'error': 'only_on_computer'})
                if self.path == '/api/local-code':
                    return self.reply(200, self.server.pairing.info(rotate=True))
                if self.path == '/api/local-test-approval':
                    if not self.authorized() or origin != 'http://' + self.headers.get('Host', ''):
                        return self.reply(403, {'error': '请在电脑配对后发起测试。'})
                    return self.reply(200, self.server.monitor.approval_test.start())
                return self.reply(200, {'ok': self.server.pairing.revoke(body.get('deviceId', ''))})
            if self.path == '/api/pair-code':
                try:
                    session = self.server.pairing.pair_code(body.get('code'), body.get('deviceName', 'Android 手机'), self.client_address[0])
                except PairingError as error:
                    return self.reply(error.status, {'error': str(error)})
                return self.paired(session)
            if self.path == '/api/device-session':
                token = body.get('deviceToken')
                if not self.server.pairing.authorized(token):
                    return self.reply(401, {'error': '设备配对已取消或过期，请输入新的配对码。'})
                return self.paired(token)
            token = body.get("token", "")
            if not isinstance(token, str) or not hmac.compare_digest(token, self.server.pairing_token):
                return self.reply(401, {"error": "配对链接无效，请在电脑上重新获取。"})
        except (ValueError, TypeError, AttributeError):
            return self.reply(400, {"error": "bad_request"})
        return self.paired(self.server.pairing.issue('本机浏览器' if self.local() else '链接配对设备'))

    def do_GET(self):
        if not self.valid_host():
            return self.reply(403, {"error": "host_not_allowed"})
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.reply(200, {"ok": True, "app": "codex-companion", "version": VERSION})
        if path == '/download.apk':
            apk = apk_path()
            if not apk.is_file():
                return self.reply(404, {'error': '此源码目录未附带 APK，请从项目 Releases 获取。'})
            return self.reply(200, apk.read_bytes(), 'application/vnd.android.package-archive')
        if path == '/api/discovery':
            return self.reply(200, {'app': 'codex-companion', 'version': 2, 'serverId': self.server.pairing.server_id, 'computerName': self.server.pairing.name})
        if path == '/api/local-test-approval':
            if not self.local():
                return self.reply(403, {'error': 'only_on_computer'})
            return self.reply(200, self.server.monitor.approval_test.status())
        if path in {"/api/local-pair", "/api/local-qr"}:
            if not self.local():
                return self.reply(403, {"error": "only_on_computer"})
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                return self.reply(403, {"error": "origin_not_allowed"})
            port = self.server.server_port
            if path == "/api/local-qr":
                try:
                    import qrcode
                    from qrcode.image.svg import SvgPathImage
                    ips = self.server.lan_ips
                    preferred = next((ip for ip in ips if ip.startswith("192.168.")), ips[0] if ips else None)
                    if not preferred:
                        return self.reply(404, {"error": "no_lan_address"})
                    output = io.BytesIO()
                    qrcode.make(f"http://{preferred}:{port}/#pair={self.server.pairing_token}", image_factory=SvgPathImage, border=3).save(output)
                    return self.reply(200, output.getvalue(), "image/svg+xml")
                except ImportError:
                    return self.reply(404, {"error": "optional_qr_unavailable"})
            return self.reply(200, {"links": [f"http://{ip}:{port}/#pair={self.server.pairing_token}" for ip in self.server.lan_ips],
                                    "localLink": f"http://127.0.0.1:{port}/#pair={self.server.pairing_token}",
                                    "apkAvailable": apk_path().is_file(), **self.server.pairing.info()})
        if path.startswith("/api/"):
            if not self.authorized():
                return self.reply(401, {"error": "请使用电脑上的配对链接连接。"})
            if path == "/api/state":
                return self.reply(200, self.server.monitor.get())
            if path == "/api/events":
                return self.events()
            return self.reply(404, {"error": "not_found"})
        assets = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                  "/marked.js": ("vendor/marked-17.0.5.js", "text/javascript; charset=utf-8"),
                  "/app.css": ("app.css", "text/css; charset=utf-8"), "/icon.svg": ("icon.svg", "image/svg+xml"),
                  "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json")}
        if path not in assets:
            return self.reply(404, {"error": "not_found"})
        filename, content_type = assets[path]
        return self.reply(200, (ROOT / "public" / filename).read_bytes(), content_type)

    def events(self):
        with self.server.stream_lock:
            if self.server.stream_count >= 12:
                return self.reply(429, {"error": "too_many_connections"})
            self.server.stream_count += 1
        try:
            self.send_response(200)
            self.headers_common()
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "close")
            self.end_headers()
            self.connection.settimeout(8)
            previous, heartbeat = None, 0
            while self.authorized():
                data = self.server.monitor.get()
                if previous != data["version"]:
                    previous = data["version"]
                    frame = f"id: {previous}\nevent: state\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                    self.wfile.write(frame.encode())
                    self.wfile.flush()
                    heartbeat = time.monotonic()
                elif time.monotonic() - heartbeat >= 5:
                    self.wfile.write(f"event: heartbeat\ndata: {json.dumps({'at':time.time()})}\n\n".encode())
                    self.wfile.flush()
                    heartbeat = time.monotonic()
                time.sleep(1)
        except (OSError, ConnectionError):
            pass
        finally:
            self.close_connection = True
            with self.server.stream_lock:
                self.server.stream_count -= 1


def main():
    parser = argparse.ArgumentParser(description="Codex 手机副屏 · 同一 Wi-Fi 实时查看")
    parser.add_argument("--port", type=int, default=18377)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--runtime-dir", type=Path, default=default_runtime_dir())
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))))
    args = parser.parse_args()
    stream = DesktopStream(args.codex_home)
    monitor = Monitor(args.codex_home, stream)
    monitor.refresh()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.monitor = monitor
    server.pairing_token = secrets.token_urlsafe(32)
    runtime_dir = args.runtime_dir.expanduser().resolve()
    server.actions = RemoteActions(monitor, runtime_dir)
    server.pairing = DevicePairing(runtime_dir, socket.gethostname().removesuffix('.local'))
    server.stream_lock = threading.Lock()
    server.stream_count = 0
    server.lan_ips = lan_addresses()
    server.allowed_hosts = {f"{h}:{server.server_port}" for h in ["localhost", "127.0.0.1", *server.lan_ips]}
    server.network_updated = time.monotonic()
    discovery = None
    if Path('/usr/bin/dns-sd').exists():
        discovery = subprocess.Popen(['/usr/bin/dns-sd', '-R', 'Codex - ' + server.pairing.name[:40], '_codexcomp._tcp', 'local.', str(server.server_port), 'id=' + server.pairing.server_id, 'v=2'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stream.start()
    threading.Thread(target=monitor.run, daemon=True, name="history-reader").start()
    runtime_dir.mkdir(exist_ok=True, mode=0o700)
    (runtime_dir / "server.json").write_text(json.dumps({"pid": os.getpid(), "port": server.server_port}))
    print(f"Codex 手机副屏已启动：http://127.0.0.1:{server.server_port}", flush=True)
    print("请在电脑浏览器点击「连接手机」查看 6 位配对码。关闭此进程即停止同步。", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stream.stop.set()
        if discovery:
            discovery.terminate()
            try:
                discovery.wait(timeout=3)
            except subprocess.TimeoutExpired:
                discovery.kill()
        server.server_close()


if __name__ == "__main__":
    main()
