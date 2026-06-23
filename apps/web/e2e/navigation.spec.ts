import { expect, test } from '@playwright/test';

/**
 * Navigation smoke. Signs in once, then walks every primary destination through
 * the sidebar and asserts each route reaches its screen (correct URL + heading).
 * This is the demo "every link works, nothing 404s" guard. It requires the live
 * API + a seeded user (see playwright.config.ts + global-setup); the unit suite
 * covers the same pages without a stack.
 *
 * It deliberately asserts only navigation + a terminal heading — not row data —
 * so it stays green on an empty (freshly seeded) database.
 */
const EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@test.local';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'e2e correct horse staple';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('email').fill(EMAIL);
  await page.getByLabel('password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

// Sidebar label → expected path + visible page heading. Inventory deep-links into
// the Reports inventory tab (there is no standalone /inventory screen).
const ROUTES: ReadonlyArray<{ link: string; path: RegExp; heading: RegExp }> = [
  { link: 'Dashboard', path: /\/dashboard$/, heading: /^Dashboard$/ },
  { link: 'Products', path: /\/products$/, heading: /^Products$/ },
  { link: 'Warehouses', path: /\/warehouses$/, heading: /^Warehouses$/ },
  { link: 'Customers', path: /\/customers$/, heading: /^Customers$/ },
  { link: 'Orders', path: /\/orders$/, heading: /^Orders$/ },
  { link: 'Invoices', path: /\/invoices$/, heading: /^Invoices$/ },
  { link: 'Returns', path: /\/returns$/, heading: /^Returns$/ },
  { link: 'Credit Notes', path: /\/credit-notes$/, heading: /^Credit notes$/ },
  { link: 'Inventory', path: /\/reports\?tab=inventory$/, heading: /^Reports$/ },
  { link: 'Reports', path: /\/reports$/, heading: /^Reports$/ },
];

test('every sidebar destination loads behind the auth shell', async ({ page }) => {
  await signIn(page);

  for (const route of ROUTES) {
    await page.getByRole('link', { name: route.link, exact: true }).click();
    await expect(page).toHaveURL(route.path);
    await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
  }
});

test('the Inventory link selects the inventory report tab', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\?tab=inventory$/);
  await expect(page.getByTestId('reports-tab-inventory')).toHaveAttribute('aria-selected', 'true');
});

test('logout works from a deep route, not just the dashboard', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Invoices', exact: true }).click();
  await expect(page).toHaveURL(/\/invoices$/);
  await page.getByRole('button', { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('a deep protected route redirects to login when unauthenticated', async ({ page }) => {
  await page.goto('/invoices');
  await expect(page).toHaveURL(/\/login$/);
});
