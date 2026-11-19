import { chromium, firefox } from "playwright";

const browsers = { chromium, firefox };
const name = process.argv[2];
const browserType = browsers[name];
if (!browserType) {
  console.error(`Unknown browser: ${name}. Use chromium or firefox.`);
  process.exit(2);
}
const browser = await browserType.launch();
await browser.close();
console.log(`${name} launched and closed.`);
