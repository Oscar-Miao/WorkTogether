import { test, expect } from '@playwright/test';
test('legacy history stays readable in the new chat and document edits keep full text and versions', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('browser@test.local');
  await page.getByLabel('密码', { exact: true }).fill('Browser-test-only-password-2026');
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目讨论', exact: true })).toBeVisible();
  const x = page.getByRole('button', { name: '关闭右侧栏', exact: true });
  if (await x.isVisible()) await x.click();
  for (let i = 0; i < 4; i++) {
    const older = page.getByRole('button', { name: '加载更早消息', exact: true });
    if (!(await older.count())) break;
    const n = await page.locator('.c-message').count();
    await older.click();
    await expect.poll(() => page.locator('.c-message').count()).toBeGreaterThan(n);
  }
  await expect(page.getByText('历史消息 001', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: '查看协作上下文', exact: true }).click();
  const doc = page.locator('.c-doc').filter({ hasText: '历史资料 00' });
  await doc.getByRole('button', { name: '查看资料', exact: true }).click();
  await expect(page.locator('.c-resource')).toContainText('完整资料末尾校验标记');
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '资料正文', exact: true });
  const original = await editor.inputValue();
  expect(original).toContain('完整资料末尾校验标记');
  await editor.fill(original + '\\n浏览器修改 ' + info.project.name);
  await page.getByRole('button', { name: '保存为新版本', exact: true }).click();
  await expect(page.locator('.c-resource')).toContainText('浏览器修改 ' + info.project.name);
  await expect(page.locator('#chat-sidebar h3')).toContainText(/v[23]/);
  await page.getByRole('button', { name: '关闭右侧栏', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目讨论', exact: true })).toBeVisible();
});
