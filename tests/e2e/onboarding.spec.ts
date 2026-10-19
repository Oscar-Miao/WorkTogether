import { test, expect, type Page } from '@playwright/test';

test('两位客户注册、建团队、通过邀请加入同一项目并在群内协作', async ({ page, browser }, info) => {
  test.setTimeout(60000);
  const suffix = info.project.name + '-' + Date.now();
  const password = 'Client-team-password-' + suffix;
  const alice = 'creator-' + suffix + '@client.test',
    bob = 'member-' + suffix + '@client.test';
  const workspace = '客户体验团队-' + suffix,
    project = '协作项目-' + suffix,
    group = '共同推进-' + suffix;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  async function register(target: Page, email: string, name: string) {
    await target.getByRole('button', { name: '注册账号', exact: true }).click();
    await target.getByLabel('你的名字', { exact: true }).fill(name);
    await target.getByLabel('邮箱', { exact: true }).fill(email);
    await target.getByLabel('设置密码（至少 6 位）', { exact: true }).fill(password);
    await target.getByLabel('确认密码', { exact: true }).fill(password);
    await target.getByRole('button', { name: '注册并继续', exact: true }).click();
    await expect(target.getByRole('heading', { name: '你好，' + name, exact: true })).toBeVisible();
  }
  async function openGroupList(target: Page) {
    if (info.project.name === 'mobile')
      await target.getByRole('button', { name: '打开群聊列表', exact: true }).click();
  }
  await page.goto('/');
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue('');
  await register(page, alice, '创建团队的客户');
  await page.getByRole('button', { name: '创建团队', exact: true }).click();
  await page.getByLabel('团队名称', { exact: true }).fill(workspace);
  await page.getByLabel('首个项目名称', { exact: true }).fill(project);
  await page.getByRole('button', { name: '创建团队并进入', exact: true }).click();
  await expect(page).toHaveURL(/project=prj_/);
  const projectId = new URL(page.url()).searchParams.get('project');
  await openGroupList(page);
  await page.getByRole('button', { name: '创建或加入群聊', exact: true }).click();
  await page.getByLabel('群聊名称', { exact: true }).fill(group);
  await page.getByRole('button', { name: '创建并进入', exact: true }).click();
  await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '团队与项目', exact: true }).click();
  await page.locator('summary').filter({ hasText: '邀请成员加入当前团队与项目' }).click();
  await page.getByLabel('限定受邀邮箱（可选）', { exact: true }).fill(bob);
  await page.getByRole('button', { name: '生成团队邀请', exact: true }).click();
  const link = await page.getByLabel('团队邀请链接', { exact: true }).inputValue();
  expect(link).toContain('join=');
  await page.screenshot({
    path: '.local/reports/playwright/' + info.project.name + '-team-invitation.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  const second = await browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: info.project.use.isMobile,
    hasTouch: info.project.use.hasTouch,
  });
  try {
    const visitor = await second.newPage();
    visitor.on('pageerror', (e) => errors.push(e.message));
    await visitor.goto(link);
    await register(visitor, bob, '接受邀请的客户');
    await expect(visitor.locator('.team-invite-preview')).toContainText(workspace);
    await visitor.screenshot({
      path: '.local/reports/playwright/' + info.project.name + '-join-team.png',
      fullPage: true,
    });
    await visitor.getByRole('button', { name: '确认加入并进入项目', exact: true }).click();
    await expect(visitor).toHaveURL(new RegExp('project=' + projectId));
    await openGroupList(visitor);
    await visitor.getByRole('button', { name: '创建或加入群聊', exact: true }).click();
    await visitor.getByRole('button', { name: '发现群聊', exact: true }).click();
    const card = visitor.getByRole('dialog').locator('.c-member').filter({ hasText: group });
    await card.getByRole('button', { name: '加入', exact: true }).click();
    await expect(visitor.getByRole('heading', { name: group, exact: true })).toBeVisible();
    const close = visitor.getByRole('button', { name: '关闭右侧栏', exact: true });
    if (info.project.name === 'mobile' && (await close.isVisible())) await close.click();
    await visitor
      .getByRole('textbox', { name: '群消息输入', exact: true })
      .fill('我已通过邀请加入，我们一起推进。');
    await visitor.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.c-timeline')).toContainText('我已通过邀请加入');
    await page.getByRole('button', { name: '群成员', exact: true }).click();
    await expect(page.locator('#chat-sidebar')).toContainText('接受邀请的客户');
    await visitor.getByRole('button', { name: '团队与项目', exact: true }).click();
    await expect(visitor.getByRole('dialog')).toContainText(workspace);
    await expect(visitor.getByRole('button', { name: '生成团队邀请', exact: true })).toHaveCount(0);
    expect(await visitor.locator('#chat-sidebar').count()).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    await second.close();
  }
});
