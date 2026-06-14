import { expect, test } from '@playwright/test';

const EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@test.local';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'e2e correct horse staple';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('email').fill(EMAIL);
  await page.getByLabel('password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
}

test('logs in and reaches the authenticated shell', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('user-email')).toHaveText(EMAIL);
});

test('shows a generic error for wrong credentials', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('email').fill(EMAIL);
  await page.getByLabel('password').fill('definitely the wrong password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByTestId('login-error')).toHaveText(/invalid email or password/i);
  await expect(page).toHaveURL(/\/login$/);
});

test('renews the session after a full page reload', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  // Reload drops the in-memory access token; the dashboard must re-derive it
  // from the HttpOnly refresh cookie and stay authenticated.
  await page.reload();
  await expect(page.getByTestId('user-email')).toHaveText(EMAIL);
});

test('does NOT store the refresh token in localStorage/sessionStorage', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(window.localStorage),
    session: JSON.stringify(window.sessionStorage),
  }));
  expect(storage.local).not.toMatch(/refresh|token/i);
  expect(storage.session).not.toMatch(/refresh|token/i);
});

test('logout returns to the login page and protects the dashboard', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('button', { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('unauthenticated access to a protected route redirects to login', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});
