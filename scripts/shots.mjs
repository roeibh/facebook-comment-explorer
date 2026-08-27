// Renders the social card and the README screenshot from the real page, so they can
// never drift from the design. Run after `npm run build`; CI does this on deploy.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const file = p => 'file://' + resolve(fileURLToPath(new URL('../', import.meta.url)), p);

// CHROMIUM_PATH lets you point at an already-installed Chrome instead of
// running `npx playwright install chromium`.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);

const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await og.goto(file('src/og.template.html'));
await og.screenshot({ path: 'docs/og.png' });

const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
await page.goto(file('docs/index.html'));
await page.waitForTimeout(300);
const mock = await page.$('.mock');
if (!mock) throw new Error('.mock not found - did the build run?');
await mock.screenshot({ path: 'docs/screenshot.png' });

await browser.close();
console.log('wrote docs/og.png and docs/screenshot.png');
