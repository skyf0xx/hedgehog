import { test, expect } from '@playwright/test';

test('renders the base page', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h1')).toContainText('Hedgehog');
});
