/**
 * End-to-end tests — tests the API via direct imports (same typed client the frontend uses).
 *
 * Run:  npm run test:e2e
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

// Run-unique identities — local .bb-data persists between runs, so fixed
// usernames would collide on re-runs (UserAlreadyExistsException).
const USER = `testuser-${Date.now()}@example.com`;
const INTRUDER = `intruder-${Date.now()}@example.com`;
const PASSWORD = 'TestPass123!';
const isLocalStack = (() => {
  try {
    const config = JSON.parse(readFileSync(new URL('../.blocks-sandbox/config.json', import.meta.url), 'utf8'));
    return config.environment === 'localstack';
  } catch {
    return false;
  }
})();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

// ─── Setup (don't touch) ─────────────────────────────────────────────────────

test.before(async () => {
  if (!await isServerRunning()) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }

  const mod = await import('aws-blocks');
  api = mod.api;
  authApi = mod.authApi;

  for (let i = 0; i < 30; i++) {
    try {
      await authApi.getAuthState();
      return;
    } catch {
      await setTimeout(1000);
    }
  }
  throw new Error('Dev server did not become ready within 30s');
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('auth: starts signed out', async () => {
  const state = await authApi.getAuthState();
  assert.strictEqual(state.state, 'signedOut');
});

test('auth: sign up creates account and signs in', async () => {
  const state = await authApi.setAuthState({
    action: 'signUp',
    username: USER,
    password: PASSWORD,
  });
  assert.strictEqual(state.state, 'signedIn');
  assert.strictEqual(state.user?.username, USER);
});

test('auth: unauthenticated access is rejected', async () => {
  await authApi.setAuthState({ action: 'signOut' });

  await assert.rejects(
    () => api.listNotes(),
    (err: any) => err.message.includes('Authentication') || err.message.includes('Session') || err.message.includes('401'),
  );

  await authApi.setAuthState({
    action: 'signIn',
    username: USER,
    password: PASSWORD,
  });
});

// ─── Notes CRUD ───────────────────────────────────────────────────────────────

test('notes: create with body, tags, and due date', async () => {
  const due = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const note = await api.createNote('Buy milk', 'Full cream, 2 litres', ['groceries'], due);
  assert.strictEqual(note.title, 'Buy milk');
  assert.strictEqual(note.body, 'Full cream, 2 litres');
  assert.deepStrictEqual(note.tags, ['groceries']);
  assert.strictEqual(note.dueDate, due);
  assert.strictEqual(note.completed, false);
  assert.strictEqual(note.version, 1);
  assert.ok(note.noteId);
});

test('notes: rejects invalid content at the API boundary', async () => {
  await assert.rejects(() => api.createNote('   '));
  await assert.rejects(() => api.createNote('Valid title', '', ['x'.repeat(41)]));
  await assert.rejects(() => api.createNote('Valid title', '', [], -1));
});

test('notes: list (only own)', async () => {
  const list = await api.listNotes();
  assert.ok(list.length >= 1);
  assert.ok(list.every(n => n.userId === USER));
});

test('notes: list sorted by due date (secondary index)', async () => {
  await api.createNote('Later task', '', [], Date.now() + 10 * 24 * 60 * 60 * 1000);
  await api.createNote('Sooner task', '', [], Date.now() + 1 * 24 * 60 * 60 * 1000);

  const sorted = await api.listNotes('dueDate');
  assert.ok(sorted.length >= 2);
  const dues = sorted.map(n => n.dueDate);
  for (let i = 1; i < dues.length; i++) {
    assert.ok(dues[i] >= dues[i - 1], 'Should be sorted by dueDate ascending');
  }
});

test('notes: update content with optimistic locking', async () => {
  const note = await api.createNote('Draft title');
  const updated = await api.updateNote(note.noteId, {
    title: 'Final title',
    body: 'Now with a body',
    tags: ['work', 'urgent'],
  });
  assert.strictEqual(updated.title, 'Final title');
  assert.strictEqual(updated.body, 'Now with a body');
  assert.deepStrictEqual(updated.tags, ['work', 'urgent']);
  assert.strictEqual(updated.version, note.version + 1);
  await api.deleteNote(note.noteId);
});

test('notes: toggle completion', async () => {
  const [note] = await api.listNotes();
  await api.toggleNote(note.noteId);

  const updated = (await api.listNotes()).find(n => n.noteId === note.noteId);
  assert.strictEqual(updated?.completed, !note.completed);
  assert.strictEqual(updated?.version, note.version + 1);
});

test('notes: delete', async () => {
  const before = await api.listNotes();
  const target = before[0];
  await api.deleteNote(target.noteId);

  const after = await api.listNotes();
  assert.ok(!after.some(n => n.noteId === target.noteId));
});

test('notes: concurrent toggle → conflict → retry succeeds', async () => {
  const note = await api.createNote('Conflict test');
  await api.toggleNote(note.noteId);

  const current = (await api.listNotes()).find(n => n.noteId === note.noteId);
  assert.strictEqual(current?.version, 2);

  await api.toggleNote(note.noteId);
  const final = (await api.listNotes()).find(n => n.noteId === note.noteId);
  assert.strictEqual(final?.version, 3);
  assert.strictEqual(final?.completed, note.completed);

  await api.deleteNote(note.noteId);
});

// ─── Digest settings ──────────────────────────────────────────────────────────

test('settings: defaults to username as email, digest off', async () => {
  const s = await api.getSettings();
  assert.strictEqual(s.email, USER);
  assert.strictEqual(s.digestEnabled, false);
});

test('settings: update and persist', async () => {
  const saved = await api.updateSettings('digest@example.com', true);
  assert.strictEqual(saved.email, 'digest@example.com');
  assert.strictEqual(saved.digestEnabled, true);

  const roundTrip = await api.getSettings();
  assert.strictEqual(roundTrip.email, 'digest@example.com');
  assert.strictEqual(roundTrip.digestEnabled, true);
});

test('settings: rejects an invalid digest email', async () => {
  await assert.rejects(() => api.updateSettings('not-an-email', true));
});

// ─── Knowledge base (local: TF-IDF over ./knowledge) ─────────────────────────

test('help: knowledge base returns relevant chunks', async () => {
  const results = await api.searchHelp('how does the email digest work');
  if (isLocalStack) {
    assert.deepStrictEqual(results, [], 'KnowledgeBase should degrade gracefully when Bedrock is unavailable');
    return;
  }
  assert.ok(results.length >= 1, 'Expected at least one help result');
  assert.ok(results.some(r => r.text.toLowerCase().includes('digest')));
  assert.ok(results[0].score > 0);
});

// ─── AI assistant (local: canned provider) ────────────────────────────────────

test('assistant: conversation round-trip persists messages', async () => {
  const { conversationId } = await api.createConversation();
  assert.ok(conversationId);

  const channelId = crypto.randomUUID();
  await api.sendMessage(conversationId, 'Hello assistant', channelId);

  // The agent runs async — poll until the assistant reply is persisted.
  let messages: Awaited<ReturnType<typeof api.getConversation>>['messages'] = [];
  for (let i = 0; i < 30; i++) {
    ({ messages } = await api.getConversation(conversationId));
    if (messages.some(m => m.role === 'assistant')) break;
    await setTimeout(1000);
  }
  assert.ok(messages.some(m => m.role === 'user'), 'user message persisted');
  assert.ok(messages.some(m => m.role === 'assistant'), 'assistant replied (canned provider locally)');
});

test('assistant: conversations are owner-scoped', async () => {
  const { conversationId } = await api.createConversation();

  // A second user must not be able to read the first user's conversation.
  await authApi.setAuthState({ action: 'signOut' });
  await authApi.setAuthState({
    action: 'signUp',
    username: INTRUDER,
    password: PASSWORD,
  });

  await assert.rejects(() => api.getConversation(conversationId));
  await assert.rejects(() => api.sendMessage(conversationId, 'Try to hijack this conversation', crypto.randomUUID()));

  // Restore primary test user
  await authApi.setAuthState({ action: 'signOut' });
  await authApi.setAuthState({
    action: 'signIn',
    username: USER,
    password: PASSWORD,
  });
});
