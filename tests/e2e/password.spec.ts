import { test, expect } from '@playwright/test';
test('客户在登录页用六位密码注册，并凭当前密码修改后重新登录', async ({ page }, info) => {
  const email = 'password-' + info.project.name + '-' + Date.now() + '@fiction.invalid';
  await page.goto('/');
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await page.getByLabel('你的名字', { exact: true }).fill('改密体验用户');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('设置密码（至少 6 位）', { exact: true }).fill('123456');
  await page.getByLabel('确认密码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '注册并继续', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '你好，改密体验用户', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '切换账号', exact: true }).click();
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('当前密码', { exact: true }).fill('123456');
  await page.getByLabel('新密码（至少 6 位）', { exact: true }).fill('654321');
  await page.getByLabel('确认新密码', { exact: true }).fill('654322');
  await page.getByRole('button', { name: '确认修改密码', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的新密码不一致');
  await page.getByLabel('确认新密码', { exact: true }).fill('654321');
  await page.screenshot({
    path: '.local/reports/playwright/' + info.project.name + '-change-password.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '确认修改密码', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('密码已修改');
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(email);
  await page.getByLabel('密码', { exact: true }).fill('654321');
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '你好，改密体验用户', exact: true }),
  ).toBeVisible();
});
