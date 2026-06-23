import { expect, test } from '@playwright/test';

const EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@test.local';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'e2e correct horse staple';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('email').fill(EMAIL);
  await page.getByLabel('password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

// Smoke: the Reports screen loads behind the auth shell; each tab reaches a
// terminal state (its table/cards, the empty state, or — if the API is
// unreachable — the error state with a retry). Requires the live API + a seeded
// user; skipped envs run the component/unit suite instead.
test('reports page opens each tab behind the auth shell', async ({ page }) => {
  await signIn(page);

  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();

  // Sales is the landing tab.
  await expect(
    page
      .getByTestId('sales-table')
      .or(page.getByTestId('sales-empty'))
      .or(page.getByTestId('sales-error')),
  ).toBeVisible();

  await page.getByTestId('reports-tab-inventory').click();
  await expect(
    page
      .getByTestId('inventory-table')
      .or(page.getByTestId('inventory-empty'))
      .or(page.getByTestId('inventory-error')),
  ).toBeVisible();

  await page.getByTestId('reports-tab-returns').click();
  await expect(
    page
      .getByTestId('returns-report-cards')
      .or(page.getByTestId('returns-report-empty'))
      .or(page.getByTestId('returns-report-error')),
  ).toBeVisible();
});
