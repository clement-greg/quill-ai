const { chromium } = require('@playwright/test');

(async () => {
  console.log('Opening browser — please sign in with Google...');

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://localhost:6258');

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (!page.url().includes('/login')) break;
  }

  if (page.url().includes('/login')) {
    console.error('Timed out waiting for login. Session not saved.');
    await browser.close();
    process.exit(1);
  }

  await context.storageState({ path: '.claude/auth.json' });
  console.log('Session saved to .claude/auth.json');
  await browser.close();
})();
