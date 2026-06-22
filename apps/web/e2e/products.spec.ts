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

// Smoke: the Products screen loads behind the auth shell and reaches a terminal
// state (a table, the empty state, or — if the API is unreachable — the error
// state with a retry). Requires the live API + a seeded user; skipped envs run
// the component/unit suite instead.
test('products page loads behind the auth shell', async ({ page }) => {
  await signIn(page);

  await page.getByRole('link', { name: 'Products' }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();

  await expect(
    page
      .getByTestId('products-table')
      .or(page.getByTestId('products-empty'))
      .or(page.getByTestId('products-error')),
  ).toBeVisible();
});

test('opens the new-product modal', async ({ page }) => {
  await signIn(page);
  await page.goto('/products');
  await page.getByTestId('open-create').click();
  await expect(page.getByTestId('product-form-modal')).toBeVisible();
  await expect(page.getByLabel('sku')).toBeVisible();
});
