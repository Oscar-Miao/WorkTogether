import { test, expect } from '@playwright/test';

test('客户在同一页面创建项目、切换范围、分叉讨论并归档恢复', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('browser@test.local');
  await page.getByLabel('密码', { exact: true }).fill('Browser-test-only-password-2026');
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目讨论', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Owner 主设备状态', exact: true }).click();
  await page.locator('summary').filter({ hasText: '空间、项目与成员范围' }).click();
  const suffix = info.project.name + '-' + Date.now();
  await page.getByLabel('或创建新空间', { exact: true }).fill('体验空间-' + suffix);
  await page.getByLabel('新项目名称', { exact: true }).fill('体验项目-' + suffix);
  await page.getByRole('button', { name: '创建项目并进入', exact: true }).click();
  await expect(page).toHaveURL(/project=prj_/);
  const mobile = info.project.name === 'mobile';
  if (mobile) await page.getByRole('button', { name: '打开群聊列表', exact: true }).click();
  await expect(page.locator('.c-space')).toContainText('体验空间-' + suffix);
  await page.getByRole('button', { name: '创建或加入群聊', exact: true }).click();
  const group = '体验群-' + suffix;
  await page.getByLabel('群聊名称', { exact: true }).fill(group);
  await page.getByRole('button', { name: '创建并进入', exact: true }).click();
  await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible();
  const close = page.getByRole('button', { name: '关闭右侧栏', exact: true });
  if (mobile && (await close.isVisible())) await close.click();
  await page.getByRole('textbox', { name: '群消息输入', exact: true }).fill('方案讨论祖先内容');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.c-timeline')).toContainText('方案讨论祖先内容');
  await page.getByRole('button', { name: '群成员', exact: true }).click();
  await page.locator('summary').filter({ hasText: '群设置与讨论分叉' }).click();
  await page.getByLabel('分叉群名称', { exact: true }).fill('分叉-' + suffix);
  await page.getByRole('button', { name: '从当前消息分叉', exact: true }).click();
  await expect(page.getByRole('heading', { name: '分叉-' + suffix, exact: true })).toBeVisible();
  if (mobile && (await close.isVisible())) await close.click();
  await expect(page.locator('.c-timeline')).toContainText('方案讨论祖先内容');
  if (!(await page.locator('#chat-sidebar h2').filter({ hasText: '群成员' }).count()))
    await page.getByRole('button', { name: '群成员', exact: true }).click();
  await page.locator('summary').filter({ hasText: '群设置与讨论分叉' }).click();
  await page.getByRole('button', { name: '归档群聊并停止旧执行', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复群聊', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复群聊', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '归档群聊并停止旧执行', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#chat-sidebar')).toHaveCount(1);
  await page.screenshot({
    path: '.local/reports/playwright/' + info.project.name + '-project-advanced.png',
    fullPage: true,
  });
  if (mobile) {
    if (await close.isVisible()) await close.click();
    await page.getByRole('button', { name: '打开群聊列表', exact: true }).click();
  }
  await page.getByRole('button', { name: '切换空间或项目', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '共域研发空间 / 共域协作项目', exact: true })
    .click();
  await expect(page).toHaveURL(/project=project_default/);
  await expect(page.getByRole('heading', { name: '项目讨论', exact: true })).toBeVisible();
  await expect(page.locator('.c-timeline')).not.toContainText('方案讨论祖先内容');
  await page.screenshot({
    path: '.local/reports/playwright/' + info.project.name + '-advanced.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
