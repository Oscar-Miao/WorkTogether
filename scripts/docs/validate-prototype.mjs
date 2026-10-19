import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(root, '..'),
  report = resolve(root, '.local/reports/prd-v2-review');
await mkdir(report, { recursive: true });
const prototype = resolve(project, '03_群聊协作原型.html');
const source = await readFile(prototype, 'utf8');
for (const match of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
assert(
  !/<script[^>]+src=|<link[^>]+href=|fetch\s*\(/i.test(source),
  'Prototype must be offline and independent',
);
const docResults = [];
for (const base of ['01_MVP需求文档', '02_进阶版需求文档']) {
  const md = await readFile(resolve(project, base + '.md'), 'utf8'),
    html = await readFile(resolve(project, base + '.html'), 'utf8');
  const hash = createHash('sha256').update(md).digest('hex');
  assert(
    html.includes('content="' + hash + '"'),
    'HTML must correspond exactly to its Markdown source',
  );
  assert(md.includes('版本：2.0') && html.includes('v2.0'));
  const headings = [...md.matchAll(/^#{1,4}\s+/gm)].length;
  assert.equal([...html.matchAll(/<h[1-4] id="section-/g)].length, headings);
  for (const link of html.matchAll(/href="#(section-\d+)"/g))
    assert(html.includes('id="' + link[1] + '"'));
  assert(
    !/<script[^>]+src=|<link[^>]+href=/i.test(html),
    'Review documents must be self-contained',
  );
  docResults.push({ document: base, headings, source_sha256: hash });
}
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      timezoneId: 'Asia/Shanghai',
    });
    const page = await context.newPage(),
      errors = [],
      network = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) network.push(request.url());
    });
    await page.goto(pathToFileURL(prototype).href);
    await page.getByRole('heading', { name: '产品研发组', exact: true }).waitFor();
    await page.screenshot({ path: resolve(report, name + '-initial.png'), fullPage: true });
    const checks = [];
    async function menu() {
      const button = page.getByRole('button', { name: '打开群聊列表', exact: true });
      if (
        (await button.isVisible()) &&
        !(await page.locator('#group-panel').evaluate((el) => el.classList.contains('show')))
      )
        await button.click();
    }
    async function closeMenus() {
      for (const label of ['关闭群聊列表', '关闭右侧栏']) {
        const button = page.getByRole('button', { name: label, exact: true });
        if (await button.isVisible()) await button.click();
      }
    }
    async function send(text) {
      await closeMenus();
      await page.getByRole('textbox', { name: '群消息输入', exact: true }).fill(text);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
    }
    async function until(fn) {
      await page.waitForFunction(fn, null, { timeout: 8000 });
    }
    async function closeDetails() {
      if (await page.locator('dialog[open]').count())
        await page.getByRole('button', { name: '关闭详情', exact: true }).click();
      else await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
    }
    async function showContext() {
      if (await page.locator('#context-panel').isVisible()) {
        if ((await page.locator('#context-panel h2').innerText()) === '协作上下文') return;
        await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
      }
      await page.getByRole('button', { name: '查看协作上下文', exact: true }).click();
    }
    const panel = page.locator('#context-panel');
    async function assertChatActive() {
      const chatNav = page.locator('.rail [data-action="groups"]');
      assert.equal(await chatNav.getAttribute('aria-current'), 'page');
      assert(await chatNav.evaluate((el) => el.classList.contains('active')));
    }
    await assertChatActive();
    assert.equal(await page.locator('.rail [data-action="panel-docs"]').count(), 0);
    assert.equal(await page.locator('.rail [data-action="panel-context"]').count(), 1);
    if (viewport.width > 760) {
      const toggle = page.locator('.rail [data-action="panel-context"]');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
      assert(await page.locator('#shared-documents').isVisible());
      assert((await page.locator('#context-panel .goal-card').count()) > 0);
      const before = await page.locator('.chat').evaluate((el) => el.getBoundingClientRect().width);
      await toggle.click();
      assert.equal(await panel.isVisible(), false);
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      await assertChatActive();
      assert(
        (await page.locator('.chat').evaluate((el) => el.getBoundingClientRect().width)) >
          before + 200,
      );
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    } else {
      assert.equal(await panel.isVisible(), false);
      await showContext();
      assert.equal(await page.getByRole('tab', { name: '项目共享资料', exact: true }).count(), 0);
    }
    await assertChatActive();
    assert(await page.locator('#shared-documents').isVisible());
    assert((await page.locator('#context-panel .goal-card').count()) > 0);
    checks.push('上下文和资料合并为单一入口及同一侧栏内容，可开关且聊天宽度正确');
    await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
    await page.getByRole('button', { name: '引用资料', exact: true }).click();
    assert.equal(await page.locator('#context-panel h2').innerText(), '协作上下文');
    await assertChatActive();
    assert(await page.locator('#shared-documents').isVisible());
    const sidebarHeaderBounds = await page.locator('.context-head').boundingBox();
    assert(
      sidebarHeaderBounds.y >= 0 &&
        sidebarHeaderBounds.y + sidebarHeaderBounds.height <= viewport.height,
      'Sidebar title and close control stay within the viewport while documents scroll',
    );
    const documentBounds = await page.locator('#shared-documents').boundingBox();
    assert(documentBounds.y >= sidebarHeaderBounds.y + sidebarHeaderBounds.height);
    await page.screenshot({ path: resolve(report, name + '-documents.png'), fullPage: true });
    await page.getByRole('button', { name: '查看成果', exact: true }).click();
    assert.equal(await page.locator('#context-panel h2').innerText(), '共享成果');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('.context.is-open').count(), 1);
    await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
    await page.getByRole('button', { name: '群成员', exact: true }).click();
    assert.equal(await page.locator('#context-panel h2').innerText(), '群成员');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('.context.is-open').count(), 1);
    await page.screenshot({ path: resolve(report, name + '-members.png'), fullPage: true });
    if (viewport.width > 760) {
      await page.locator('.rail [data-action="panel-context"]').click();
      assert.equal(await page.locator('#context-panel h2').innerText(), '协作上下文');
      assert.equal(
        await page
          .getByRole('button', { name: '群成员', exact: true })
          .getAttribute('aria-pressed'),
        'false',
      );
    } else await page.getByRole('tab', { name: '协作上下文', exact: true }).click();
    await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
    await page.getByRole('button', { name: '群成员', exact: true }).click();
    if (viewport.width > 760)
      await page.getByRole('button', { name: '群成员', exact: true }).click();
    else await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
    assert.equal(await panel.isVisible(), false);
    await assertChatActive();
    checks.push('群成员内嵌于同一侧栏，切换互斥且可再次关闭');
    checks.push('群聊为常驻页面，侧栏切换或全关闭时群聊导航持续高亮');
    assert.equal(
      await page.locator('.project-switch use[href="#i-down"],button.project-switch').count(),
      0,
    );
    checks.push('工作空间标题不再提供重复的下拉入口');
    await showContext();
    if (viewport.width < 1180)
      await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
    const input = page.getByRole('textbox', { name: '群消息输入', exact: true });
    await page.getByRole('button', { name: '提及 AI 或群成员', exact: true }).click();
    await page.getByRole('option', { name: /@AI/ }).waitFor();
    await page.getByRole('option', { name: /@陈默/ }).waitFor();
    await page.getByRole('option', { name: /@林可/ }).waitFor();
    await page.screenshot({ path: resolve(report, name + '-mentions.png'), fullPage: true });
    await input.fill('@林');
    await page.getByRole('option', { name: /@林可/ }).waitFor();
    const messagesBefore = await page.locator('#timeline article').count();
    await input.press('Enter');
    assert.equal(await input.inputValue(), '@林可 ');
    assert.equal(await page.locator('#timeline article').count(), messagesBefore);
    const agentBefore = await page.locator('#timeline .service-tag').count();
    await input.fill('@林可 请确认交互稿。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('#timeline .member-mention').last().waitFor();
    await page.waitForTimeout(450);
    assert.equal(
      await page.locator('#timeline .service-tag').count(),
      agentBefore,
      'Mentioning a member must not invoke AI',
    );
    await input.fill('@');
    await input.press('ArrowDown');
    await input.press('Tab');
    assert.equal(await input.inputValue(), '@陈默 ');
    await input.fill('@');
    await input.press('Escape');
    assert.equal(await page.locator('#mention-picker').isVisible(), false);
    await input.fill('');
    await page.getByRole('button', { name: '提及 AI 或群成员', exact: true }).click();
    await page.getByRole('option', { name: /@AI/ }).click();
    assert.equal(await input.inputValue(), '@AI ');
    await input.fill('');
    await closeMenus();
    checks.push('AI与当前群成员可搜索点选及键盘提及，成员消息不会误唤起Agent');

    await page.getByRole('button', { name: '识别已有工作', exact: true }).click();
    await page.getByText('已有同范围工作，这次不重复启动', { exact: true }).waitFor();
    checks.push('同范围请求关联人工认领并拒绝重复执行');
    await page.screenshot({ path: resolve(report, name + '-duplicate.png'), fullPage: true });
    await page.getByRole('button', { name: '这次需求有不同', exact: true }).click();
    await page.getByRole('button', { name: '填入企业 SSO 示例', exact: true }).click();
    await page.getByRole('button', { name: '提交复核', exact: true }).click();
    await page.locator('.agent-card .decision.approved').first().waitFor();
    await page
      .getByText('与 林可 的人工认领目录有交集，等待明确分工，目标本身有效。', { exact: true })
      .waitFor();
    checks.push('复核形成不同验收目标，批准后按资源冲突排队');
    await page.getByRole('button', { name: '推进新目标', exact: true }).click();
    await page.getByRole('button', { name: '查看成果', exact: true }).waitFor({ timeout: 8000 });
    await page.getByRole('button', { name: '查看成果', exact: true }).click();
    await page.getByText('共享成果', { exact: true }).waitFor();
    assert((await page.locator('.result-text').innerText()).includes('没有调用真实模型'));
    await closeDetails();
    checks.push('独立新目标批准、演示进度和成果回流');
    await page.getByRole('button', { name: '叫停旧方案', exact: true }).click();
    await page.getByText('既有执行已停止，内容保留', { exact: true }).waitFor();
    checks.push('明确讨论变更由主 Agent 自动形成停止判断');
    await showContext();
    await page.locator('.mini-stop[data-id="G-022"]').click();
    await page
      .getByRole('textbox', { name: '停止原因', exact: true })
      .fill('团队已确认切换方案，先停止旧实现，保留现有内容。');
    await page.getByRole('button', { name: '请求停止此执行', exact: true }).click();
    await page.getByText('既有执行已停止，内容保留', { exact: true }).nth(1).waitFor();
    await closeMenus();
    checks.push('停止只针对既有执行，等待回执并保留成果');
    await menu();
    await page.getByRole('button', { name: '创建或加入群聊', exact: true }).click();
    await page.getByRole('textbox', { name: '群聊名称', exact: true }).fill('原型评审组 ' + name);
    await page
      .getByRole('textbox', { name: '群聊简介', exact: true })
      .fill('一起讨论目标识别与团队分工');
    await page.getByRole('button', { name: '创建并进入', exact: true }).click();
    await page.getByRole('heading', { name: '原型评审组 ' + name, exact: true }).waitFor();
    await page.getByRole('button', { name: '群成员', exact: true }).click();
    await page.getByRole('button', { name: '查看群邀请码', exact: true }).click();
    assert((await page.locator('.invite-code').innerText()).startsWith('CG'));
    await closeDetails();
    checks.push('成员自主建群、Agent 参与和邀请码展示');
    await page.getByRole('button', { name: '提及群成员 许舟', exact: true }).click();
    assert.equal(await input.inputValue(), '@许舟 ');
    await closeMenus();
    await input.fill('@');
    assert.equal(await page.getByRole('option').count(), 2);
    assert.equal(await page.getByRole('option', { name: /@林可/ }).count(), 0);
    await input.fill('');
    checks.push('成员侧栏可直接提及，切群后候选仅含本群人员');
    await send('我来做 发布验收文档梳理与整理。');
    await page.getByRole('button', { name: '我来做', exact: true }).waitFor();
    await page.getByRole('button', { name: '我来做', exact: true }).click();
    await page
      .locator('#timeline')
      .getByText(/许舟已确认人工认领/)
      .waitFor();
    checks.push('普通讨论形成候选，人工确认认领进入协作记录');
    await menu();
    await page.getByRole('button', { name: '创建或加入群聊', exact: true }).click();
    await page.getByRole('button', { name: '邀请码加入', exact: true }).click();
    await page.getByRole('textbox', { name: '群邀请码', exact: true }).fill('WRONG');
    await page.getByRole('button', { name: '加入群聊', exact: true }).click();
    await page.getByText('邀请码不存在或已失效。演示可用 TEAM2026。', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '群邀请码', exact: true }).fill('TEAM2026');
    await page.getByRole('button', { name: '加入群聊', exact: true }).click();
    await page.getByRole('heading', { name: '接口与数据', exact: true }).waitFor();
    checks.push('邀请码错误反馈与加入成功');
    await page.getByRole('textbox', { name: '群消息输入', exact: true }).fill('切群后仍保留的草稿');
    await menu();
    await page.getByRole('button', { name: '打开群聊 产品研发组', exact: true }).click();
    await menu();
    await page.getByRole('button', { name: '打开群聊 接口与数据', exact: true }).click();
    assert.equal(
      await page.getByRole('textbox', { name: '群消息输入', exact: true }).inputValue(),
      '切群后仍保留的草稿',
    );
    checks.push('切群保留独立草稿');
    await page.getByRole('textbox', { name: '群消息输入', exact: true }).fill('');
    await send('> @AI 再做登录页');
    const before = await page.locator('.agent-card').count();
    await page.waitForTimeout(850);
    assert.equal(
      await page.locator('.agent-card').count(),
      before,
      'Quoted mentions must not trigger a request',
    );
    await send('```text\n@AI 整理一个新目标');
    assert.equal(await page.locator('#mention-picker').isVisible(), false);
    await page.waitForTimeout(850);
    assert.equal(
      await page.locator('.agent-card').count(),
      before,
      'Unclosed fenced code must not invoke AI',
    );
    checks.push('引用与未闭合代码块中的 @AI 不唤起执行');
    await page.getByRole('button', { name: '引用资料', exact: true }).click();
    await page.getByRole('button', { name: '引用到消息', exact: true }).first().click();
    await page.locator('.ref-chip').waitFor();
    checks.push('页内查看共享资料并引用');
    await page.reload();
    await page.getByRole('heading', { name: '接口与数据', exact: true }).waitFor();
    await page.locator('.ref-chip').waitFor();
    checks.push('原型本机状态与引用可恢复');
    await page.getByRole('button', { name: 'Owner 主设备状态', exact: true }).click();
    await page
      .getByText(
        'Owner 是承载主协调 Agent 的服务器设备，不是某位人工审批管理员。成员负责讨论、纠正与协作，主 Agent 在设备预设策略内作出判断。',
        { exact: true },
      )
      .waitFor();
    await page.screenshot({ path: resolve(report, name + '-node.png'), fullPage: true });
    await closeDetails();
    await assertChatActive();
    checks.push('Owner 设备语义和自动判断职责清晰');
    await send('@AI 整理接口约定说明');
    await page.getByText('已有有效成果，先复用', { exact: true }).waitFor();
    checks.push('已完成成果按范围复用，拒绝重做');
    await menu();
    await page.locator('[data-action="guide"]').click();
    await page.getByRole('button', { name: '模拟执行服务离线', exact: true }).click();
    await closeMenus();
    await send('@AI 整理本周发布验收检查清单。');
    await page.getByText('请求已记录，等待主设备恢复', { exact: true }).waitFor();
    assert.equal(
      await page.locator('.agent-card .decision.approved').count(),
      0,
      'Offline node must not approve new work',
    );
    await menu();
    await page.locator('[data-action="guide"]').click();
    await page.getByRole('button', { name: '恢复执行服务', exact: true }).click();
    await closeMenus();
    await page.getByRole('button', { name: '查看成果', exact: true }).waitFor({ timeout: 8000 });
    checks.push('离线保留请求，恢复后处理且不伪造已启动');
    const dimensions = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
    }));
    assert(dimensions.width <= dimensions.viewport, 'No horizontal overflow');
    assert.deepEqual(errors, [], 'No page JavaScript errors');
    assert.deepEqual(network, [], 'No external HTTP requests');
    await page.screenshot({ path: resolve(report, name + '-final.png'), fullPage: true });
    results.push({
      viewport: name,
      checks,
      js_errors: errors,
      external_requests: network.length,
      horizontal_overflow: false,
    });
    console.log(name + ': ' + checks.length + ' interaction checks passed');
    await context.close();
  }
  for (const base of ['01_MVP需求文档', '02_进阶版需求文档']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(pathToFileURL(resolve(project, base + '.html')).href);
    await page.screenshot({ path: resolve(report, base + '-desktop.png'), fullPage: false });
    assert.equal(await page.locator('article').count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    const dimensions = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
    }));
    assert(dimensions.width <= dimensions.viewport, 'Documents must not overflow on mobile');
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(
  resolve(report, 'validation.json'),
  JSON.stringify(
    {
      date: '2026-10-18',
      prototype: '03_群聊协作原型.html',
      scope: 'local synthetic UI only; not v2 backend/model acceptance',
      documents: docResults,
      browsers: results,
    },
    null,
    2,
  ),
);
console.log('Markdown/HTML consistency, offline behavior and review screenshots verified.');
