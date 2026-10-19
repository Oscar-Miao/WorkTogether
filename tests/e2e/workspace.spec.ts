import { test, expect, type Page } from '@playwright/test';
async function contextPanel(page: Page) {
  const panel = page.locator('#chat-sidebar');
  if (await panel.count()) {
    if ((await panel.locator('h2').first().innerText()) === '协作上下文') return;
    await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
  }
  await page.getByRole('button', { name: '查看协作上下文', exact: true }).click();
}
test('integrated chat creates groups, coordinates human work, rejects duplicates and keeps a single sidebar', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('browser@test.local');
  await page.getByLabel('密码', { exact: true }).fill('Browser-test-only-password-2026');
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目讨论', exact: true })).toBeVisible();
  const mobile = info.project.name === 'mobile';
  if (mobile) await page.getByRole('button', { name: '打开群聊列表', exact: true }).click();
  await page.getByRole('button', { name: '创建或加入群聊', exact: true }).click();
  const groupName = '正式群聊验收 ' + info.project.name;
  await page.getByLabel('群聊名称', { exact: true }).fill(groupName);
  await page.getByLabel('加入方式').selectOption('private');
  await page.getByRole('button', { name: '创建并进入', exact: true }).click();
  await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible();
  const chatNav = page.locator('.c-rail [aria-label="群聊"]');
  await expect(chatNav).toHaveAttribute('aria-current', 'page');
  await expect(chatNav).toHaveClass(/active/);
  async function send(text: string) {
    const x = page.getByRole('button', { name: '关闭右侧栏', exact: true });
    if (mobile && (await x.isVisible())) await x.click();
    await page.getByRole('textbox', { name: '群消息输入', exact: true }).fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
  }
  await send('我来做 发布验收文档梳理 ' + info.project.name);
  await page.getByRole('button', { name: '我来做', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认人工认领', exact: true }).click();
  await expect(page.locator('.c-timeline .c-goal.claimed')).toBeVisible();
  await send('@AI 发布验收文档梳理 ' + info.project.name);
  await expect(page.locator('.c-timeline .c-goal.rejected')).toContainText('本次不重复启动');
  await page
    .locator('.c-timeline .c-goal.rejected')
    .getByRole('button', { name: '补充差异 / 复核', exact: true })
    .click();
  await page.getByLabel('修正后的目标').fill('分析另一个范围的联调检查项');
  await page.getByLabel('原因 / 与既有工作的差异').fill('验收范围与人工文档工作不同');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '补充差异并复核', exact: true })
    .click();
  await expect(page.locator('.c-timeline .c-goal.clarifying')).toContainText('策略');
  await contextPanel(page);
  await expect(page.locator('#shared-documents')).toBeAttached();
  await expect(
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '项目共享资料', exact: true }),
  ).toHaveCount(0);
  if (!mobile) {
    await expect(
      page.getByRole('button', { name: '协作上下文与项目资料', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '协作上下文与项目资料', exact: true }).click();
    await expect(page.locator('#chat-sidebar')).toHaveCount(0);
    await expect(chatNav).toHaveClass(/active/);
  } else await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
  await page.getByRole('button', { name: '群成员', exact: true }).click();
  await expect(page.locator('#chat-sidebar')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(chatNav).toHaveClass(/active/);
  await page.getByRole('button', { name: '查看群邀请码', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.c-invite-code')).toHaveText(/[A-Za-z0-9_-]{30,}/);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  const ownMention = page
    .locator('#chat-sidebar')
    .getByRole('button', { name: /提及群成员/ })
    .first();
  await ownMention.click();
  if (!mobile) await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
  const input = page.getByRole('textbox', { name: '群消息输入', exact: true });
  await expect(input).toHaveValue(/^@.+ /);
  await input.fill('@');
  await expect(page.getByRole('option', { name: /@AI/ })).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).not.toHaveValue('@AI ');
  await input.fill('');
  await contextPanel(page);
  await page
    .locator('#shared-documents')
    .getByRole('button', { name: '添加', exact: true })
    .click();
  const sourceName = '真实共享资料 ' + info.project.name;
  await page.getByLabel('资料名称', { exact: true }).fill(sourceName);
  await page
    .getByLabel('资料正文', { exact: true })
    .fill('明确限制：不推送、不部署。引用正文必须保留。');
  await page.getByRole('dialog').getByRole('button', { name: '添加资料', exact: true }).click();
  const doc = page.locator('.c-doc').filter({ hasText: sourceName });
  await expect(doc).toBeVisible();
  await doc.getByRole('button', { name: '引用到消息', exact: true }).click();
  if (!mobile) await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
  await expect(page.locator('.c-reference-chips')).toContainText(sourceName);
  await input.fill('引用先保留在草稿');
  await page.reload();
  await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible();
  await expect(input).toHaveValue('引用先保留在草稿');
  await expect(page.locator('.c-reference-chips')).toContainText(sourceName);
  await contextPanel(page);
  await page.screenshot({
    path: '.local/reports/playwright/' + info.project.name + '-chat-v2.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
  await page.getByRole('button', { name: 'Owner 主设备状态', exact: true }).click();
  await expect(page.getByRole('heading', { name: '主设备执行策略', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '连接设备', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '已在本机运行', exact: true }).click();
  await expect(chatNav).toHaveClass(/active/);

  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
  expect(errors).toEqual([]);
});
