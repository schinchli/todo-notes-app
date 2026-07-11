#!/usr/bin/env node
/**
 * Seed the hardened demo account with realistic data.
 *
 *   node scripts/seed-demo.mjs                          # local dev server
 *   node scripts/seed-demo.mjs --api https://<host>/aws-blocks/api
 *   INSTANOTE_DEMO_PASSWORD=... node scripts/seed-demo.mjs
 *
 * Prints the demo credentials on success. The password is generated once and
 * saved to .demo-credentials (gitignored) so re-runs are idempotent.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const apiFlag = args.indexOf('--api');
const API = apiFlag >= 0 ? args[apiFlag + 1] : 'http://localhost:3000/aws-blocks/api';
const USER = process.env.INSTANOTE_DEMO_USER ?? 'demo@instanote.app';

const CRED_FILE = new URL('../.demo-credentials', import.meta.url);
let password = process.env.INSTANOTE_DEMO_PASSWORD;
if (!password && existsSync(CRED_FILE)) {
  password = JSON.parse(readFileSync(CRED_FILE, 'utf8')).password;
}
if (!password) {
  // Strong by construction: 20 chars, mixed classes, satisfies minLength 12.
  password = `Dm-${randomBytes(12).toString('base64url')}!7`;
}

let cookie = '';
let id = 0;
async function rpc(method, params) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++id }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const signIn = await rpc('authApi.setAuthState', [{ action: 'signIn', username: USER, password }]);
if (signIn.state !== 'signedIn') {
  const signUp = await rpc('authApi.setAuthState', [{ action: 'signUp', username: USER, password }]);
  if (signUp.state !== 'signedIn') {
    throw new Error(`Cannot sign in or create ${USER}: ${signUp.error ?? 'unknown'} — if the account exists with a different password, set INSTANOTE_DEMO_PASSWORD.`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const at = (days, hour = 17) => {
  const d = new Date(now + days * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

const REMIND = (days, hour = 9) => { const d = new Date(now + days * DAY); d.setHours(hour, 30, 0, 0); return d.getTime(); };
const SEED = [
  ['👋 Start here — Instanote feature tour', 'Each seeded note shows something off: overdue pills, tags, reminders (⏰ on the dashboard), the 🔊 Listen button (Polly voices), and 🌐 Translate to French/German/Hindi. Ask the assistant to "plan my day"!', ['tour'], 0, 0],
  ['Try voice capture', 'Press the 🎙️ Dictate button in Quick capture and speak — your words land in the title, then details. All in-browser, nothing uploaded.', ['tour', 'voice'], 0, REMIND(0, 18)],
  ['Standup talking points', 'Deployment done via AWS Blocks; demo the Plan-my-day agent and the approval flow.', ['work'], at(0, 11), REMIND(0, 10)],
  ['Renew car insurance', 'Policy #KA-2298 expires — compare premiums before renewing.', ['finance', 'urgent'], at(-2)],
  ['Submit GST filing', 'Q1 returns due — CA has the invoices, needs final approval.', ['finance', 'work'], at(-1)],
  ['Prepare sprint demo', 'Show the notes assistant + digest flow. Keep it under 10 minutes.', ['work'], at(0, 15)],
  ['Book dentist appointment', 'Cleaning + the molar that has been complaining.', ['health'], at(0, 18)],
  ['Review AWS bill', 'Check WAF and Polly line items after the security hardening deploy.', ['work', 'aws'], at(1)],
  ['Pay society maintenance', 'UPI to association account, get the receipt this time.', ['finance'], at(2)],
  ['Plan weekend trek', 'Nandi Hills or Skandagiri — check sunrise slot availability.', ['personal'], at(4)],
  ['Team 1:1 prep — Priya', 'Growth-path conversation; collect examples from last sprint.', ['work'], at(5)],
  ['Order groceries', 'Oat milk, coffee beans, and the usual weekly list.', ['personal'], at(6)],
  ['Read Strands agents deep-dive', 'The multi-agent orchestration post from the AWS blog.', ['learning', 'aws'], 0],
  ['Instanote feature ideas', 'Voice capture, weekly review email, shared workspaces?', ['ideas'], 0],
  ['Gift for parents anniversary', '30th anniversary next month — start looking early.', ['personal'], at(12)],
];

const existing = await rpc('api.listNotes', []);
const have = new Set(existing.map(n => n.title));
let created = 0;
for (const [title, body, tags, dueDate, reminderAt] of SEED) {
  if (have.has(title)) continue;
  await rpc('api.createNote', [title, body, tags, dueDate, reminderAt ?? 0]);
  created++;
}

// Two completed notes so the UI shows the full lifecycle.
for (const title of ['Set up Instanote account', 'Try the notes assistant']) {
  if (have.has(title)) continue;
  const note = await rpc('api.createNote', [title, '', ['done'], 0]);
  await rpc('api.toggleNote', [note.noteId]);
  created++;
}

await rpc('api.updateSettings', [USER, true]);

writeFileSync(CRED_FILE, JSON.stringify({ username: USER, password, api: API }, null, 2));
console.log(`Seeded ${created} new note(s) for ${USER} at ${API}`);
console.log(`Demo credentials -> username: ${USER}  password: ${password}`);
console.log('(saved to .demo-credentials — gitignored)');
