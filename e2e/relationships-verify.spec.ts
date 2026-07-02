import { test, expect } from '@playwright/test';

test.use({ storageState: '.claude/auth.json' });

test('relationships diagram renders routed paths', async ({ page }) => {
  await page.goto('/relationships');
  await page.waitForTimeout(2500);
  expect(page.url()).not.toContain('/login');

  await page.screenshot({ path: 'e2e/verify-1-relationships.png' });

  const nodes = page.locator('.diagram-node');
  const paths = page.locator('path.connection-line');
  const nodeCount = await nodes.count();
  const pathCount = await paths.count();
  console.log(`nodes=${nodeCount} connectionPaths=${pathCount}`);

  if (pathCount > 0) {
    const d = await paths.first().getAttribute('d');
    console.log(`first path d="${d}"`);
    expect(d).toBeTruthy();
  }

  // Open the relationship dialog if we can: select a node, start connecting, click another node.
  if (nodeCount >= 2) {
    await nodes.nth(0).click();
    await page.locator('button[title="Connect to another entity"]').click();
    await nodes.nth(1).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'e2e/verify-2-dialog.png' });

    // Two relationship-direction selects + auto-fill of the inverse
    const selects = page.locator('mat-dialog-container mat-select');
    expect(await selects.count()).toBe(2);
    await selects.nth(0).click();
    await page.locator('mat-option', { hasText: /^Parent$/ }).click();
    await page.waitForTimeout(300);
    const inverseText = await selects.nth(1).innerText();
    console.log(`inverse auto-filled: "${inverseText.trim()}"`);
    expect(inverseText.trim()).toContain('Child');
    await page.screenshot({ path: 'e2e/verify-3-autofill.png' });
    // Cancel — don't persist test data
    await page.locator('mat-dialog-container button', { hasText: 'Cancel' }).click();
  }
});
