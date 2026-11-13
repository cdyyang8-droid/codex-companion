const { base, launchBrowser } = require('./browser-helper.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => !!state.data);
    const sample = { source: 'live', message: '桌面实时同步', threads: [{ id: 'phone-demo', turnId: 'turn-demo', title: '优化手机副屏交互', project: 'Codex 副屏', status: 'running', live: true, canControl: true, model: 'Codex', startedAt: Date.now()/1000-138, updatedAt: Date.now()/1000, requests: [], events: [{ id: 'event-demo', at: Date.now(), kind: 'agentMessage', status: 'info', label: '最新执行消息', text: '正在检查审批与文字回复在电脑上的同步结果。' }] }] };
    let responseMode = 'success';
    await page.route('**/api/state', route => route.fulfill({ json: sample }));
    await page.route('**/api/action', async route => {
      calls.push(route.request().postDataJSON());
      await new Promise(resolve => setTimeout(resolve, 120));
      if (responseMode === 'lost') return route.abort('failed');
      await route.fulfill({ json: { ok: true, message: '消息已发送到电脑会话。' } });
    });
    await page.evaluate(data => { state.events.close(); state.tracked.clear(); acceptData(data); openDetail(data.threads[0].id); }, sample);
    await page.locator('#messageInput').fill('请把按钮改成圆角，保持现在的布局。');
    await page.locator('#messageInput').evaluate(input => { input.focus(); input.setSelectionRange(4, 8); window.originalInput = input; window.typingBlurred = false; input.addEventListener('blur', () => { window.typingBlurred = true; }, { once: true }); });
    sample.threads[0].events[0].text = '新的进展到达，正在继续验证。';
    await page.evaluate(data => acceptData(data), sample);
    assert(await page.evaluate(() => document.activeElement === originalInput && originalInput.selectionStart === 4 && originalInput.selectionEnd === 8), 'SSE update preserves the typing cursor and input');
    assert.equal(await page.evaluate(() => typingBlurred), false, 'updates never blur the active field or dismiss a phone keyboard');
    assert.equal(await page.locator('#messageInput').inputValue(), '请把按钮改成圆角，保持现在的布局。');
    await page.locator('#messageComposer button').click();
    await page.waitForFunction(() => document.querySelector('#messageComposer .action-feedback').textContent.includes('已发送'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'message');
    assert.equal(calls[0].turnId, 'turn-demo');
    assert.equal(await page.locator('#messageInput').inputValue(), '');
    // An IME can shrink only visualViewport, leaving innerHeight and dvh unchanged.
    const fixedContent = await page.evaluate(() => ({
      header: document.querySelector('.detail-header').getBoundingClientRect().toJSON(),
      timeline: document.querySelector('.detail-timeline').getBoundingClientRect().toJSON(),
      background: document.querySelector('.topbar').getBoundingClientRect().toJSON(),
    }));
    await page.locator('#messageInput').fill('键盘弹起时，输入框和发送按钮应始终可见。');
    await page.locator('#messageInput').focus();
    await page.evaluate(() => {
      window.savedViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
      const viewport = new EventTarget();
      Object.assign(viewport, { height: 420, offsetTop: 24, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      updateInputViewport();
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await page.locator('#messageComposer').evaluate(form => {
      const input = form.querySelector('textarea').getBoundingClientRect();
      const send = form.querySelector('button').getBoundingClientRect();
      return input.top >= 24 && send.bottom <= 444 && input.bottom <= 444;
    }), 'the composer stays inside the visual viewport above an overlay keyboard');
    assert.equal(await page.locator('#messageInput').inputValue(), '键盘弹起时，输入框和发送按钮应始终可见。');
    const contentAfterKeyboard = await page.evaluate(() => ({
      header: document.querySelector('.detail-header').getBoundingClientRect().toJSON(),
      timeline: document.querySelector('.detail-timeline').getBoundingClientRect().toJSON(),
      background: document.querySelector('.topbar').getBoundingClientRect().toJSON(),
    }));
    for (const part of Object.keys(fixedContent)) for (const dimension of ['top', 'left', 'width', 'height']) {
      assert(Math.abs(contentAfterKeyboard[part][dimension] - fixedContent[part][dimension]) < 1, `${part} ${dimension} stays fixed while the keyboard opens: ${JSON.stringify({ before: fixedContent, after: contentAfterKeyboard })}`);
    }
    assert(await page.locator('#detailDialog').evaluate(dialog => getComputedStyle(dialog).backdropFilter === 'none'), 'typing avoids moving live glass filters');
    // Duplicate viewport events must not invalidate root styles every frame.
    // Observe actual DOM writes over separate frames rather than call counts.
    await page.evaluate(() => {
      window.viewportStyleWrites = 0;
      window.viewportStyleObserver = new MutationObserver(records => { viewportStyleWrites += records.length; });
      viewportStyleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    });
    await page.evaluate(async () => {
      for (let frame = 0; frame < 8; frame++) {
        updateInputViewport(); updateInputViewport();
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    });
    assert.equal(await page.evaluate(() => viewportStyleWrites), 0, 'unchanged viewport events do not invalidate CSS');
    await page.evaluate(() => viewportStyleObserver.disconnect());
    await page.screenshot({ path: path.resolve(__dirname, '../outputs/mobile-keyboard-composer-v19.png'), animations: 'disabled' });
    await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', savedViewport); updateInputViewport(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('#messageInput').fill('断线时要保留这段草稿');
    responseMode = 'lost';
    await page.locator('#messageComposer button').click();
    await page.waitForFunction(() => document.querySelector('#messageComposer .action-feedback').textContent.includes('未确认'));
    assert.equal(await page.locator('#messageInput').inputValue(), '断线时要保留这段草稿');
    assert(await page.locator('#messageComposer button').isDisabled(), 'uncertain message is not automatically submitted again');
    assert.equal(calls.length, 2);
    await page.locator('.detail-close').click();
    // Open a different sample session so the approval capture has no prior uncertain message.
    sample.threads[0].id = 'phone-approval-demo';
    responseMode = 'success';
    const approval = { id: 'approval-demo', kind: 'approval', label: '等待你审批', reason: '需要安装项目依赖，确认后将在电脑上执行。', command: 'npm install', actionable: true, fingerprint: 'demo-fingerprint', canAccept: true, canDecline: true };
    sample.threads[0].requests = [approval]; sample.threads[0].status = 'approval';
    await page.evaluate(data => { acceptData(data); openDetail(data.threads[0].id); }, sample);
    assert(await page.locator('[data-decision="accept"]').isEnabled());
    assert(await page.locator('#messageComposer button').isDisabled());
    await page.screenshot({ path: path.resolve(__dirname, '../outputs/mobile-approval-v16.png'), animations: 'disabled' });
    await page.locator('[data-decision="accept"]').click();
    await page.waitForFunction(() => document.querySelector('.request-box .action-feedback').textContent.includes('已发送'));
    assert.equal(calls[2].decision, 'accept');
    assert.equal(calls[2].fingerprint, approval.fingerprint);
    assert(await page.locator('[data-decision="accept"]').isDisabled(), 'confirmed approval cannot be repeated before sync');
    const question = { id: 'input-demo', kind: 'input', label: '等待你的选择', reason: '请确认展示方式。', actionable: true, fingerprint: 'input-fingerprint', questions: [{ id: 'q1', header: '展示方式', question: '任务完成后保留多久？', isOther: true, options: [{ label: '一分钟', description: '保留绿色完成状态后收起。' }, { label: '一直保留', description: '手动关闭。' }] }] };
    sample.threads[0].requests = [question];
    await page.evaluate(data => acceptData(data), sample);
    await page.locator('[data-answer]').click();
    assert.equal(calls.length, 3, 'missing answers are not submitted');
    await page.locator('input[type="radio"]').first().check();
    sample.threads[0].events[0].text = '仍在等待你的回答。';
    await page.evaluate(data => acceptData(data), sample);
    assert(await page.locator('input[type="radio"]').first().isChecked(), 'progress updates preserve chosen answer');
    await page.locator('[data-answer]').click();
    await page.waitForFunction(() => document.querySelector('.request-box .action-feedback').textContent.includes('已发送'));
    assert.deepEqual(calls[3].answers, { q1: '一分钟' });
    await page.evaluate(() => updateConnection(false));
    assert(await page.locator('[data-answer]').isDisabled());
    for (const [width, height] of [[320, 700], [390, 500], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert(await page.locator('#messageComposer').evaluate(form => form.getBoundingClientRect().bottom <= innerHeight + 1), `composer remains visible above viewport bottom at ${width}x${height}: ${JSON.stringify(await page.locator('#messageComposer').evaluate(form => ({ bottom: form.getBoundingClientRect().bottom, height: innerHeight, dialog: form.closest('dialog').getBoundingClientRect().toJSON(), panel: form.parentElement.getBoundingClientRect().toJSON() })))}`);
    }
    await page.locator('.detail-close').click();
    sample.threads[0].status = 'completed'; sample.threads[0].requests = []; sample.threads[0].completedAt = Date.now()/1000;
    await page.evaluate(data => { state.tracked.clear(); acceptData(data); }, sample);
    await page.locator('#sessionsButton').click();
    await page.locator('[data-session="phone-approval-demo"]').click();
    assert(await page.locator('#detailDialog').isVisible(), 'completed conversations can be reopened');
    // Test cards never create a text composer, including after approval has completed.
    await page.locator('.detail-close').click();
    const realThread = JSON.parse(JSON.stringify(sample.threads[0]));
    const testThread = { ...realThread, id: 'phone-approval-test-browser', turnId: 'test-turn', title: '手机审批测试 · 不执行操作', testOnly: true };
    await page.evaluate(data => { acceptData(data); openDetail(data.threads[0].id); }, { ...sample, threads: [testThread, realThread] });
    assert.equal(await page.locator('#messageComposer').count(), 0);
    assert(await page.locator('[data-open-sessions]').isVisible());
    const beforeTest = calls.length;
    await page.evaluate(() => submitAction(state.data.threads[0], null, { kind: 'message', text: 'must not send' }));
    assert.equal(calls.length, beforeTest, 'a test card can never submit an ordinary message');
    await page.locator('[data-open-sessions]').click();
    assert.equal(await page.locator('[data-session="phone-approval-test-browser"]').count(), 0, 'test cards are excluded from conversation choices');
    await page.locator(`[data-session="${realThread.id}"]`).click();
    assert(await page.locator('#messageInput').isVisible());
    assert((await page.locator('#composerHint').textContent()).includes(realThread.title), 'destination conversation is explicit');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ messageSend: true, approval: true, answer: true, draftsAndFocus: true, offline: true, duplicateProtection: true, keyboardViewport: true, composerOnlyLift: true, viewportStyleDedup: true, lightweightInputSurface: true, sessionPicker: true, errors: errors.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
