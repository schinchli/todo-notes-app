/**
 * Capture blog-post screenshots of the running app with demo data.
 * Requires the dev server (npm run dev) with the demo account seeded.
 *
 *   node scripts/screenshots.mjs [http://localhost:3000]
 *
 * Writes PNGs to docs/screenshots/.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const creds = JSON.parse(readFileSync(new URL('../.demo-credentials', import.meta.url)));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 2 });
const shot = async (name) => { await page.screenshot({ path: `${OUT}${name}.png` }); console.log('shot', name); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

await page.goto(BASE, { waitUntil: 'networkidle' });

// Sign in via the account menu.
await page.getByRole('button', { name: /sign in/i }).first().click().catch(() => {});
await wait(600);
await page.locator('input[name="username"], input[type="email"]').first().fill(creds.username);
await page.locator('input[name="password"], input[type="password"]').first().fill(creds.password);
await page.getByRole('button', { name: /sign in|log in/i }).last().click();
await page.waitForSelector('.today-strip', { timeout: 20000 });
await wait(1500);

const shotFull = async (name) => { await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true }); console.log('shot(full)', name); };

// Hero: the signed-in workbench, top of viewport.
await shot('landing-page');

// 1. Full workbench, top to bottom (dashboard + notes + assistant).
await shotFull('01-workbench');

// 2. Voice capture — mic button in quick capture.
await page.locator('.capture-card').scrollIntoViewIfNeeded().catch(() => {});
await wait(500);
await shot('04-voice-capture');

// 3. Plan my day — scroll the assistant into view, click, wait for the plan.
await page.getByRole('button', { name: /plan my day/i }).scrollIntoViewIfNeeded().catch(() => {});
await wait(300);
await page.getByRole('button', { name: /plan my day/i }).click().catch(() => {});
await page.waitForSelector('.day-plan', { timeout: 30000 }).catch(() => {});
await wait(1200);
await page.getByRole('button', { name: /plan my day/i }).scrollIntoViewIfNeeded().catch(() => {});
await wait(300);
await shot('02-plan-my-day');

// 4. Translate a note — scroll a note into view, pick French, wait for card.
const firstSelect = page.locator('.translate-control select').first();
await firstSelect.scrollIntoViewIfNeeded().catch(() => {});
await wait(300);
await firstSelect.selectOption('french').catch(() => {});
await page.waitForSelector('.translation-card', { timeout: 30000 }).catch(() => {});
await wait(1000);
await page.locator('.translation-card').first().scrollIntoViewIfNeeded().catch(() => {});
await wait(300);
await shot('03-translation');

await browser.close();
console.log('done ->', OUT);
