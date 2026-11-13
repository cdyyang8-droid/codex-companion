'use strict';
const $ = (selector) => document.querySelector(selector);
const labels = { running: '执行中', approval: '待你处理', completed: '已完成', error: '任务异常', idle: '已停止', unknown: '待确认' };
const state = { data: null, selected: null, connected: false, lastBeat: 0, seen: new Map(), initialized: false, events: null, retries: 0, wakeLock: null, audio: null, renderSignature: '', tracked: new Map(), timeAnchor: null, frozenAt: null };
const COMPLETION_DISPLAY_MS = 60_000;
let completionTimer, idleClockTimer, durationTimer;
const actionStates = new Map(), messageDrafts = new Map(), answerDrafts = new Map();
const isTestThread = thread => !!thread && (thread.testOnly === true || thread.id.startsWith('phone-approval-test-'));
const canControl = thread => state.connected && state.data?.source === 'live' && thread.canControl === true;
const actionKey = (thread, request) => request ? `${thread.id}:${request.id}:${request.fingerprint}` : `${thread.id}:message`;
const newActionId = () => window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint32Array(4)), x => x.toString(16)).join('-')}`;
const prefs = { sound: localStorage.getItem('companion:sound') === 'true', wake: localStorage.getItem('companion:wake') === 'true' };
const nativeApp = window.CodexCompanion && typeof window.CodexCompanion.setKeepAwake === 'function' ? window.CodexCompanion : null;
const nativeKeyboardOverlay = nativeApp?.keyboardOverlaySupported?.() === true;
const pageVersion = $('#appVersion').dataset.pageVersion;
const installedVersion = nativeApp?.appVersion?.();
if (installedVersion) {
  $('#appVersion').textContent = `v${installedVersion}`;
  $('#appVersion').setAttribute('aria-label', `App 版本 ${installedVersion}`);
}
$('#appVersion').title = installedVersion ? `App ${installedVersion} · 页面 ${pageVersion}` : `页面版本 ${pageVersion}`;
if (nativeApp) {
  prefs.wake = nativeApp.isKeepAwakeEnabled();
  document.body.classList.add('native-app');
  if (nativeKeyboardOverlay) document.body.classList.add('native-keyboard-overlay');
  $('#pairButton').setAttribute('aria-label', '电脑连接设置');
  $('#pairButton').title = '电脑连接设置';
  $('#pairButton span').textContent = '电脑连接';
  $('#wakeSupportTip').textContent = '应用在前台时通过 Android 原生能力保持屏幕常亮；关闭开关或切到后台后恢复系统休眠。';
  $('#loginHelp').textContent = '请在电脑上点击「连接手机」查看 6 位配对码，再点击下方按钮连接。';
  $('#localConnect').textContent = '重新配对电脑';
}
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const markdownCache = new Map();
const markdownParser = window.marked ? new window.marked.Marked({ gfm: true, breaks: true, async: false, renderer: {
  // Progress is untrusted text. Render Markdown's own elements, never embedded
  // HTML, images, event handlers or executable/custom-scheme links.
  html({ text }) { return esc(text); },
  image({ text }) { return esc(text); },
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    let url;
    try { url = new URL(href); } catch { return label; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return label;
    return `<a href="${esc(url.href)}"${title ? ` title="${esc(title)}"` : ''} rel="noopener noreferrer"${nativeApp ? '' : ' target="_blank"'}>${label}</a>`;
  },
  table(token) { return `<div class="markdown-table" role="region" aria-label="表格，可左右滑动" tabindex="0">${window.marked.Renderer.prototype.table.call(this, token)}</div>`; },
  tablecell({ header, align, tokens }) {
    const tag = header ? 'th' : 'td';
    const alignment = ['left', 'center', 'right'].includes(align) ? ` class="align-${align}"` : '';
    return `<${tag}${alignment}>${this.parser.parseInline(tokens)}</${tag}>`;
  },
} }) : null;
function renderMarkdown(text) {
  const source = String(text ?? '');
  if (markdownCache.has(source)) return markdownCache.get(source);
  let html;
  try { html = markdownParser ? markdownParser.parse(source) : esc(source).replace(/\n/g, '<br>'); }
  catch { html = esc(source).replace(/\n/g, '<br>'); }
  // Bounded cache keeps repeated SSE snapshots from parsing the same message.
  if (markdownCache.size >= 100) markdownCache.delete(markdownCache.keys().next().value);
  markdownCache.set(source, html);
  return html;
}
function progressContent(event) {
  // Commands, paths and tool summaries are literal data, even if they contain
  // backticks, asterisks or other Markdown punctuation.
  return event.kind === 'agentMessage' ? `<div class="markdown-body">${renderMarkdown(event.text)}</div>`
    : `<p class="${event.kind === 'commandExecution' ? 'command-text' : ''}">${esc(event.text)}</p>`;
}
function markdownPreview(text) {
  const preview = document.createElement('template');
  preview.innerHTML = renderMarkdown(text);
  for (const node of preview.content.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, br, pre, tr, td, th')) node.append(document.createTextNode(' '));
  return preview.content.textContent.replace(/\s+/g, ' ').trim();
}
const folderIcon = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h4l1.5 1.5H14V13H2V4Z" stroke="currentColor" stroke-linejoin="round"/></svg>';
const timeText = (seconds) => seconds ? new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
function syncClock(seconds) {
  state.timeAnchor = { seconds: timestamp(seconds) ?? Date.now() / 1000, receivedAt: performance.now() };
}
function taskNow() {
  if (state.frozenAt !== null) return state.frozenAt;
  const anchor = state.timeAnchor;
  return anchor ? anchor.seconds + Math.max(0, performance.now() - anchor.receivedAt) / 1000 : Date.now() / 1000;
}
function taskDuration(thread) {
  const start = timestamp(thread.startedAt);
  const end = timestamp(thread.completedAt);
  const active = ['running', 'approval'].includes(thread.status);
  const stale = !state.connected || state.data?.source === 'unavailable';
  const now = taskNow();
  // A live new turn can arrive before its history record. Never time the previous turn.
  if (!start || start > now + 5 || (active && end !== null) || (end !== null && end < start) || (thread.status === 'completed' && end === null)) return { text: '--:--', description: '用时待同步' };
  const snapshotAt = timestamp(state.data?.collectedAt) ?? state.timeAnchor?.seconds ?? now;
  const until = active ? now : end ?? Math.min(snapshotAt, now);
  const seconds = Math.max(0, until - start);
  const wholeSeconds = Math.floor(seconds);
  const elapsed = `${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${String(wholeSeconds % 60).padStart(2, '0')}`;
  const label = active ? stale ? '上次同步已用时' : '已用时' : thread.status === 'completed' || end !== null ? '总用时' : '截至同步已用时';
  return { text: elapsed, description: `${label} ${Math.floor(wholeSeconds / 60)} 分 ${wholeSeconds % 60} 秒，包含等待审批和输入的时间`, nextUpdate: active && !stale ? (1 - seconds % 1) * 1000 + 20 : null };
}
function updateDurations() {
  clearTimeout(durationTimer);
  if (!state.data) return;
  const threads = new Map(state.data.threads.map(thread => [thread.id, thread]));
  let nextUpdate = Infinity;
  for (const node of document.querySelectorAll('[data-duration-thread]')) {
    const thread = threads.get(node.dataset.durationThread);
    if (!thread) continue;
    const duration = taskDuration(thread);
    if (node.textContent !== duration.text) node.textContent = duration.text;
    node.title = duration.description;
    node.setAttribute('aria-label', duration.description);
    if (duration.nextUpdate && (node.closest('#tasks') || $('#detailDialog').open)) nextUpdate = Math.min(nextUpdate, duration.nextUpdate);
  }
  // Update text in place so each second never rebuilds cards or interrupts reading.
  if (!document.hidden && Number.isFinite(nextUpdate)) durationTimer = setTimeout(updateDurations, Math.max(30, nextUpdate));
}
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 3500); }
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function statusBadge(status) { return `<span class="status-badge ${status}">${labels[status] || '待确认'}</span>`; }
function updateConnection(online) {
  if (!online && state.connected && state.frozenAt === null) state.frozenAt = taskNow();
  if (online && state.data?.source !== 'unavailable') state.frozenAt = null;
  state.connected = online;
  const live = online && state.data?.source === 'live';
  const connection = $('#connection');
  const connectionLabel = live ? '实时连接' : online ? '仅记录同步' : '连接中断';
  connection.className = `connection ${live ? 'online' : 'offline'}`;
  connection.title = live ? '已连接电脑，正在实时同步' : online ? '仅同步本机记录，实时连接暂不可用' : '与电脑连接中断，正在自动重连';
  connection.setAttribute('aria-label', `连接状态：${connectionLabel}`);
  if (connection.querySelector('[role="status"]').textContent !== connectionLabel) connection.querySelector('[role="status"]').textContent = connectionLabel;
  $('#syncLabel').textContent = online ? (state.data?.source === 'live' ? '桌面实时同步' : '本机记录同步') : '连接中断 · 自动重连';
  document.body.classList.toggle('disconnected', !online);
  if (!online) { $('#sourceBanner').hidden = false; $('#sourceBanner').textContent = '与电脑的连接已中断，当前显示上次状态；正在自动重连。'; }
  else if (state.data) { $('#sourceBanner').hidden = state.data.source === 'live'; $('#sourceBanner').textContent = state.data.message; }
  if (state.data) renderTasks();
  if (state.selected) updateActionAvailability();
}
function latestMessage(thread) {
  const event = thread.events?.[0];
  return event ? { text: event.kind === 'agentMessage' ? markdownPreview(event.text) : event.text, label: event.label || '最新执行消息' } : { text: thread.summary ? markdownPreview(thread.summary) : '等待下一条执行消息…', label: '最新执行消息' };
}
function updateIdleClock() {
  clearTimeout(idleClockTimer);
  const clock = $('#idleClock');
  if (!clock) return;
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const date = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
  const display = clock.querySelector('time');
  if (display.textContent !== time) display.textContent = time;
  display.dateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${time}`;
  clock.querySelector('.clock-date').textContent = date;
  clock.querySelector('.clock-weekday').textContent = weekday;
  clock.setAttribute('aria-label', `${date} ${weekday} ${time}`);
  // Align to the next local minute; recalculate after resume to avoid clock drift.
  if (!document.hidden) idleClockTimer = setTimeout(updateIdleClock, 60_000 - Date.now() % 60_000 + 20);
}
function renderTasks() {
  if (!state.data) return;
  const threads = state.data.threads;
  const activeStatuses = ['running', 'approval', 'error', 'unknown'];
  const now = Date.now();
  const stale = !state.connected || state.data.source === 'unavailable';
  // Preserve a newly completed task for one minute without resetting on heartbeats.
  const ids = new Set(threads.map(thread => thread.id));
  for (const id of state.tracked.keys()) if (!ids.has(id)) state.tracked.delete(id);
  for (const thread of threads) {
    const previous = state.tracked.get(thread.id);
    if (activeStatuses.includes(thread.status)) state.tracked.set(thread.id, { status: thread.status });
    else if (thread.status === 'completed' && previous && previous.status !== 'completed') state.tracked.set(thread.id, { status: 'completed', completedUntil: now + COMPLETION_DISPLAY_MS });
    else if (thread.status !== 'completed') state.tracked.delete(thread.id);
  }
  const visible = threads.filter(thread => activeStatuses.includes(thread.status) || (thread.status === 'completed' && state.tracked.has(thread.id) && (stale || state.tracked.get(thread.id).completedUntil > now)));
  clearTimeout(completionTimer);
  const deadlines = visible.filter(thread => thread.status === 'completed').map(thread => state.tracked.get(thread.id).completedUntil);
  if (!stale && !document.hidden && deadlines.length) completionTimer = setTimeout(renderTasks, Math.max(1, Math.min(...deadlines) - now + 20));
  const signature = JSON.stringify([visible, stale]);
  const attention = visible.filter(thread => ['approval', 'error'].includes(thread.status)).length;
  document.title = `${attention ? `(${attention}) 需要你 · ` : ''}Codex 副屏`;
  if (signature === state.renderSignature) { updateDurations(); return; }
  state.renderSignature = signature;
  const grid = $('#tasks');
  clearTimeout(idleClockTimer);
  const showClock = visible.length === 0 && state.connected && state.data.source !== 'unavailable';
  document.body.classList.toggle('clock-mode', showClock);
  grid.classList.toggle('single-task', visible.length === 1);
  grid.classList.toggle('clock-grid', showClock);
  grid.innerHTML = visible.length ? visible.map(thread => {
    const status = stale ? 'unknown' : thread.status;
    const label = stale ? '连接中断' : status === 'approval' && thread.requests.some(request => request.kind === 'approval') ? '等待审批' : labels[status] || '待确认';
    const message = latestMessage(thread);
    const statusIcon = status === 'completed' ? '<path d="m5 10 3 3 7-7"/>' : status === 'approval' ? '<path d="M10 5v6m0 4h.01"/>' : status === 'error' ? '<path d="m6 6 8 8m0-8-8 8"/>' : status === 'running' ? '<path d="m7 5 7 5-7 5V5Z"/>' : '<path d="M6 10h8"/>';
    const stamp = thread.events?.[0]?.at;
    const statusDisplay = status === 'running' ? `<span class="task-status task-timer" data-duration-thread="${esc(thread.id)}"></span>` : `<span class="task-status">${esc(label)}</span>`;
    return `<button class="task-card ${status}" data-thread="${esc(thread.id)}" aria-label="${esc(thread.title)}，${esc(label)}"><span class="task-heading"><h2 class="task-title"><span class="task-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${statusIcon}</svg></span><span class="task-title-text">${esc(thread.title)}</span></h2>${statusDisplay}</span><span class="task-message"><span class="message-heading"><span class="message-label"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 5 4 5-4 5m7 0h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>${esc(message.label)}</span><span class="message-time">${stamp ? timeText(stamp / 1000) : ''}</span></span><span class="message-text">${esc(message.text)}</span></span></button>`;
  }).join('') : showClock ? `<div class="idle-clock" id="idleClock" role="group"><div class="clock-face"><time class="clock-time"></time><div class="clock-calendar"><span class="clock-date"></span><span class="clock-weekday"></span></div></div><p class="clock-caption">当前没有正在执行的任务<span>新任务开始时，自动显示进展</span></p></div>` : `<div class="empty"><span class="empty-icon">⌁</span><h2>正在连接你的电脑</h2><p>连接恢复后自动显示任务进展。</p></div>`;
  if (showClock) updateIdleClock();
  updateDurations();
}
function openDetail(id) {
  state.selected = id;
  $('#details').dataset.signature = '';
  renderDetail();
  showDialog('#detailDialog');
  updateDurations();
  updateInputViewport();
}
function render() {
  if (!state.data) return;
  renderTasks();
  $('#sourceBanner').hidden = state.data.source === 'live' && state.connected;
  if (!$('#sourceBanner').hidden && state.connected) $('#sourceBanner').textContent = state.data.message;
  if (state.selected) renderDetail();
  if ($('#sessionsDialog').open) renderSessions();
  $('#lastSync').textContent = `同步于 ${timeText(state.lastBeat / 1000)}`;
}
function renderSessions() {
  const threads = state.data?.threads.filter(thread => !isTestThread(thread)) || [];
  $('#sessionList').innerHTML = threads.length ? threads.map(thread => `<button class="session-row ${esc(thread.status)}" data-session="${esc(thread.id)}"><span>${esc(thread.title)}<small>${esc(thread.project)}</small></span><span>${esc(labels[thread.status] || '待确认')}</span></button>`).join('') : '<p class="muted">还没有同步到电脑会话。</p>';
}
function openSessions() { $('#detailDialog').close(); renderSessions(); showDialog('#sessionsDialog'); }
$('#sessionsButton').addEventListener('click', openSessions);
document.addEventListener('click', event => {
  const session = event.target.closest('[data-session]');
  if (session) { $('#sessionsDialog').close(); openDetail(session.dataset.session); }
});
function renderDetail() {
  const thread = state.data.threads.find(t => t.id === state.selected);
  if (!thread) { state.selected = null; $('#detailDialog').close(); return; }
  const detail = $('#details');
  const scroll = detail.querySelector('.detail-body')?.scrollTop || 0;
  const signature = JSON.stringify(thread);
  if (detail.dataset.signature === signature) { updateDurations(); updateActionAvailability(); return; }
  // Progress messages may change while typing. Keep form nodes, focus and selection intact.
  const controlSignature = JSON.stringify([thread.id, thread.turnId, thread.status, thread.canControl, thread.requests]);
  const previousControls = detail.dataset.controls === controlSignature ? detail.querySelector('#requestControls') : null;
  const previousComposer = detail.querySelector('#messageComposer');
  const reuseComposer = !isTestThread(thread) && previousComposer?.dataset.composerThread === thread.id ? previousComposer : null;
  detail.dataset.signature = signature;
  detail.dataset.controls = controlSignature;
  const requests = thread.requests.length ? thread.requests : thread.status === 'approval' ? [{ label: '等待你处理', reason: 'Codex 正在等待审批或你的选择。请在电脑上查看具体请求。' }] : [];
  const focused = document.activeElement;
  const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
  const next = document.createElement('div');
  next.innerHTML = `<div class="detail-header"><div class="detail-meta"><span class="project-label">${folderIcon}${esc(thread.project)}</span><div class="toolbar">${statusBadge(thread.status)}<button class="detail-close icon-button" data-close="detailDialog" aria-label="关闭会话详情">×</button></div></div><h2>${esc(thread.title)}</h2><div class="detail-subtitle"><span>${thread.live ? '实时连接' : '本机记录'} · ${esc(thread.model)}</span><span>开始于 ${timeText(thread.startedAt)}</span><span data-duration-thread="${esc(thread.id)}"></span></div></div><div class="detail-body"><div id="requestControls">${requests.map(r => requestControl(thread, r)).join('')}</div><div class="detail-timeline">${thread.error ? `<div class="request-box error"><h3 class="error-text">本轮任务异常</h3><p>${esc(thread.error)}</p></div>` : ''}<div class="timeline-heading"><span>最新进展</span><span>最近 ${thread.events.length} 条</span></div>${thread.events.length ? thread.events.map(e => `<div class="event ${esc(e.status)}"><div class="event-meta"><span class="event-label">${esc(e.label)}${e.status === 'completed' ? ' · 已完成' : e.status === 'failed' ? ' · 此步骤失败' : e.status === 'declined' ? ' · 已拒绝' : ''}</span><span>${timeText(e.at / 1000)}</span></div>${progressContent(e)}${e.detail ? `<details><summary>查看异常信息</summary><pre>${esc(e.detail)}</pre></details>` : ''}</div>`).join('') : '<p class="muted">等待下一条进度消息…</p>'}</div></div>${messageComposer(thread)}`;
  if (reuseComposer) {
    detail.querySelector('.detail-header').replaceWith(next.querySelector('.detail-header'));
    if (!previousControls) $('#requestControls').replaceWith(next.querySelector('#requestControls'));
    detail.querySelector('.detail-timeline').replaceWith(next.querySelector('.detail-timeline'));
  } else detail.replaceChildren(...next.childNodes);
  if (focused?.isConnected) { focused.focus({ preventScroll: true }); if (selection) focused.setSelectionRange(...selection); }
  detail.querySelector('.detail-body').scrollTop = scroll;
  updateDurations();
  updateActionAvailability();
  updateInputViewport();
}
function requestControl(thread, request) {
  const key = actionKey(thread, request);
  const draft = answerDrafts.get(key) || {};
  const questions = request.questions || [];
  const form = questions.map((q, index) => `<fieldset class="answer-question"><legend>${esc(q.header || `问题 ${index + 1}`)}</legend><div class="markdown-body">${renderMarkdown(q.question)}</div>${(q.options || []).map((option, choice) => `<label class="answer-option"><input type="radio" name="question-${index}" data-question="${esc(q.id)}" value="${esc(option.label)}" ${draft[q.id] === option.label ? 'checked' : ''}><span><b>${esc(option.label)}</b>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span></label>`).join('')}${!q.options?.length || q.isOther ? `<label class="answer-free"><span>${q.options?.length ? '其他回答' : '你的回答'}</span><input type="${q.isSecret ? 'password' : 'text'}" data-question="${esc(q.id)}" maxlength="4000" autocomplete="off" value="${esc(draft[q.id] && !q.options?.some(o => o.label === draft[q.id]) ? draft[q.id] : '')}" placeholder="输入回答…"></label>` : ''}</fieldset>`).join('');
  return `<div class="request-box" data-request="${esc(request.id || '')}" data-action-key="${esc(key)}"><h3>● ${esc(request.label)}</h3><div class="markdown-body">${renderMarkdown(request.reason)}</div>${request.command ? `<pre>${esc(request.command)}</pre>` : ''}${request.context ? `<pre>${esc(request.context)}</pre>` : ''}${request.scope ? `<small>授权范围：${esc(request.scope)}</small>` : ''}${request.actionable ? request.kind === 'input' ? `${form}<div class="request-actions"><button class="action-primary" data-answer>提交回答</button></div>` : `<div class="request-actions">${request.canDecline !== false ? '<button class="action-secondary" data-decision="decline">拒绝</button>' : ''}${request.canAccept !== false ? '<button class="action-primary" data-decision="accept">同意本次</button>' : ''}</div>` : '<small>此类请求请在电脑上的 Codex 处理。</small>'}<p class="action-feedback" role="status"></p></div>`;
}
function messageComposer(thread) {
  if (isTestThread(thread)) return `<div class="test-session-note"><span>这是审批测试，不能发送文字。</span><button class="action-primary" data-open-sessions>打开真实会话</button></div>`;
  return `<form id="messageComposer" class="message-composer" data-composer-thread="${esc(thread.id)}"><textarea id="messageInput" aria-label="发送到电脑会话的消息" placeholder="给这个会话发消息…" maxlength="8000" rows="2">${esc(messageDrafts.get(thread.id) || '')}</textarea><div class="composer-actions"><span id="composerHint">发送到这个电脑会话</span><button class="action-primary" type="submit">发送</button></div><p class="action-feedback" role="status"></p></form>`;
}
function updateActionAvailability() {
  const thread = state.data?.threads.find(t => t.id === state.selected);
  if (!thread) return;
  const online = canControl(thread);
  for (const box of document.querySelectorAll('[data-action-key]')) {
    const action = actionStates.get(box.dataset.actionKey);
    const disabled = !online || !!action && ['pending', 'done', 'uncertain'].includes(action.status);
    for (const input of box.querySelectorAll('button, input[data-question]')) input.disabled = disabled;
    box.querySelector('.action-feedback').textContent = action?.message || (!online ? '实时连接恢复后可在这里处理。' : '');
    box.querySelector('.action-feedback').classList.toggle('action-failed', action?.status === 'failed' || action?.status === 'uncertain');
  }
  const composer = $('#messageComposer');
  if (!composer) return;
  const action = actionStates.get(actionKey(thread));
  const blocked = !!action && ['pending', 'uncertain'].includes(action.status);
  composer.querySelector('textarea').disabled = blocked || isTestThread(thread);
  composer.querySelector('button').disabled = !online || blocked || !!thread.requests.length || !thread.turnId || isTestThread(thread) || !composer.querySelector('textarea').value.trim();
  composer.hidden = isTestThread(thread);
  $('#composerHint').textContent = !online ? '连接恢复后可发送' : thread.requests.length ? '请先处理上方请求' : `发送至：${thread.title}`;
  $('#composerHint').title = `发送至：${thread.title}`;
  composer.querySelector('.action-feedback').textContent = action?.message || '';
  composer.querySelector('.action-feedback').classList.toggle('action-failed', action?.status === 'failed' || action?.status === 'uncertain');
}
async function submitAction(thread, request, fields) {
  if (!request && isTestThread(thread)) { toast('测试卡片不能发送文字，请打开真实会话。'); return; }
  const key = actionKey(thread, request);
  const previous = actionStates.get(key);
  if (!canControl(thread) || previous && ['pending', 'uncertain'].includes(previous.status) || request && previous?.status === 'done') return;
  const action = { status: 'pending', message: '正在提交到电脑…' };
  actionStates.set(key, action);
  updateActionAvailability();
  const body = { actionId: newActionId(), threadId: thread.id, ...fields };
  if (request) Object.assign(body, { requestId: request.id, fingerprint: request.fingerprint });
  else body.turnId = thread.turnId;
  try {
    const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Companion-Action': '1' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) { action.status = result.uncertain ? 'uncertain' : 'failed'; action.message = result.error || '电脑未能处理，请查看会话。'; }
    else {
      action.status = 'done'; action.message = result.message;
      if (!request) { messageDrafts.delete(thread.id); if ($('#messageComposer')?.dataset.composerThread === thread.id) $('#messageInput').value = ''; }
      else answerDrafts.delete(key);
    }
  } catch { action.status = 'uncertain'; action.message = '结果未确认，请先核对电脑会话。内容已保留，不会自动重发。'; }
  updateActionAvailability();
  try { const response = await fetch('/api/state'); if (response.ok) acceptData(await response.json()); } catch { /* SSE will reconnect. */ }
}
document.addEventListener('input', event => {
  if (event.target.id === 'messageInput') {
    messageDrafts.set(state.selected, event.target.value);
    const key = `${state.selected}:message`;
    if (actionStates.get(key)?.status !== 'pending' && actionStates.get(key)?.status !== 'uncertain') actionStates.delete(key);
    updateActionAvailability();
  }
  if (event.target.matches('[data-question]')) {
    const box = event.target.closest('[data-action-key]');
    const draft = answerDrafts.get(box.dataset.actionKey) || {};
    draft[event.target.dataset.question] = event.target.value;
    answerDrafts.set(box.dataset.actionKey, draft);
    for (const other of box.querySelectorAll('[data-question]')) if (other !== event.target && other.dataset.question === event.target.dataset.question) { if (other.type === 'radio') other.checked = false; else other.value = ''; }
  }
});
document.addEventListener('submit', event => {
  if (event.target.id !== 'messageComposer') return;
  event.preventDefault();
  const thread = state.data.threads.find(t => t.id === state.selected);
  if (thread && $('#messageInput').value.trim()) submitAction(thread, null, { kind: 'message', text: $('#messageInput').value });
});
document.addEventListener('click', event => {
  if (event.target.closest('[data-open-sessions]')) { openSessions(); return; }
  const button = event.target.closest('[data-decision], [data-answer]');
  if (!button) return;
  const thread = state.data.threads.find(t => t.id === state.selected);
  const box = button.closest('[data-request]');
  const request = thread?.requests.find(r => r.id === box.dataset.request);
  if (!request) return;
  if (button.hasAttribute('data-answer')) {
    const answers = answerDrafts.get(actionKey(thread, request)) || {};
    if (!request.questions?.every(q => answers[q.id]?.trim())) { box.querySelector('.action-feedback').textContent = '请回答所有问题后提交。'; return; }
    submitAction(thread, request, { kind: 'answer', answers });
  } else submitAction(thread, request, { kind: 'approval', decision: button.dataset.decision });
});
// Freeze the sheet's original geometry while editing. Only the composer moves
// over the conversation; the header, timeline and background never follow it.
let inputViewportFrame = 0, inputScrollTimer, inputReleaseTimer;
let inputViewportHeight, inputViewportBottom, inputViewportFocus, inputViewportField;
let inputSheet, composerLift = 0, keyboardMotionUntil = 0;
function lockInputSheet() {
  const dialog = $('#detailDialog');
  if (inputSheet || !dialog.open || !$('#messageComposer')) return;
  for (const animation of dialog.getAnimations()) if (animation.animationName === 'appear') animation.finish();
  const rect = dialog.getBoundingClientRect();
  inputSheet = { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height, viewportHeight: innerHeight, viewportWidth: innerWidth };
  const style = dialog.style;
  for (const [name, value] of Object.entries({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })) style.setProperty(`--sheet-${name}`, `${value}px`);
  dialog.classList.add('composer-docked', 'input-session');
}
function releaseInputSheet() {
  clearTimeout(inputReleaseTimer);
  $('#detailDialog').classList.remove('composer-docked');
  inputSheet = null;
  composerLift = 0;
  $('#messageComposer')?.style.removeProperty('transform');
}
function keepAnswerVisible() {
  const focused = document.activeElement;
  const body = focused?.closest('.detail-body');
  if (!body || !$('#detailDialog').open || !focused.matches('textarea, input:not([type="radio"]):not([type="checkbox"])')) return;
  const box = focused.getBoundingClientRect(), bounds = body.getBoundingClientRect();
  const bottom = Math.min(bounds.bottom, $('#messageComposer')?.getBoundingClientRect().top ?? bounds.bottom);
  if (box.bottom > bottom - 12) body.scrollTop += box.bottom - bottom + 12;
  else if (box.top < bounds.top + 12) body.scrollTop -= bounds.top + 12 - box.top;
}
function updateInputViewport() {
  // resize + visualViewport resize/scroll often describe the same frame.
  if (inputViewportFrame) return;
  inputViewportFrame = requestAnimationFrame(() => {
    inputViewportFrame = 0;
    if (inputSheet && innerWidth !== inputSheet.viewportWidth) releaseInputSheet();
    const viewport = window.visualViewport;
    const height = viewport?.height || innerHeight;
    const top = viewport?.offsetTop || 0;
    const nativeKeyboard = nativeKeyboardOverlay ? window.companionKeyboard : null;
    const layoutHeight = inputSheet?.viewportHeight || innerHeight;
    const bottom = nativeKeyboard ? Math.max(0, nativeKeyboard.bottomPx / (devicePixelRatio || 1)) : Math.max(0, layoutHeight - height - top);
    const focused = document.activeElement;
    const editable = focused?.matches('textarea, input:not([type="radio"]):not([type="checkbox"])');
    const inputFocused = !!editable && $('#detailDialog').open;
    if (inputFocused) lockInputSheet();
    if (!$('#detailDialog').open) releaseInputSheet();
    else if (!inputFocused && bottom < 1 && inputSheet) {
      // Native IME events give the destination (zero) at the START of closing.
      // Keep the sheet locked until the composer's return animation completes.
      const remaining = keyboardMotionUntil - performance.now();
      if (remaining > 0) {
        clearTimeout(inputReleaseTimer);
        inputReleaseTimer = setTimeout(updateInputViewport, remaining + 20);
      } else releaseInputSheet();
    }
    const field = inputFocused ? focused : null;
    const changed = height !== inputViewportHeight || bottom !== inputViewportBottom || field !== inputViewportField;
    const style = document.documentElement.style;
    if (!inputSheet) {
      if (height !== inputViewportHeight) style.setProperty('--input-viewport-height', `${height}px`);
      if (bottom !== inputViewportBottom) style.setProperty('--input-viewport-bottom', `${bottom}px`);
    }
    const typing = inputFocused || !!inputSheet && bottom > 0;
    if (typing !== inputViewportFocus) document.body.classList.toggle('input-focused', typing);
    if (inputSheet) {
      const lift = Math.max(0, bottom - (inputSheet.viewportHeight - inputSheet.bottom));
      if (lift !== composerLift) {
        const composer = $('#messageComposer');
        composer?.style.setProperty('transition-duration', `${nativeKeyboard?.durationMs || 0}ms`);
        composer?.style.setProperty('transform', `translate3d(0, ${-lift}px, 0)`);
        composerLift = lift;
      }
    }
    inputViewportHeight = height;
    inputViewportBottom = bottom;
    inputViewportFocus = typing;
    inputViewportField = field;
    if (changed) {
      // Let IME/layout updates settle before measuring a question field. The
      // composer is pinned by CSS and needs no forced layout or scroll here.
      clearTimeout(inputScrollTimer);
      if (inputFocused && focused.closest('.detail-body')) inputScrollTimer = setTimeout(keepAnswerVisible, 100);
    }
  });
}
window.visualViewport?.addEventListener('resize', updateInputViewport);
window.visualViewport?.addEventListener('scroll', updateInputViewport);
window.addEventListener('resize', updateInputViewport);
window.addEventListener('companionkeyboardchange', () => {
  // A duration-zero confirmation at onEnd can precede the final compositor
  // frame. Retain the original deadline rather than cancelling that motion.
  const duration = Math.max(0, Number(window.companionKeyboard?.durationMs) || 0);
  if (duration) keyboardMotionUntil = performance.now() + duration;
  updateInputViewport();
});
document.addEventListener('focusin', event => {
  if (event.target.matches('textarea, input:not([type="radio"]):not([type="checkbox"])') && $('#detailDialog').open) lockInputSheet();
  updateInputViewport();
});
document.addEventListener('focusout', updateInputViewport);
$('#detailDialog').addEventListener('close', () => { releaseInputSheet(); $('#detailDialog').classList.remove('input-session'); updateInputViewport(); });
updateInputViewport();
function playAlert() {
  if (!prefs.sound || !state.audio) return;
  state.audio.resume().then(() => { const now = state.audio.currentTime; for (const [offset, freq] of [[0, 660], [.2, 880]]) { const oscillator = state.audio.createOscillator(), gain = state.audio.createGain(); oscillator.type = 'sine'; oscillator.frequency.value = freq; gain.gain.setValueAtTime(0, now + offset); gain.gain.linearRampToValueAtTime(.12, now + offset + .02); gain.gain.exponentialRampToValueAtTime(.001, now + offset + .17); oscillator.connect(gain); gain.connect(state.audio.destination); oscillator.start(now + offset); oscillator.stop(now + offset + .18); } }).catch(() => {});
}
function acceptData(data) {
  if (!Array.isArray(data.threads)) throw new Error('状态数据格式不正确');
  let alert = false;
  for (const thread of data.threads) {
    const attentionSignature = JSON.stringify([thread.status, thread.requests.map(r => r.id)]);
    if (state.initialized && ['approval', 'error'].includes(thread.status) && state.seen.get(thread.id) !== attentionSignature) alert = true;
    state.seen.set(thread.id, attentionSignature);
  }
  state.initialized = true;
  if (data.source === 'unavailable') {
    if (state.frozenAt === null) state.frozenAt = taskNow();
  } else {
    syncClock(data.serverTime);
    state.frozenAt = null;
  }
  state.data = data;
  state.lastBeat = Date.now();
  state.retries = 0;
  updateConnection(true);
  if (alert) { playAlert(); if (navigator.vibrate) navigator.vibrate([100, 70, 100]); }
  render();
}
async function authenticate(token) {
  const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!response.ok) throw new Error('配对链接已失效，请在电脑上重新获取。');
  $('#loginDialog').close();
}
async function localPair() {
  const response = await fetch('/api/local-pair');
  if (!response.ok) return null;
  return response.json();
}
async function start() {
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has('pair')) {
      const token = fragment.get('pair');
      history.replaceState(null, '', location.pathname);
      await authenticate(token);
    }
    let response = await fetch('/api/state');
    if (response.status === 401) {
      const pairing = await localPair();
      if (pairing) {
        await authenticate(new URLSearchParams(new URL(pairing.localLink).hash.slice(1)).get('pair'));
        response = await fetch('/api/state');
      } else { showDialog('#loginDialog'); return; }
    }
    if (!response.ok) throw new Error('连接失败');
    acceptData(await response.json());
    connectEvents();
    if (location.hash === '#connect' && !nativeApp) { history.replaceState(null, '', location.pathname); showDialog('#pairDialog'); await renderPairing(); }
  } catch (error) {
    updateConnection(false);
    if (/配对/.test(error.message)) { $('#loginError').textContent = error.message; showDialog('#loginDialog'); }
    else setTimeout(start, Math.min(15000, 1500 * 2 ** Math.min(state.retries++, 3)));
  }
}
function connectEvents() {
  state.events?.close();
  const events = state.events = new EventSource('/api/events');
  events.addEventListener('state', e => { try { acceptData(JSON.parse(e.data)); } catch { updateConnection(false); } });
  events.addEventListener('heartbeat', e => { if (state.data?.source !== 'unavailable') { try { syncClock(JSON.parse(e.data).at); } catch { /* Keep the last known server clock. */ } } state.lastBeat = Date.now(); updateConnection(true); $('#lastSync').textContent = `同步于 ${timeText(Date.now() / 1000)}`; });
  events.onerror = () => { updateConnection(false); if (Date.now() - state.lastBeat > 12000) { events.close(); setTimeout(start, 3000); } };
}
async function acquireWakeLock() {
  if (nativeApp) {
    nativeApp.setKeepAwake(prefs.wake);
    $('#wakeHint').textContent = prefs.wake ? 'Android 原生常亮已开启，前台保持屏幕亮起' : '已关闭，使用手机系统的自动锁屏设置';
    return;
  }
  if (!prefs.wake || document.hidden) return;
  if (!('wakeLock' in navigator) || !window.isSecureContext) { $('#wakeHint').textContent = '此连接不支持常亮，请在手机系统中延长锁屏时间'; return; }
  try { state.wakeLock = await navigator.wakeLock.request('screen'); $('#wakeHint').textContent = '已保持屏幕常亮'; } catch { $('#wakeHint').textContent = '无法保持常亮，请在系统中调整锁屏时间'; }
}
document.addEventListener('click', async event => {
  const task = event.target.closest('[data-thread]');
  if (task) openDetail(task.dataset.thread);
  const close = event.target.closest('[data-close]');
  if (close) $(`#${close.dataset.close}`).close();
  const refreshCode = event.target.closest('#refreshPairCode');
  const revoke = event.target.closest('[data-revoke]');
  if (refreshCode || revoke) {
    try {
      const response = await fetch(refreshCode ? '/api/local-code' : '/api/local-revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(revoke ? { deviceId: revoke.dataset.revoke } : {}) });
      if (response.ok) { await renderPairing(); if (revoke) toast('已取消设备配对'); }
      else toast('操作未完成，请在电脑上重试');
    } catch { toast('连接中断，请稍后重试'); }
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    const text = copy.dataset.copy;
    try { if (!navigator.clipboard || !window.isSecureContext) throw new Error(); await navigator.clipboard.writeText(text); toast('配对链接已复制'); }
    catch { const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(copy.previousElementSibling); selection.removeAllRanges(); selection.addRange(range); toast('链接已选中，请长按或按 ⌘C 复制'); }
  }
});
$('#connection').addEventListener('click', () => toast($('#connection').title));
$('#fullscreenButton').addEventListener('click', async () => {
  try {
    if (nativeApp) { nativeApp.toggleFullscreen(); return; }
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast('此浏览器不支持全屏，可添加到主屏幕使用');
  } catch { toast('暂时无法进入全屏，可添加到主屏幕使用'); }
});
document.addEventListener('fullscreenchange', () => { const full = !!document.fullscreenElement; $('#fullscreenButton span').textContent = full ? '退出全屏' : '全屏'; $('#fullscreenButton').setAttribute('aria-label', full ? '退出全屏' : '进入全屏'); });
window.addEventListener('nativefullscreenchange', () => { const full = nativeApp?.isFullscreen(); $('#fullscreenButton span').textContent = full ? '退出全屏' : '全屏'; $('#fullscreenButton').setAttribute('aria-label', full ? '退出全屏' : '进入全屏'); });
async function renderPairing() {
  $('#pairLinks').textContent = '正在获取连接地址…';
  try {
    const pairing = await localPair();
    const links = pairing?.links.slice().sort((a, b) => Number(!a.includes('192.168.')) - Number(!b.includes('192.168.')));
    const apkLink = pairing?.apkAvailable && links?.length ? new URL('/download.apk', links[0]).href : null;
    $('#pairLinks').innerHTML = pairing ? `<div class="pair-code-panel"><span class="muted small">${esc(pairing.computerName)}</span><div class="pair-code" id="pairCode" aria-label="6 位配对码">${esc(pairing.code)}</div><span class="muted small">有效至 ${timeText(pairing.expiresAt)} · 一次有效</span><button class="refresh-code" id="refreshPairCode">换一个码</button></div><div class="paired-devices"><span class="muted small">已配对设备</span>${pairing.devices.length ? pairing.devices.map(device => `<div class="paired-device"><span>${esc(device.name)}<small>配对于 ${new Date(device.pairedAt * 1000).toLocaleDateString('zh-CN')}</small></span><button data-revoke="${esc(device.id)}">取消配对</button></div>`).join('') : '<p class="small muted">尚未配对设备</p>'}</div>` + (apkLink ? `<a class="apk-download" href="${esc(apkLink)}" target="_blank" rel="noopener noreferrer">下载 Android 安装包<span>手机打开 ${esc(apkLink)} 即可下载</span></a>` : '') + (links.length ? `<details class="legacy-pair"><summary>使用链接或二维码连接浏览器</summary><div id="pairQr" class="pair-qr" hidden><img id="qrImage" alt="用手机扫码连接 Codex 副屏"><small>用手机相机扫码连接</small></div>` + links.map((url, i) => `<div class="pair-link"><span class="muted small">${i === 0 ? '推荐连接地址' : '备用局域网地址'}</span><code>${esc(url)}</code><button class="copy-button" data-copy="${esc(url)}">复制配对链接</button></div>`).join('') + '</details>' : '<p>未找到局域网地址，请检查电脑 Wi-Fi。</p>') : '<p>请在电脑上打开此面板查看配对码。</p>';
    if ($('#qrImage')) { $('#qrImage').onload = () => { $('#pairQr').hidden = false; }; $('#qrImage').src = '/api/local-qr'; }
  } catch { $('#pairLinks').textContent = '暂时无法获取，请检查电脑连接。'; }
}
$('#pairButton').addEventListener('click', async () => {
  if (nativeApp) { nativeApp.openConnectionSettings(); return; }
  showDialog('#pairDialog');
  await renderPairing();
});
$('#settingsButton').addEventListener('click', () => { $('#soundToggle').checked = prefs.sound; $('#wakeToggle').checked = prefs.wake; showDialog('#settingsDialog'); });
$('#soundToggle').addEventListener('change', event => { prefs.sound = event.target.checked; localStorage.setItem('companion:sound', String(prefs.sound)); if (prefs.sound) { try { state.audio ||= new (window.AudioContext || window.webkitAudioContext)(); playAlert(); } catch { toast('此浏览器不支持提示音'); } } });
$('#wakeToggle').addEventListener('change', async event => { prefs.wake = event.target.checked; localStorage.setItem('companion:wake', String(prefs.wake)); if (nativeApp || prefs.wake) await acquireWakeLock(); else { await state.wakeLock?.release(); state.wakeLock = null; } });
document.addEventListener('pointerdown', () => { if (prefs.sound && !state.audio) { try { state.audio = new (window.AudioContext || window.webkitAudioContext)(); state.audio.resume().catch(() => {}); } catch {} } }, { once: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(idleClockTimer); clearTimeout(completionTimer); clearTimeout(durationTimer); }
  else { renderTasks(); updateIdleClock(); acquireWakeLock(); if (!state.connected || Date.now() - state.lastBeat > 10000) start(); }
});
window.addEventListener('offline', () => { state.events?.close(); updateConnection(false); });
window.addEventListener('online', () => { start(); });
$('#localConnect').addEventListener('click', () => nativeApp ? nativeApp.pairComputer() : start());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog && dialog.id !== 'loginDialog') { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
function checkConnection() { if (state.connected && Date.now() - state.lastBeat > 16000) updateConnection(false); }
setInterval(checkConnection, 5000); start(); acquireWakeLock();
