// Public screenshots use fixed fictional data and never a real Codex session.
const { base, launchBrowser } = require('../tests/browser-helper.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const output = path.resolve(__dirname, '../docs/images');
  await fs.mkdir(output, { recursive: true });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const now = 1784001600;
    const event = (id, text) => ({ id, kind: 'agentMessage', status: 'info', label: '最新执行消息', text, at: now * 1000 });
    const sample = { source: 'live', message: '桌面实时同步', serverTime: now, threads: [
      { id: 'demo-website', turnId: 'demo-turn', title: '完善产品介绍页', project: '示例项目', status: 'running', live: true, canControl: true, startedAt: now - 428, updatedAt: now, model: 'Codex', requests: [], events: [event('demo-message', '页面布局已完成，正在检查手机端的阅读和交互效果。')] },
      { id: 'demo-review', turnId: 'demo-review-turn', title: '检查数据导出功能', project: '示例项目', status: 'approval', live: true, canControl: true, startedAt: now - 192, updatedAt: now, model: 'Codex', requests: [{ id: 'demo-request', kind: 'approval', label: '等待审批', reason: '需要你确认下一步操作。', actionable: false }], events: [event('demo-message-2', '验证已准备就绪，等待你确认后继续。')] },
    ] };
    await page.route('**/api/state', route => route.fulfill({ json: sample }));
    await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': demo\n\n' }));
    await page.goto(base);
    await page.waitForFunction(() => state.data?.threads[0]?.id === 'demo-website');
    await page.evaluate(data => { state.events.close(); acceptData(data); }, sample);
    await page.screenshot({ path: path.join(output, 'tasks.png'), animations: 'disabled' });
    sample.threads[0].events[0].text = '## 本轮进展\n\n**手机展示已完成**，现在可以继续验证。\n\n- 状态清晰，任务独立展示\n- 输入时保留草稿\n- 使用电脑现有会话\n\n> 手机与电脑连接同一局域网即可。\n\n```js\nconst status = "ready";\n```\n\n| 检查项 | 结果 |\n| --- | --- |\n| 手机布局 | 已完成 |\n| 连接恢复 | 已完成 |';
    await page.evaluate(data => { acceptData(data); openDetail('demo-website'); document.activeElement.blur(); }, sample);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(output, 'markdown.png'), animations: 'disabled' });
    console.log('Generated docs/images/tasks.png and markdown.png using fictional data.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
