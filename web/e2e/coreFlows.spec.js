import { expect, test } from '@playwright/test';

async function signIn(page, email, password) {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('unauthenticated deep links return to sign-in', async ({ page }) => {
  await page.goto('/tickets/42');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
});

test('an employee can sign in, open sessions and sign out', async ({ page }) => {
  await signIn(page, 'employee@helpdesk.local', 'ChangeMe123!');

  await expect(page.getByRole('heading', { name: 'Employee portal' })).toBeVisible();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByRole('dialog', { name: 'Active sessions' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page).toHaveURL(/\/login$/);
});

test('a password reset request returns a generic confirmation', async ({ page }) => {
  await page.goto('/reset-password');
  await page.getByLabel('Work email').fill('nobody@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();

  await expect(page.getByText(/reset link is on its way/i)).toBeVisible();
  await expect(page.getByText(/has an account/i)).toBeVisible();
});

test('an administrator returns to a requested staff deep link', async ({ page }) => {
  await page.goto('/staff/analytics');

  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Work email').fill('admin@helpdesk.local');
  await page.getByLabel('Password').fill('ChangeMe123!');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/staff\/analytics$/);
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Incident counts by priority' })).toBeVisible();
});
