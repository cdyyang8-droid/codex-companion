const { base, launchBrowser } = require('./browser-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  await fs.mkdir(path.join(root, 'outputs'), { recursive: true });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForSelector('.task-card');
    await page.waitForFunction(() => document.querySelector('#syncLabel').textContent.includes('同步'));
    assert.equal(await page.locator('.source-banner').isVisible(), false, 'desktop live stream must be connected');
    const count = await page.locator('.task-card').count();
    assert(count > 0);
    assert.equal(await page.locator('#detailDialog').isVisible(), false, 'details are only shown on demand');
    assert((await page.locator('.task-title').first().textContent()).length > 0);
    assert.equal(await page.locator('.metrics, .filters, #focusPanel').count(), 0);
    assert(await page.locator('.message-text').first().isVisible());
    assert((await page.locator('#connection').textContent()).includes('实时连接'));
    assert.equal(await page.locator('#appVersion').textContent(), 'v1.3.0');
    await page.screenshot({ path: path.join(root, 'outputs/desktop-v7.png'), fullPage: false, animations: 'disabled' });
    await page.locator('.task-card').first().click();
    await page.waitForSelector('.timeline-heading');
    assert(await page.locator('.event').count() > 0);
    await page.screenshot({ path: path.join(root, 'outputs/details-v7.png'), fullPage: false, animations: 'disabled' });
    await page.locator('.detail-close').click();
    await page.locator('#fullscreenButton').click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.locator('#fullscreenButton').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.locator('#pairButton').click();
    await page.waitForSelector('#pairCode');
    assert.match(await page.locator('#pairCode').textContent(), /^\d{6}$/);
    await page.screenshot({ path: path.join(root, 'outputs/pairing-code-v11.png'), fullPage: false, animations: 'disabled' });
    const code = await page.locator('#pairCode').textContent();
    const deviceContext = await browser.newContext();
    const paired = await deviceContext.request.post(base + '/api/pair-code', { data: { code, deviceName: 'Browser integration phone' } });
    assert.equal(paired.status(), 200);
    assert.equal((await deviceContext.request.get(base + '/api/state')).status(), 200);
    await page.locator('#refreshPairCode').click();
    await page.locator('.paired-device').filter({ hasText: 'Browser integration phone' }).locator('[data-revoke]').click();
    await page.waitForFunction(() => !document.querySelector('#pairLinks').textContent.includes('Browser integration phone'));
    assert.equal((await deviceContext.request.get(base + '/api/state')).status(), 401, 'revoked phone loses API access');
    await deviceContext.close();
    await page.locator('.legacy-pair summary').click();
    await page.waitForSelector('.copy-button');
    const pairingUrl = await page.locator('.copy-button').first().getAttribute('data-copy');
    assert(pairingUrl.startsWith('http://192.168.'), 'prefer Wi-Fi address over virtual adapter');
    await page.waitForSelector('#pairQr:not([hidden]) img');
    assert(await page.locator('#qrImage').evaluate(img => img.naturalWidth > 0));
    await page.locator('[data-close="pairDialog"]').click();
    await page.locator('#settingsButton').click();
    await page.locator('#soundToggle').check();
    assert(await page.locator('#soundToggle').isChecked());
    await page.locator('[data-close="settingsDialog"]').click();
    // A fresh phone session must exchange a real pairing fragment for its own cookie.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await phone.newPage();
    mobile.on('pageerror', error => errors.push(error.message));
    const token = new URL(pairingUrl).hash;
    await mobile.goto(base + '/' + token);
    await mobile.waitForSelector('.task-card');
    assert.equal(new URL(mobile.url()).hash, '', 'credential fragment must be removed after pairing');
    assert.equal(await mobile.locator('.brand-group #connection').count(), 1, 'connection indicator belongs beside the product name');
    assert(await mobile.locator('.brand-wordmark b').isVisible(), 'phone keeps the full product name');
    await mobile.locator('#connection').click();
    assert((await mobile.locator('#toast').textContent()).includes('实时同步'), 'connection dot exposes a readable status when tapped');
    await mobile.waitForSelector('#toast[hidden]', { state: 'attached' });
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, 'phone layout should not scroll horizontally');
    await mobile.screenshot({ path: path.join(root, 'outputs/mobile-v7.png'), fullPage: false, animations: 'disabled' });
    await mobile.locator('.task-card').first().click();
    await mobile.waitForSelector('#detailDialog[open]');
    assert(await mobile.locator('.detail-body').isVisible());
    assert(await mobile.locator('#detailDialog').evaluate(dialog => Math.abs(dialog.getBoundingClientRect().bottom - innerHeight) < 2), 'phone details open as a bottom sheet');
    await mobile.locator('.detail-close').click();
    assert.equal(await mobile.locator('#detailDialog').isVisible(), false);
    await mobile.locator('#settingsButton').click();
    await mobile.locator('#wakeToggle').check();
    await mobile.locator('[data-close="settingsDialog"]').click();
    await phone.setOffline(true);
    await mobile.waitForFunction(() => document.querySelector('#connection').classList.contains('offline'), null, { timeout: 20000 });
    assert((await mobile.locator('#sourceBanner').textContent()).includes('中断'));
    assert.equal(await mobile.locator('.task-status').first().textContent(), '连接中断', 'task statuses must indicate stale data');
    await phone.setOffline(false);
    await mobile.waitForFunction(() => document.querySelector('#connection').classList.contains('online'), null, { timeout: 20000 });
    for (const width of [320, 375, 430, 844]) {
      await mobile.setViewportSize({ width, height: width === 320 ? 700 : 390 });
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `viewport ${width} should not overflow`);
      if (width <= 430) {
        assert(await mobile.locator('.topbar').evaluate(bar => {
          const brand = bar.querySelector('.brand-wordmark').getBoundingClientRect();
          const dot = bar.querySelector('#connection').getBoundingClientRect();
          const controls = bar.querySelector('.toolbar').getBoundingClientRect();
          return Math.abs(brand.top + brand.height / 2 - dot.top - dot.height / 2) < 3 && dot.right <= controls.left;
        }), `viewport ${width} keeps the name, dot and toolbar on one row`);
        assert(await mobile.locator('.topbar > .toolbar button').evaluateAll(buttons => buttons.every(button => {
          const box = button.getBoundingClientRect();
          return box.width >= 44 && box.height >= 44;
        })), 'phone toolbar has comfortable tap targets');
      }
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Controlled data verifies one card per task without changing Codex records.
    const stamp = Date.now()/1000;
    const task = (id, title, status, message) => ({ id, title, project: 'companion', status, live: true, updatedAt: stamp, startedAt: stamp-80, completedAt: status === 'completed' ? stamp : null, model: 'Codex', summary: 'Older progress message', requests: [], events: [{ id: 'event-' + id, at: stamp*1000, kind: 'agentMessage', status: 'info', label: '最新执行消息', text: message }] });
    const running = { ...task('running', '调整手机副屏布局', 'running', '已完成任务卡片布局，正在检查手机上的显示效果。'), startedAt: stamp - 738 };
    const second = { ...task('second', '完善班级宠物功能', 'running', '正在验证宠物升级动效与本地数据保存。'), startedAt: stamp - 4092 };
    const approval = { ...task('approve', '更新项目依赖', 'approval', '准备安装项目依赖，需要你确认联网权限。'), requests: [{ id: 'req-1', kind: 'approval', label: '等待你审批', reason: '需要联网下载项目依赖。', command: 'npm install' }] };
    const done = task('old-done', '旧的已完成任务', 'completed', '不应出现在当前任务区');
    const sample = { source: 'live', message: '桌面实时同步', version: 'sample', threads: [running, second, done] };
    await mobile.evaluate(data => { state.events.close(); state.tracked.clear(); acceptData(data); }, sample);
    assert.equal(await mobile.locator('.task-card').count(), 2, 'two running tasks need two independent cards');
    assert.equal(await mobile.locator('.task-card.completed').count(), 0, 'old completed sessions should not fill the screen');
    assert.equal(await mobile.locator('[data-thread="running"] .message-text').textContent(), running.events[0].text);
    assert.equal(await mobile.locator('.metrics, .filters, #focusPanel').count(), 0);
    const sizes = await mobile.locator('[data-thread="running"]').evaluate(card => ({ title: parseFloat(getComputedStyle(card.querySelector('.task-title')).fontSize), message: parseFloat(getComputedStyle(card.querySelector('.message-text')).fontSize) }));
    assert(sizes.message < sizes.title, 'latest message is smaller than task title');
    assert.match(await mobile.locator('[data-thread="running"] .task-status').textContent(), /^12:\d{2}$/);
    assert.match(await mobile.locator('[data-thread="second"] .task-status').textContent(), /^68:\d{2}$/);
    assert.equal(await mobile.locator('.task-duration').count(), 0, 'elapsed time does not take an extra row');
    assert(await mobile.locator('.task-card.running').evaluateAll(cards => cards.every(card => {
      const timer = card.querySelector('.task-timer');
      return timer.parentElement === card.querySelector('.task-title').parentElement && !card.innerText.includes('执行中') && !card.innerText.includes('已用时');
    })), 'running status is replaced by a compact timer beside the title');
    await mobile.screenshot({ path: path.join(root, 'outputs/mobile-duration-v15.png'), fullPage: false, animations: 'disabled' });
    const both = await mobile.locator('.task-card').evaluateAll(cards => cards.every(card => card.getBoundingClientRect().bottom <= innerHeight));
    assert(both, 'both task cards should fit on the phone screen');
    await mobile.setViewportSize({ width: 375, height: 667 });
    assert(await mobile.locator('.task-card').evaluateAll(cards => cards.every(card => card.getBoundingClientRect().bottom <= innerHeight)), 'two tasks fit on a smaller phone');
    await mobile.screenshot({ path: path.join(root, 'outputs/mobile-small-v7.png'), fullPage: false, animations: 'disabled' });
    await mobile.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(data => { state.events.close(); state.tracked.clear(); acceptData(data); }, sample);
    await page.screenshot({ path: path.join(root, 'outputs/desktop-two-tasks-v12.png'), fullPage: false, animations: 'disabled' });
    await mobile.evaluate(data => { state.tracked.clear(); acceptData({ ...data, threads: [data.threads[0]] }); }, sample);
    assert.equal(await mobile.locator('.task-card').count(), 1, 'one task needs exactly one card');
    assert(await mobile.locator('.task-grid.single-task').isVisible());
    await mobile.evaluate(data => { state.tracked.clear(); acceptData(data); }, { ...sample, threads: [approval, running] });
    assert.equal(await mobile.locator('.task-card.approval .task-status').textContent(), '等待审批');
    await mobile.screenshot({ path: path.join(root, 'outputs/mobile-approval-v7.png'), fullPage: false, animations: 'disabled' });
    await mobile.locator('.task-card.approval').click();
    assert(await mobile.locator('.request-box').isVisible());
    assert((await mobile.locator('.request-box').textContent()).includes('电脑上的 Codex'));
    await mobile.screenshot({ path: path.join(root, 'outputs/mobile-details-v7.png'), fullPage: false, animations: 'disabled' });
    await mobile.locator('.detail-close').click();
    const completed = { ...approval, status: 'completed', completedAt: stamp, requests: [], events: [{ ...approval.events[0], text: '项目依赖已更新，检查通过。' }] };
    const completedSample = { ...sample, threads: [completed, running] };
    await mobile.evaluate(data => { acceptData(data); }, completedSample);
    assert.equal(await mobile.locator('[data-thread="approve"] .task-status').textContent(), '已完成', 'observed task completion stays visible');
    assert.equal(await mobile.locator('.task-card').count(), 2);
    assert(await mobile.locator('[data-thread="approve"]').evaluate(card => {
      const title = card.querySelector('.task-title');
      const status = card.querySelector('.task-status');
      return getComputedStyle(title).color === getComputedStyle(status).color && title.parentElement === status.parentElement;
    }), 'completed status and title share one header and color');
    await mobile.screenshot({ path: path.join(root, 'outputs/mobile-completed-v12.png'), fullPage: false, animations: 'disabled' });
    await page.evaluate(data => { acceptData(data); }, { ...sample, threads: [approval, running] });
    await page.evaluate(data => { acceptData(data); }, completedSample);
    await page.screenshot({ path: path.join(root, 'outputs/desktop-completed-v12.png'), fullPage: false, animations: 'disabled' });
    await mobile.setViewportSize({ width: 320, height: 700 });
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'compact title and status fit a narrow phone');
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.evaluate(data => { state.tracked.clear(); acceptData(data); }, { ...sample, threads: [{ ...running, status: 'error', error: '构建失败' }] });
    assert.equal(await mobile.locator('.task-card.error .task-status').textContent(), '任务异常');
    await mobile.evaluate(data => { state.tracked.clear(); acceptData(data); }, { ...sample, threads: [] });
    assert.equal(await mobile.locator('.task-card').count(), 0);
    assert(await mobile.locator('#idleClock').isVisible(), 'no tasks shows the idle clock');
    assert.match(await mobile.locator('.clock-time').textContent(), /^(?:[01]\d|2[0-3]):[0-5]\d$/);
    await mobile.screenshot({ path: path.join(root, 'outputs/mobile-idle-clock-v13.png'), fullPage: false, animations: 'disabled' });
    await page.evaluate(data => { state.tracked.clear(); acceptData(data); }, { ...sample, threads: [] });
    await page.screenshot({ path: path.join(root, 'outputs/desktop-idle-clock-v13.png'), fullPage: false, animations: 'disabled' });
    for (const [width, height] of [[320, 700], [375, 667], [430, 932], [844, 390]]) {
      await mobile.setViewportSize({ width, height });
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `idle clock fits viewport ${width}`);
      assert(await mobile.locator('.clock-face').evaluate(face => {
        const box = face.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
      }), 'clock stays within the phone viewport');
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.evaluate(() => updateConnection(false));
    assert.equal(await mobile.locator('#idleClock').count(), 0, 'offline does not imply idle');
    assert(await mobile.locator('#sourceBanner').isVisible());
    await mobile.evaluate(data => { acceptData({ ...data, source: 'history' }); }, sample);
    assert.equal(await mobile.locator('#connection').textContent(), '仅记录同步');
    assert.equal(await mobile.locator('#idleClock').count(), 0, 'incoming tasks replace the clock');

    // Drive time deterministically to verify completion grace, minute ticks and midnight.
    const clockContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
    const clockPage = await clockContext.newPage();
    clockPage.on('pageerror', error => errors.push(error.message));
    await clockPage.clock.install({ time: new Date('2026-11-10T23:58:45+08:00') });
    await clockPage.goto(base + '/' + token);
    await clockPage.waitForSelector('.task-card');
    await clockPage.evaluate(data => { state.events.close(); state.tracked.clear(); acceptData(data); }, { ...sample, threads: [running] });
    await clockPage.evaluate(data => { acceptData(data); state.lastBeat = Date.now() + 600_000; }, { ...sample, threads: [{ ...running, status: 'completed' }] });
    assert.equal(await clockPage.locator('.task-card.completed').count(), 1);
    await clockPage.clock.fastForward(59_000);
    assert.equal(await clockPage.locator('.task-card.completed').count(), 1, 'completion remains visible for one minute');
    await clockPage.evaluate(data => { acceptData(data); state.lastBeat = Date.now() + 600_000; }, { ...sample, threads: [{ ...running, status: 'completed' }] });
    await clockPage.clock.fastForward(1_050);
    assert(await clockPage.locator('#idleClock').isVisible(), 'heartbeat does not extend completion visibility');
    assert.equal(await clockPage.locator('.clock-time').textContent(), '23:59');
    assert.equal(await clockPage.locator('.clock-date').textContent(), '2026年11月10日');
    assert.equal(await clockPage.locator('.clock-weekday').textContent(), '星期二');
    await clockPage.clock.fastForward(15_050);
    assert.equal(await clockPage.locator('.clock-time').textContent(), '00:00', 'midnight uses hour 00 in 24-hour format');
    assert.equal(await clockPage.locator('.clock-date').textContent(), '2026年11月11日');
    assert.equal(await clockPage.locator('.clock-weekday').textContent(), '星期三');
    await clockPage.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await clockPage.clock.fastForward(60_000);
    assert.equal(await clockPage.locator('.clock-time').textContent(), '00:01', 'clock resumes and stays aligned after visibility changes');
    await clockPage.evaluate(data => acceptData(data), { ...sample, threads: [approval] });
    assert.equal(await clockPage.locator('#idleClock').count(), 0, 'approval interrupts the idle clock immediately');
    assert(await clockPage.locator('.task-card.approval').isVisible());

    // Server time, second ticks, terminal durations and new rounds are independent of SSE changes.
    await clockPage.clock.pauseAt(await clockPage.evaluate(() => Date.now() + 1000));
    await clockPage.evaluate(data => {
      const now = Date.now() / 1000;
      acceptData({ ...data, serverTime: now, collectedAt: now, threads: [{ ...data.threads[0], startedAt: now - 119, completedAt: null }] });
      state.lastBeat = Date.now() + 600_000;
    }, { ...sample, threads: [running] });
    const duration = clockPage.locator('[data-thread="running"] .task-status');
    assert.equal(await duration.textContent(), '01:59');
    await clockPage.locator('[data-thread="running"]').focus();
    await clockPage.evaluate(() => { window.durationCard = document.querySelector('[data-thread="running"]'); });
    await clockPage.clock.fastForward(1_100);
    assert.equal(await duration.textContent(), '02:00', 'elapsed seconds advance without new progress messages');
    assert(await clockPage.evaluate(() => durationCard === document.activeElement && durationCard === document.querySelector('[data-thread="running"]')), 'duration ticks preserve the card and focus');
    await clockPage.locator('[data-thread="running"]').click();
    const detailDuration = clockPage.locator('#details [data-duration-thread]');
    assert.equal(await detailDuration.textContent(), '02:00');
    await clockPage.evaluate(() => { document.querySelector('.detail-body').scrollTop = 20; });
    await clockPage.clock.fastForward(1_000);
    assert.equal(await duration.textContent(), '02:01', 'timer refreshes every second');
    assert.equal(await detailDuration.textContent(), '02:01', 'open details also tick each second');
    await clockPage.evaluate(() => updateConnection(false));
    assert.equal(await duration.textContent(), '连接中断');
    assert.equal(await detailDuration.textContent(), '02:01');
    assert((await detailDuration.getAttribute('aria-label')).includes('上次同步'));
    await clockPage.clock.fastForward(120_000);
    assert.equal(await detailDuration.textContent(), '02:01', 'disconnected tasks do not continue counting');
    await clockPage.evaluate(() => {
      const now = Date.now() / 1000;
      const thread = state.data.threads[0];
      acceptData({ ...state.data, serverTime: now, collectedAt: now, threads: [{ ...thread, status: 'approval' }] });
      state.lastBeat = Date.now() + 600_000;
    });
    assert.equal(await duration.textContent(), '待你处理', 'waiting status remains visible');
    assert.equal(await detailDuration.textContent(), '04:01', 'reconnection catches up and approval wait counts');
    await clockPage.evaluate(() => {
      const now = Date.now() / 1000;
      acceptData({ ...state.data, serverTime: now, threads: [{ ...state.data.threads[0], status: 'completed', completedAt: now }] });
      state.lastBeat = Date.now() + 600_000;
    });
    assert.equal(await duration.textContent(), '已完成');
    assert.equal(await detailDuration.textContent(), '04:01');
    await clockPage.clock.fastForward(40_000);
    assert.equal(await detailDuration.textContent(), '04:01', 'completed duration stays fixed in details');
    await clockPage.evaluate(() => {
      const now = Date.now() / 1000;
      acceptData({ ...state.data, serverTime: now, threads: [{ ...state.data.threads[0], status: 'running', startedAt: now - 10, completedAt: null }] });
      state.lastBeat = Date.now() + 600_000;
    });
    assert.equal(await duration.textContent(), '00:10', 'a new round in the same conversation resets duration');
    await clockPage.clock.fastForward(1_100);
    assert.equal(await duration.textContent(), '00:11');
    // Simulate a phone clock twelve hours ahead of its computer.
    await clockPage.evaluate(() => {
      const server = Date.now() / 1000 - 43_200;
      acceptData({ ...state.data, serverTime: server, collectedAt: server, threads: [{ ...state.data.threads[0], startedAt: server - 4080 }] });
      state.lastBeat = Date.now() + 600_000;
    });
    assert.equal(await duration.textContent(), '68:00', 'duration uses cumulative minutes and the computer clock rather than the phone clock');
    await clockPage.evaluate(() => acceptData({ ...state.data, threads: [{ ...state.data.threads[0], startedAt: null }] }));
    assert.equal(await duration.textContent(), '--:--', 'missing start time never uses conversation creation time');
    await clockPage.evaluate(() => acceptData({ ...state.data, threads: [{ ...state.data.threads[0], startedAt: state.data.serverTime - 80, completedAt: state.data.serverTime - 20 }] }));
    assert.equal(await duration.textContent(), '--:--', 'live status cannot reuse the previous completed turn');
    await clockPage.evaluate(() => acceptData({ ...state.data, threads: [{ ...state.data.threads[0], status: 'error', startedAt: state.data.serverTime - 125, completedAt: state.data.serverTime }] }));
    assert.equal(await duration.textContent(), '任务异常');
    assert.equal(await detailDuration.textContent(), '02:05');
    await clockPage.clock.fastForward(60_000);
    assert.equal(await detailDuration.textContent(), '02:05', 'failed tasks stop counting at their recorded end');
    await clockContext.close();
    // Exercise the web UI against the Android bridge contract, without a phone.
    const nativeContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await nativeContext.addInitScript(() => {
      window.nativeState = { wake: true, full: false, connectionMenus: 0, pairings: 0 };
      window.CodexCompanion = {
        appVersion: () => '1.3.0',
        keyboardOverlaySupported: () => true,
        isKeepAwakeEnabled: () => nativeState.wake,
        setKeepAwake: enabled => { nativeState.wake = enabled; },
        isFullscreen: () => nativeState.full,
        toggleFullscreen: () => { nativeState.full = !nativeState.full; window.dispatchEvent(new Event('nativefullscreenchange')); },
        openConnectionSettings: () => { nativeState.connectionMenus++; },
        pairComputer: () => { nativeState.pairings++; },
      };
    });
    const nativePage = await nativeContext.newPage();
    nativePage.on('pageerror', error => errors.push(error.message));
    await nativePage.goto(base + '/' + token);
    await nativePage.waitForSelector('.task-card');
    assert(await nativePage.locator('body.native-app').count());
    assert.equal(await nativePage.locator('#appVersion').textContent(), 'v1.3.0', 'APK shows its installed version');
    await nativePage.locator('#settingsButton').click();
    assert(await nativePage.locator('#wakeToggle').isChecked(), 'APK starts with native keep-awake enabled');
    assert((await nativePage.locator('#wakeHint').textContent()).includes('Android 原生'));
    await nativePage.locator('#wakeToggle').uncheck();
    assert.equal(await nativePage.evaluate(() => nativeState.wake), false, 'settings disables native keep-awake');
    await nativePage.locator('#wakeToggle').check();
    assert.equal(await nativePage.evaluate(() => nativeState.wake), true, 'settings enables native keep-awake');
    await nativePage.locator('[data-close="settingsDialog"]').click();
    await nativePage.locator('#fullscreenButton').click();
    assert.equal(await nativePage.evaluate(() => nativeState.full), true);
    assert.equal(await nativePage.locator('#fullscreenButton').getAttribute('aria-label'), '退出全屏');
    await nativePage.locator('#pairButton').click();
    assert.equal(await nativePage.evaluate(() => nativeState.connectionMenus), 1);
    await nativePage.locator('#localConnect').evaluate(button => button.click());
    assert.equal(await nativePage.evaluate(() => nativeState.pairings), 1);
    await nativePage.evaluate(data => { state.events.close(); state.tracked.clear(); acceptData(data); }, sample);
    await nativePage.evaluate(() => openDetail(state.data.threads[0].id));
    await nativePage.locator('#messageInput').focus();
    const overlayBefore = await nativePage.locator('.detail-header').boundingBox();
    await nativePage.evaluate(() => { window.companionKeyboard = { bottomPx: 360 * devicePixelRatio, durationMs: 120 }; window.dispatchEvent(new Event('companionkeyboardchange')); });
    await nativePage.waitForTimeout(170);
    const overlayAfter = await nativePage.locator('.detail-header').boundingBox();
    assert.deepEqual(overlayAfter, overlayBefore, 'native IME never translates or resizes the conversation header');
    assert(await nativePage.locator('#messageComposer').evaluate(form => Math.abs(form.getBoundingClientRect().bottom - (innerHeight - 360)) < 2), `native keyboard height lifts only the composer: ${JSON.stringify(await nativePage.locator('#messageComposer').evaluate(form => ({ bottom: form.getBoundingClientRect().bottom, viewport: innerHeight, lift: composerLift, sheet: inputSheet, keyboard: window.companionKeyboard })))}`);
    await nativePage.evaluate(() => { window.companionKeyboard = { bottomPx: 0, durationMs: 120 }; window.dispatchEvent(new Event('companionkeyboardchange')); });
    await nativePage.waitForTimeout(170);
    assert(await nativePage.locator('#messageComposer').evaluate(form => Math.abs(form.getBoundingClientRect().bottom - innerHeight) < 2), 'composer returns after the keyboard closes');
    await nativePage.locator('.detail-close').click();
    assert(await nativePage.locator('#appVersion').isVisible());
    await nativePage.screenshot({ path: path.join(root, 'outputs/mobile-duration-v15.png'), fullPage: false, animations: 'disabled' });
    await nativePage.evaluate(data => { state.events.close(); state.tracked.clear(); acceptData(data); }, { ...sample, threads: [] });
    assert.equal(await nativePage.evaluate(() => nativeState.wake), true, 'idle clock retains native keep-awake');
    await nativePage.screenshot({ path: path.join(root, 'outputs/mobile-idle-clock-v13.png'), fullPage: false, animations: 'disabled' });
    await nativeContext.close();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ realThreads: count, desktopLive: true, qr: true, mobilePairing: true, phoneWidth: 390, reconnect: true, viewports: [320, 375, 390, 430, 844, 1440], inlineConnection: true, mobileSheet: true, nativeBridge: true, idleClock: true, completionGrace: true, midnight: true, duration: true, serverClock: true, signals: true, browserErrors: errors.length }));
    await phone.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
