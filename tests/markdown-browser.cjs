const { base, launchBrowser } = require('./browser-helper.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [], outsideRequests = [], desktopActions = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.CodexCompanion = { isKeepAwakeEnabled: () => true, setKeepAwake: () => {}, keyboardOverlaySupported: () => true, appVersion: () => '1.3.0' };
    });
    const markdown = [
      '## 已完成手机端优化', '',
      '**重点功能**：支持 *Markdown*、~~旧样式~~ 和 `行内代码`。', '',
      '- 消息按结构展示', '- 保留手机上的输入草稿', '  - 新进度到达时不打断输入', '',
      '1. 打开会话', '2. 查看最新进展', '',
      '> 点击普通文字不会执行命令。', '',
      '- [x] 标题与列表', '- [ ] 后续事项', '',
      '```js', 'const message = "<script>只是代码</script>";', `const longValue = "${'very-long-code-'.repeat(20)}";`, '```', '',
      '| 项目 | 当前状态 | 检查方式 | 后续安排 |', '| --- | :---: | --- | ---: |', '| 手机展示 | 已完成 | 查看页面 | 继续使用 |', '',
      '[查看说明](https://example.com/help "说明")', '',
      '---', '',
      '普通换行也会保留。', '这是下一行。',
    ].join('\n');
    const sample = { source: 'live', message: '桌面实时同步', threads: [{
      id: 'markdown-demo', turnId: 'md-turn', title: '优化 Markdown 消息展示', project: 'Codex 副屏', status: 'running',
      live: true, canControl: true, model: 'Codex', startedAt: Date.now() / 1000 - 70, updatedAt: Date.now() / 1000, requests: [],
      events: [
        { id: 'md', kind: 'agentMessage', label: 'Codex 进度', status: 'info', text: markdown, at: Date.now() },
        { id: 'cmd', kind: 'commandExecution', label: '执行命令', status: 'completed', text: 'echo "**literal**" && ls *.js', at: Date.now() },
        { id: 'file', kind: 'fileChange', label: '更新文件', status: 'completed', text: 'file_[1].md', at: Date.now() },
      ],
    }] };
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) { outsideRequests.push(route.request().url()); return route.abort(); }
      return route.fallback();
    });
    await page.route('**/api/state', route => route.fulfill({ json: sample }));
    await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
    await page.route('**/api/action', route => { desktopActions.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await page.goto(base);
    await page.waitForFunction(() => state.data?.threads[0]?.id === 'markdown-demo');
    assert(!(await page.locator('.message-text').textContent()).includes('##'), 'homepage preview removes Markdown syntax');
    await page.evaluate(() => { state.events.close(); openDetail(state.data.threads[0].id); });
    const body = page.locator('.event .markdown-body').first();
    assert.equal(await body.locator('h2').textContent(), '已完成手机端优化');
    assert.equal(await body.locator('strong').textContent(), '重点功能');
    assert.equal(await body.locator('em').textContent(), 'Markdown');
    assert.equal(await body.locator('del').textContent(), '旧样式');
    assert(await body.locator('ul ul li').count() > 0, 'nested lists are rendered');
    assert.equal(await body.locator('ol li').count(), 2);
    assert(await body.locator('blockquote').isVisible());
    assert.equal(await body.locator('input[type="checkbox"]:disabled').count(), 2, 'task list marks stay display-only');
    assert.equal(await body.locator('input[type="checkbox"]:checked').count(), 1);
    assert((await body.locator('pre code').textContent()).includes('<script>只是代码</script>'));
    assert.equal(await body.locator('.markdown-table th').count(), 4);
    assert.equal(await body.locator('.markdown-table th').nth(1).evaluate(node => getComputedStyle(node).textAlign), 'center');
    assert.equal(await body.locator('.markdown-table [style]').count(), 0, 'table alignment needs no inline CSS exception');
    assert.equal(await body.locator('a').getAttribute('href'), 'https://example.com/help');
    assert.equal(await body.locator('a').getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.locator('.command-text').textContent(), 'echo "**literal**" && ls *.js');
    assert.equal(await page.locator('.command-text strong').count(), 0, 'commands are never parsed as Markdown');
    const shape = () => page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth, dialog: document.querySelector('#detailDialog').scrollWidth }));
    for (const width of [320, 390, 430, 844]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const widths = await shape();
      assert(widths.document <= widths.viewport && widths.dialog <= widths.viewport, `Markdown fits phone width ${width}: ${JSON.stringify(widths)}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#messageInput').fill('这段草稿不会因 Markdown 更新消失');
    await page.locator('#messageInput').evaluate(input => { window.originalInput = input; input.setSelectionRange(3, 7); });
    sample.threads[0].events[0].text += '\n\n**实时更新已到达**';
    await page.evaluate(data => acceptData(data), sample);
    assert(await page.evaluate(() => document.activeElement === originalInput && originalInput.selectionStart === 3 && originalInput.selectionEnd === 7));
    assert.equal(await page.locator('#messageInput').inputValue(), '这段草稿不会因 Markdown 更新消失');
    // HTML and special links must remain inert even without relying on CSP.
    const attacks = [
      '<script>window.markdownExecuted=true</script>', '<img src="https://example.com/tracker" onerror="window.markdownExecuted=true">',
      '[bad](javascript:alert(1))', '[bad](java&#x73;cript:alert(1))', '[bad](data:text/html,attack)',
      '[bad](file:///tmp/private)', '[bad](intent://attack)', '[bad](//example.com/relative)',
      '[bad](https://user:pass@example.com/)', '![不自动加载的图片](https://example.com/image.png)',
      '<form id="messageComposer"><button data-decision="accept">伪造按钮</button></form>',
    ];
    const result = await page.evaluate(text => {
      const container = document.createElement('div'); container.innerHTML = renderMarkdown(text);
      document.body.append(container);
      const result = { active: container.querySelectorAll('script, img, iframe, form, button, a, [onclick], [onerror]').length, text: container.textContent };
      container.remove(); return result;
    }, attacks.join('\n\n'));
    assert.equal(result.active, 0, 'untrusted HTML, images and custom-scheme links cannot become active DOM');
    assert(result.text.includes('<script>'), 'embedded HTML is displayed literally');
    assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
    assert.equal(outsideRequests.length, 0, 'formatting never fetches third-party assets');
    assert.equal(desktopActions.length, 0, 'rendering does not submit desktop actions');
    await page.locator('#messageInput').blur();
    await page.locator('.detail-body').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.resolve(__dirname, '../outputs/mobile-markdown-v21.png'), animations: 'disabled' });
    await body.locator('.markdown-table').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve(__dirname, '../outputs/mobile-markdown-code-v21.png'), animations: 'disabled' });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ markdown: true, lists: true, code: true, tables: true, safeLinks: true, literalCommands: true, safeHTML: true, responsive: true, draftsAndFocus: true, noExternalAssets: true, errors: errors.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
