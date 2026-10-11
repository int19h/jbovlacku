import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.JVC_CHROMIUM || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', error => process.stderr.write(`${error}\n`));
  await page.goto(process.argv[2]);
  await page.waitForFunction(() => document.querySelector('#result')?.textContent !== 'pending', { timeout: 30000 });
  process.stdout.write(await page.locator('#result').textContent());
} finally {
  await browser.close();
}
