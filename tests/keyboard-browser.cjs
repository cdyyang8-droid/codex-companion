const { base, launchBrowser } = require('./browser-helper.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const nextFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

(async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.CodexCompanion = {
        isKeepAwakeEnabled: () => true, setKeepAwake: () => {},
        keyboardOverlaySupported: () => true, appVersion: () => '1.3.0',
      };
      window.companionKeyboard = { bottomPx: 0, durationMs: 0 };
    });
    const sample = { source: 'live', message: '桌面实时同步', threads: [{
      id: 'keyboard-test', turnId: 'keyboard-turn', title: '检查进度文本触摸', project: 'Codex 副屏',
      status: 'running', live: true, canControl: true, model: 'Codex',
      startedAt: Date.now() / 1000 - 30, updatedAt: Date.now() / 1000, requests: [],
      events: [
        { id: 'command', kind: 'commandExecution', label: '执行命令', status: 'completed', text: 'npm run build', at: Date.now() },
        { id: 'file', kind: 'fileChange', label: '更新文件', status: 'completed', text: 'public/app.css', at: Date.now() },
        ...Array.from({ length: 6 }, (_, index) => ({ id: `progress-${index}`, kind: 'agentMessage', label: '执行进度', status: 'info', text: '正在检查手机端展示。', at: Date.now() })),
      ],
    }] };
    await page.route('**/api/state', route => route.fulfill({ json: sample }));
    await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
    await page.route('**/api/action', route => { calls.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await page.goto(base);
    await page.waitForFunction(() => state.data?.threads[0]?.id === 'keyboard-test');
    await page.evaluate(() => { state.events.close(); openDetail(state.data.threads[0].id); });
    await page.waitForTimeout(250);
    const surfaces = () => page.evaluate(() => Object.fromEntries(['.detail-dialog', '.message-composer', '.event', '.event-label', '.command-text', '.task-card'].map(selector => {
      const css = getComputedStyle(document.querySelector(selector));
      return [selector, { background: css.backgroundImage, color: css.color, shadow: css.boxShadow, filter: css.backdropFilter, tap: css.webkitTapHighlightColor }];
    })));
    const idleSurfaces = await surfaces();
    for (const selector of ['.event', '.event-label', '.command-text']) assert.equal(idleSurfaces[selector].tap, 'rgba(0, 0, 0, 0)', `${selector} has no Android tap overlay`);

    for (const label of ['执行命令', '更新文件']) {
      await page.locator('#messageInput').fill('点击进度文本收起键盘，保留这段草稿');
      await page.evaluate(() => { window.companionKeyboard = { bottomPx: 220 * devicePixelRatio, durationMs: 180 }; window.dispatchEvent(new Event('companionkeyboardchange')); });
      await page.waitForTimeout(230);
      assert.deepEqual(await surfaces(), idleSurfaces, 'focusing the composer never swaps conversation or background surfaces');
      const timeline = page.locator('.event').filter({ has: page.locator('.event-label', { hasText: label }) }).first();
      const before = await timeline.screenshot();
      await page.evaluate(() => { window.retainedTimeline = document.querySelector('.detail-timeline'); window.retainedComposer = document.querySelector('#messageComposer'); });
      await page.locator('.event-label').filter({ hasText: label }).tap();
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'messageInput', 'touching progress text dismisses input focus');
      await page.evaluate(() => { window.companionKeyboard = { bottomPx: 0, durationMs: 220 }; window.dispatchEvent(new Event('companionkeyboardchange')); });
      await nextFrame(page);
      assert(await page.locator('#detailDialog').evaluate(dialog => dialog.classList.contains('composer-docked')), 'closing keeps the sheet locked while the composer is returning');
      assert(await page.locator('#messageComposer').evaluate(form => form.getBoundingClientRect().bottom < innerHeight - 50), 'blur does not snap the composer straight to its resting position');
      assert.deepEqual(await surfaces(), idleSurfaces, 'touching progress text does not restore a different background or glass filter');
      // Native onEnd can arrive just before the final CSS animation frame.
      await page.evaluate(() => { window.companionKeyboard = { bottomPx: 0, durationMs: 0 }; window.dispatchEvent(new Event('companionkeyboardchange')); });
      await page.waitForFunction(() => !document.querySelector('#detailDialog').classList.contains('composer-docked'));
      await page.waitForTimeout(50);
      assert.deepEqual(await surfaces(), idleSurfaces, 'closing leaves the surface appearance unchanged');
      const after = await timeline.screenshot();
      if (!after.equals(before)) {
        await fs.writeFile(path.resolve(__dirname, '../outputs/text-before.png'), before);
        await fs.writeFile(path.resolve(__dirname, '../outputs/text-after.png'), after);
      }
      assert(after.equals(before), 'ordinary progress text has identical pixels before and after keyboard dismissal');
      assert(await page.evaluate(() => retainedTimeline === document.querySelector('.detail-timeline') && retainedComposer === document.querySelector('#messageComposer')), 'taps never rebuild progress records or the input');
      assert.equal(await page.locator('#messageInput').inputValue(), '点击进度文本收起键盘，保留这段草稿');
      assert(await page.locator('#messageComposer').evaluate(form => Math.abs(form.getBoundingClientRect().bottom - innerHeight) < 2));
      assert.equal(calls.length, 0, 'plain progress text never submits a desktop action');
    }
    await page.screenshot({ path: path.resolve(__dirname, '../outputs/mobile-keyboard-dismiss-v20.png'), animations: 'disabled' });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ progressTextTouch: true, noTapOverlay: true, stableSurfaces: true, identicalTimelinePixels: true, smoothKeyboardDismissal: true, drafts: true, noDesktopActions: true, errors: errors.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
