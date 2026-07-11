/**
 * Backend — aws-blocks/index.ts
 *
 * Instanote: per-user notes with tags + due dates, an AI assistant
 * (Agent + KnowledgeBase), and a daily email digest (CronJob + EmailClient).
 *
 * Everything runs locally with automatic mocks (canned LLM, TF-IDF search,
 * console-captured email) and deploys to AWS with zero code changes:
 * DynamoDB, Bedrock, Bedrock Knowledge Bases, EventBridge Scheduler, SES.
 */
import { ApiNamespace, Scope, AuthBasic, DistributedTable, Realtime } from '@aws-blocks/blocks';
import { Agent, BedrockModels } from '@aws-blocks/bb-agent';
import { KnowledgeBase } from '@aws-blocks/bb-knowledge-base';
import { CronJob } from '@aws-blocks/bb-cron-job';
import { EmailClient } from '@aws-blocks/bb-email-client';
import { z } from 'zod';

// Keep this infrastructure identifier stable to avoid replacing deployed resources.
const scope = new Scope('todo-notes-app');

// ─── Auth ────────────────────────────────────────────────────────────────────
const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 12 },
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});

// Shared demo account: usable for evaluation but hardened — it cannot delete
// notes, change digest settings, or flood the store (see guards in the API).
const DEMO_USERNAME = process.env.INSTANOTE_DEMO_USER ?? 'demo@instanote.app';
const MAX_NOTES_PER_USER = Number(process.env.INSTANOTE_MAX_NOTES ?? 200);

function isDemoUser(username: string) {
  return username.toLowerCase() === DEMO_USERNAME.toLowerCase();
}
export const authApi = auth.createApi();

// ─── Data ────────────────────────────────────────────────────────────────────
// dueDate is epoch ms; 0 = no due date (keeps it usable as a GSI sort key).
const titleSchema = z.string().trim().min(1, 'Title is required').max(160, 'Title is too long');
const bodySchema = z.string().max(4000, 'Note details are too long');
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(12, 'A note can have at most 12 tags');
const dueDateSchema = z.number().finite().nonnegative();

const noteSchema = z.object({
  userId: z.string(),        // partition key — per-user isolation
  noteId: z.string(),        // sort key — unique within a user
  title: titleSchema,
  body: bodySchema,
  tags: tagsSchema,
  dueDate: dueDateSchema,
  reminderAt: z.number().min(0).default(0), // epoch ms; 0 = no reminder
  completed: z.boolean(),
  version: z.number(),       // optimistic locking
  createdAt: z.number(),
  updatedAt: z.number(),
});
type Note = z.infer<typeof noteSchema>;

const notes = new DistributedTable(scope, 'notes', {
  schema: noteSchema,
  key: { partitionKey: 'userId', sortKey: 'noteId' },
  indexes: {
    byDueDate: { partitionKey: 'userId', sortKey: 'dueDate' },
    byTitle: { partitionKey: 'userId', sortKey: 'title' },
  },
});

// Per-user settings for the daily email digest.
const profileSchema = z.object({
  userId: z.string(),
  email: z.string().trim().email('Enter a valid email address'),
  digestEnabled: z.boolean(),
});

const profiles = new DistributedTable(scope, 'profiles', {
  schema: profileSchema,
  key: { partitionKey: 'userId' },
});

// Per-user daily AI usage counters (OWASP A04 abuse control). WAF rate-limits
// per IP at the edge; this bounds per-ACCOUNT spend on model/TTS calls —
// which matters most for the shared demo account.
const aiUsage = new DistributedTable(scope, 'ai-usage', {
  schema: z.object({
    userId: z.string(),
    day: z.string(),      // yyyy-mm-dd (UTC)
    calls: z.number(),
    version: z.number(),
  }),
  key: { partitionKey: 'userId', sortKey: 'day' },
});

const AI_DAILY_LIMIT_DEMO = Number(process.env.INSTANOTE_AI_LIMIT_DEMO ?? 40);
const AI_DAILY_LIMIT_USER = Number(process.env.INSTANOTE_AI_LIMIT_USER ?? 200);

/** Count one AI call for the user; throw when over the daily cap. */
async function chargeAiCall(username: string) {
  const day = new Date().toISOString().slice(0, 10);
  const limit = isDemoUser(username) ? AI_DAILY_LIMIT_DEMO : AI_DAILY_LIMIT_USER;
  const row = await aiUsage.get({ userId: username, day });
  if ((row?.calls ?? 0) >= limit) {
    throw new Error(`Daily AI limit reached (${limit} calls). Try again tomorrow.`);
  }
  try {
    await aiUsage.put(
      { userId: username, day, calls: (row?.calls ?? 0) + 1, version: (row?.version ?? 0) + 1 },
      row ? { ifFieldEquals: { version: row.version } } : { ifNotExists: true },
    );
  } catch {
    // Concurrent increment lost the race — the call still counts as allowed;
    // the cap is an abuse bound, not an exact meter.
  }
}

// ─── Realtime ────────────────────────────────────────────────────────────────
const rt = new Realtime(scope, 'live', {
  namespaces: {
    notes: Realtime.namespace(z.object({
      action: z.enum(['created', 'updated', 'deleted']),
      noteId: z.string(),
    })),
  },
});

// ─── Note helpers (shared by the API and the agent's tools) ──────────────────
function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Realtime is a best-effort notification — a publish failure (e.g. WebSocket
 * infra unavailable on LocalStack) must never fail the write it follows. */
async function publishNote(userId: string, action: 'created' | 'updated' | 'deleted', noteId: string) {
  try {
    await rt.publish('notes', userId, { action, noteId });
  } catch (e) {
    console.warn('[realtime] publish failed (non-fatal):', (e as Error).message);
  }
}

async function createNoteFor(userId: string, input: {
  title: string; body?: string; tags?: string[]; dueDate?: number; reminderAt?: number;
}): Promise<Note> {
  const validated = z.object({
    title: titleSchema,
    body: bodySchema.default(''),
    tags: tagsSchema.default([]),
    dueDate: dueDateSchema.default(0),
    reminderAt: z.number().min(0).default(0),
  }).parse(input);
  const now = Date.now();
  const note: Note = {
    userId,
    noteId: newId(),
    title: validated.title,
    body: validated.body,
    tags: [...new Set(validated.tags)],
    dueDate: validated.dueDate,
    reminderAt: validated.reminderAt,
    completed: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await notes.put(note);
  await publishNote(userId, 'created', note.noteId);
  return note;
}

async function listNotesFor(userId: string, sortBy?: 'dueDate' | 'title'): Promise<Note[]> {
  const index = sortBy === 'dueDate' ? 'byDueDate' : sortBy === 'title' ? 'byTitle' : undefined;
  const rows = await Array.fromAsync(
    index
      ? notes.query({ index, where: { userId: { equals: userId } } })
      : notes.query({ where: { userId: { equals: userId } } })
  );
  // Rows written before the reminders feature have no reminderAt attribute.
  return rows.map(row => ({ ...row, reminderAt: row.reminderAt ?? 0 }));
}

function dueSoon(all: Note[], horizonMs: number): Note[] {
  const now = Date.now();
  return all
    .filter(n => !n.completed && n.dueDate > 0 && n.dueDate <= now + horizonMs)
    .sort((a, b) => a.dueDate - b.dueDate);
}

// ─── Knowledge base — app help docs, semantic search ─────────────────────────
// Skipped when targeting LocalStack (set at synth AND in the handler env by
// index.cdk.ts): Bedrock Knowledge Bases are not emulated in community
// LocalStack — its CFN stub resolves the KB ARN to the literal "unknown",
// which poisons dependent IAM policies. Local dev and real AWS are unaffected.
const isLocalStack = process.env.LOCALSTACK_DEPLOY === 'true';
const kb = isLocalStack ? null : new KnowledgeBase(scope, 'help-docs', {
  source: './knowledge',
  description: 'Instanote help documentation and FAQs',
});

// ─── AI assistant — Agent block (Strands under the hood) ────────────────────
// Locally: deterministic offline provider by default. A tool-capable Ollama
// model can be enabled explicitly without changing application code.
// Deployed: Bedrock Claude Sonnet via global inference profile.
const ollamaModelId = process.env.INSTANOTE_OLLAMA_MODEL?.trim();
const localAssistantModels = ollamaModelId
  ? [{
      provider: 'openai-api' as const,
      modelId: ollamaModelId,
      endpoint: process.env.INSTANOTE_OLLAMA_ENDPOINT?.trim() || 'http://localhost:11434/v1',
      apiKey: 'ollama',
    }]
  : [{ provider: 'canned' as const }];
const assistant = new Agent(scope, 'assistant', {
  model: {
    // LocalStack does not emulate Bedrock — fall back to the canned provider
    // there so the assistant still exercises the real SQS -> Lambda path.
    // canned fallback keeps the assistant answering even if Bedrock model
    // access hasn't been enabled in the target account yet.
    deployed: isLocalStack
      ? [{ provider: 'canned' as const }]
      : [BedrockModels.BALANCED, { provider: 'canned' as const }],
    local: localAssistantModels,
  },
  systemPrompt: [
    'You are the Notes assistant and daily planner inside Instanote.',
    'You can search the user\'s notes, list what is due soon, create notes,',
    'and mark notes complete. Use searchHelp for questions about the app itself.',
    'When asked to plan the day, use listDueSoon and propose a numbered,',
    'priority-ordered plan with overdue items first and a time block per item.',
    'Keep answers short. When summarizing notes, lead with overdue items.',
  ].join(' '),
  streamingMode: 'token',
  conversation: { strategy: 'sliding-window', windowSize: 24 },
  toolContextSchema: z.object({ userId: z.string() }),
  tools: (tool) => ({
    searchNotes: tool({
      description: 'Search the current user\'s notes by keyword across title, body, and tags',
      parameters: z.object({ query: z.string().describe('Keyword to search for') }),
      handler: async ({ input, context }) => {
        const q = input.query.toLowerCase();
        const all = await listNotesFor(context.userId);
        return all
          .filter(n =>
            n.title.toLowerCase().includes(q) ||
            n.body.toLowerCase().includes(q) ||
            n.tags.some(t => t.toLowerCase().includes(q)))
          .slice(0, 10)
          .map(({ noteId, title, body, tags, dueDate, completed }) =>
            ({ noteId, title, body, tags, dueDate, completed }));
      },
    }),
    listDueSoon: tool({
      description: 'List the user\'s incomplete notes due within the next 7 days (including overdue)',
      parameters: z.object({}),
      handler: async ({ context }) => {
        const all = await listNotesFor(context.userId);
        return dueSoon(all, 7 * 24 * 60 * 60 * 1000)
          .map(({ noteId, title, dueDate }) => ({ noteId, title, dueDate }));
      },
    }),
    addNote: tool({
      description: 'Create a new note for the user',
      parameters: z.object({
        title: z.string(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        dueDateIso: z.string().optional().describe('Due date as ISO 8601, e.g. 2026-07-10'),
      }),
      needsApproval: true, // modifies state — pause for user approval
      trustable: true,
      handler: async ({ input, context }) => {
        const dueDate = input.dueDateIso ? Date.parse(input.dueDateIso) : 0;
        if (Number.isNaN(dueDate)) throw new Error(`Invalid date: ${input.dueDateIso}`);
        const note = await createNoteFor(context.userId, { ...input, dueDate });
        return { created: true, noteId: note.noteId, title: note.title };
      },
    }),
    completeNote: tool({
      description: 'Mark one of the user\'s notes as completed, by noteId',
      parameters: z.object({ noteId: z.string() }),
      needsApproval: true,
      trustable: true,
      handler: async ({ input, context }) => {
        const note = await notes.get({ userId: context.userId, noteId: input.noteId });
        if (!note) throw new Error('Note not found');
        await notes.put(
          { ...note, completed: true, version: note.version + 1, updatedAt: Date.now() },
          { ifFieldEquals: { version: note.version } },
        );
        await publishNote(context.userId, 'updated', note.noteId);
        return { completed: true, title: note.title };
      },
    }),
    searchHelp: tool({
      description: 'Search the app\'s help documentation for how-to questions about the app itself',
      parameters: z.object({ query: z.string() }),
      handler: async ({ input }) => {
        if (!kb) return { unavailable: 'Help search is not available in this environment.' };
        const results = await kb.retrieve(input.query, { maxResults: 3 });
        return results.map(r => ({ text: r.text, score: r.score, source: r.source }));
      },
    }),
  }),
});

// ─── Quick AI — stateless one-shot tasks (translate, plan) ───────────────────
// inferenceOnly: no conversation persistence infra. Uses the same provider
// ladder as the assistant: Bedrock on AWS, Ollama locally if opted in,
// deterministic canned provider otherwise — so every feature stays testable
// fully offline.
const quickAi = new Agent(scope, 'quick-ai', {
  inferenceOnly: true,
  model: {
    deployed: isLocalStack
      ? [{ provider: 'canned' as const }]
      : [BedrockModels.FAST, { provider: 'canned' as const }],
    local: localAssistantModels,
  },
  systemPrompt: 'You perform one-shot text tasks precisely. Return only the requested output with no preamble.',
});

async function runQuickAi(prompt: string): Promise<string> {
  const result = await quickAi.stream(prompt);
  const done = await result.complete();
  return (done.text ?? '').trim();
}

const LANGUAGES = {
  french: { name: 'French', pollyVoice: 'Lea', bcp47: 'fr-FR' },
  german: { name: 'German', pollyVoice: 'Vicki', bcp47: 'de-DE' },
  hindi: { name: 'Hindi', pollyVoice: 'Kajal', bcp47: 'hi-IN' },
  english: { name: 'English', pollyVoice: 'Joanna', bcp47: 'en-US' },
} as const;
type LanguageKey = keyof typeof LANGUAGES;
const languageSchema = z.enum(['french', 'german', 'hindi', 'english']);

/** Start/end of "today" for a client at the given UTC offset (minutes). */
function todayWindow(tzOffsetMinutes: number) {
  const offsetMs = tzOffsetMinutes * 60 * 1000;
  const localNow = Date.now() + offsetMs;
  const dayStartLocal = Math.floor(localNow / DAY_MS) * DAY_MS;
  return { start: dayStartLocal - offsetMs, end: dayStartLocal + DAY_MS - offsetMs };
}

// ─── Email digest — CronJob + EmailClient ────────────────────────────────────
// NOTE for deploy: fromAddress must be a verified SES identity in your account.
const mailer = new EmailClient(scope, 'digest-mailer', {
  fromAddress: process.env.INSTANOTE_FROM_ADDRESS ?? 'noreply@example.com',
});

const DAY_MS = 24 * 60 * 60 * 1000;

function buildDigestMessage(email: string, due: Note[], now = Date.now(), reminders: Note[] = []) {
  const lines = due.map(note => {
    const when = note.dueDate < now ? 'OVERDUE' : `due ${new Date(note.dueDate).toDateString()}`;
    return `• ${note.title} — ${when}`;
  });
  for (const note of reminders) {
    lines.push(`⏰ ${note.title} — reminder ${new Date(note.reminderAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  }
  return {
    to: email,
    subject: `Instanote digest: ${due.length} item${due.length > 1 ? 's' : ''} need attention`,
    body: `Good morning!\n\nDue in the next 24 hours:\n\n${lines.join('\n')}\n`,
  };
}

async function requireOwnedConversation(userId: string, conversationId: string) {
  const owned = await assistant.listConversations(userId);
  if (!owned.some(conversation => conversation.conversationId === conversationId)) {
    // Keep this deliberately vague so callers cannot probe conversation IDs.
    throw new Error('Not found');
  }
}

async function getAssistantRuntimeStatus() {
  if (isLocalStack) {
    return { mode: 'localstack' as const, provider: 'canned' as const, model: 'deterministic fallback', ready: true };
  }
  if (process.env.NODE_ENV === 'production') {
    return { mode: 'aws' as const, provider: 'bedrock' as const, model: BedrockModels.BALANCED.modelId, ready: true };
  }

  if (!ollamaModelId) {
    return { mode: 'offline' as const, provider: 'canned' as const, model: 'built-in offline agent', ready: true };
  }

  try {
    const endpoint = process.env.INSTANOTE_OLLAMA_ENDPOINT?.trim() || 'http://localhost:11434/v1';
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(1200),
    });
    if (response.ok) {
      const body = await response.json() as { data?: Array<{ id?: string }> };
      const available = body.data?.some(model => model.id === ollamaModelId) ?? false;
      if (available) {
        return { mode: 'offline' as const, provider: 'ollama' as const, model: ollamaModelId, ready: true };
      }
    }
  } catch {
    // Report the configured model as unavailable below.
  }
  return { mode: 'offline' as const, provider: 'ollama' as const, model: ollamaModelId, ready: false };
}

new CronJob(scope, 'daily-digest', {
  schedule: 'cron(0 8 * * ? *)',
  timezone: 'Asia/Kolkata',
  description: 'Daily 8 AM digest of due and overdue notes, per opted-in user',
  handler: async () => {
    const messages = [];
    for await (const profile of profiles.scan()) {
      if (!profile.digestEnabled || !profile.email) continue;
      const all = await listNotesFor(profile.userId);
      const due = dueSoon(all, DAY_MS);
      const now = Date.now();
      const reminders = all
        .filter(n => !n.completed && n.reminderAt > 0 && n.reminderAt <= now + DAY_MS && !due.includes(n))
        .sort((a, b) => a.reminderAt - b.reminderAt);
      if (due.length === 0 && reminders.length === 0) continue;
      messages.push(buildDigestMessage(profile.email, due, now, reminders));
    }
    if (messages.length > 0) {
      const result = await mailer.sendBatch(messages);
      const failed = result.results.filter(r => r.status === 'failed').length;
      console.log(`[daily-digest] sent ${messages.length - failed}/${messages.length} digests`);
    }
  },
});

// ─── API ─────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

  // ── Notes CRUD ──
  async subscribeNotes() {
    const user = await auth.requireAuth(context);
    return rt.getChannel('notes', user.username);
  },

  async createNote(title: string, body: string = '', tags: string[] = [], dueDate: number = 0, reminderAt: number = 0) {
    const user = await auth.requireAuth(context);
    // Resource cap (OWASP A04): bound per-user storage so no account —
    // especially the shared demo one — can flood the table.
    const existing = await listNotesFor(user.username);
    if (existing.length >= MAX_NOTES_PER_USER) {
      throw new Error(`Note limit reached (${MAX_NOTES_PER_USER}). Delete some notes first.`);
    }
    return createNoteFor(user.username, { title, body, tags, dueDate, reminderAt });
  },

  async listNotes(sortBy?: 'dueDate' | 'title') {
    const user = await auth.requireAuth(context);
    return listNotesFor(user.username, sortBy);
  },

  async getNote(noteId: string) {
    const user = await auth.requireAuth(context);
    const note = await notes.get({ userId: user.username, noteId });
    if (!note) throw new Error('Note not found');
    return note;
  },

  /** Update note content with optimistic locking. */
  async updateNote(noteId: string, patch: { title?: string; body?: string; tags?: string[]; dueDate?: number; reminderAt?: number }) {
    const user = await auth.requireAuth(context);
    const note = await notes.get({ userId: user.username, noteId });
    if (!note) throw new Error('Note not found');
    const validatedPatch = z.object({
      title: titleSchema.optional(),
      body: bodySchema.optional(),
      tags: tagsSchema.optional(),
      dueDate: dueDateSchema.optional(),
      reminderAt: z.number().min(0).optional(),
    }).parse(patch);
    const updated = {
      ...note,
      ...validatedPatch,
      ...(validatedPatch.tags ? { tags: [...new Set(validatedPatch.tags)] } : {}),
      version: note.version + 1,
      updatedAt: Date.now(),
    };
    await notes.put(updated, { ifFieldEquals: { version: note.version } });
    await publishNote(user.username, 'updated', noteId);
    return updated;
  },

  async toggleNote(noteId: string) {
    const user = await auth.requireAuth(context);
    const note = await notes.get({ userId: user.username, noteId });
    if (!note) throw new Error('Note not found');
    await notes.put(
      { ...note, completed: !note.completed, version: note.version + 1, updatedAt: Date.now() },
      { ifFieldEquals: { version: note.version } },
    );
    await publishNote(user.username, 'updated', noteId);
    return { success: true };
  },

  async deleteNote(noteId: string) {
    const user = await auth.requireAuth(context);
    // Demo hardening: visitors share the demo account — keep its seed data.
    if (isDemoUser(user.username)) {
      throw new Error('The demo account cannot delete notes — sign up for your own account to try that');
    }
    await notes.delete({ userId: user.username, noteId });
    await publishNote(user.username, 'deleted', noteId);
    return { success: true };
  },

  // ── Digest settings ──
  async getSettings() {
    const user = await auth.requireAuth(context);
    const profile = await profiles.get({ userId: user.username });
    // Usernames are email addresses in this app — sensible default.
    return profile ?? { userId: user.username, email: user.username, digestEnabled: false };
  },

  async updateSettings(email: string, digestEnabled: boolean) {
    const user = await auth.requireAuth(context);
    // Demo hardening: the shared demo account cannot point the digest at an
    // arbitrary address (prevents using it to send email to third parties).
    if (isDemoUser(user.username) && email.toLowerCase() !== user.username.toLowerCase()) {
      throw new Error('The demo account cannot change its digest email address');
    }
    const profile = profileSchema.parse({ userId: user.username, email, digestEnabled });
    await profiles.put(profile);
    return profile;
  },

  async sendDigestNow() {
    const user = await auth.requireAuth(context);
    const profile = await profiles.get({ userId: user.username });
    if (!profile?.digestEnabled) return { sent: false as const, reason: 'disabled' as const, count: 0 };
    const due = dueSoon(await listNotesFor(user.username), DAY_MS);
    if (due.length === 0) return { sent: false as const, reason: 'no-due-notes' as const, count: 0 };
    const result = await mailer.send(buildDigestMessage(profile.email, due));
    return { sent: true as const, count: due.length, messageId: result.messageId };
  },

  // ── Quick AI: translate · listen · today · daily plan ──

  /** Translate a note to French, German, Hindi, or English via the quick-AI agent. */
  async translateNote(noteId: string, language: 'french' | 'german' | 'hindi' | 'english') {
    const user = await auth.requireAuth(context);
    await chargeAiCall(user.username);
    const lang = LANGUAGES[languageSchema.parse(language)];
    const note = await notes.get({ userId: user.username, noteId });
    if (!note) throw new Error('Note not found');
    const translated = await runQuickAi(
      `Translate this note to ${lang.name}. Keep the same two-line structure: `
      + `first line is the title, the rest is the body (may be empty). `
      + `Return only the translation.\n\nTitle: ${note.title}\nBody: ${note.body || '(empty)'}`,
    );
    return { noteId, language, languageName: lang.name, bcp47: lang.bcp47, translated };
  },

  /**
   * Synthesize text to MP3 via Amazon Polly (neural voices per language).
   * Locally without AWS credentials this reports unavailable and the UI
   * falls back to the browser's built-in speech synthesis.
   */
  async synthesizeSpeech(text: string, language: 'french' | 'german' | 'hindi' | 'english' = 'english') {
    const user = await auth.requireAuth(context);
    await chargeAiCall(user.username);
    const lang = LANGUAGES[languageSchema.parse(language)];
    const clipped = z.string().trim().min(1).max(3000).parse(text);
    try {
      const { PollyClient, SynthesizeSpeechCommand } = await import('@aws-sdk/client-polly');
      const polly = new PollyClient({});
      const out = await polly.send(new SynthesizeSpeechCommand({
        Text: clipped,
        OutputFormat: 'mp3',
        VoiceId: lang.pollyVoice,
        Engine: 'neural',
        LanguageCode: lang.bcp47,
      }));
      const bytes = await out.AudioStream?.transformToByteArray();
      if (!bytes?.length) throw new Error('Polly returned no audio');
      return {
        available: true as const,
        format: 'mp3' as const,
        voice: lang.pollyVoice,
        bcp47: lang.bcp47,
        audioBase64: Buffer.from(bytes).toString('base64'),
      };
    } catch (e) {
      // No AWS credentials / Polly unreachable — browser TTS takes over.
      return { available: false as const, bcp47: lang.bcp47, reason: (e as Error).message };
    }
  },

  /**
   * Dashboard: everything the workbench strip needs in one call —
   * counts, today's agenda (overdue + due today), and upcoming reminders.
   */
  async getDashboard(tzOffsetMinutes: number = 0) {
    const user = await auth.requireAuth(context);
    const offset = z.number().min(-14 * 60).max(14 * 60).parse(tzOffsetMinutes);
    const { end } = todayWindow(offset);
    const all = await listNotesFor(user.username);
    const now = Date.now();
    const open = all.filter(n => !n.completed);
    const today = open
      .filter(n => n.dueDate > 0 && n.dueDate < end)
      .sort((a, b) => a.dueDate - b.dueDate)
      .map(n => ({ noteId: n.noteId, title: n.title, dueDate: n.dueDate, tags: n.tags, overdue: n.dueDate < now }));
    const reminders = open
      .filter(n => n.reminderAt > 0)
      .sort((a, b) => a.reminderAt - b.reminderAt)
      .slice(0, 10)
      .map(n => ({ noteId: n.noteId, title: n.title, reminderAt: n.reminderAt, missed: n.reminderAt < now }));
    return {
      counts: {
        open: open.length,
        overdue: open.filter(n => n.dueDate > 0 && n.dueDate < now).length,
        dueToday: today.filter(n => !n.overdue).length,
        withReminders: open.filter(n => n.reminderAt > 0).length,
        completed: all.length - open.length,
      },
      today,
      reminders,
    };
  },

  /** Today's agenda: overdue + due-today incomplete notes, soonest first. */
  async listToday(tzOffsetMinutes: number = 0) {
    const user = await auth.requireAuth(context);
    const offset = z.number().min(-14 * 60).max(14 * 60).parse(tzOffsetMinutes);
    const { end } = todayWindow(offset);
    const all = await listNotesFor(user.username);
    const now = Date.now();
    return all
      .filter(n => !n.completed && n.dueDate > 0 && (n.dueDate < now || n.dueDate < end))
      .sort((a, b) => a.dueDate - b.dueDate)
      .map(n => ({ ...n, overdue: n.dueDate < now }));
  },

  /** Daily-planner agent: an ordered, time-blocked plan for today. */
  async planMyDay(tzOffsetMinutes: number = 0) {
    const user = await auth.requireAuth(context);
    await chargeAiCall(user.username);
    const offset = z.number().min(-14 * 60).max(14 * 60).parse(tzOffsetMinutes);
    const { end } = todayWindow(offset);
    const all = await listNotesFor(user.username);
    const now = Date.now();
    const open = all.filter(n => !n.completed);
    const overdue = open.filter(n => n.dueDate > 0 && n.dueDate < now);
    const today = open.filter(n => n.dueDate >= now && n.dueDate < end);
    const upcoming = open.filter(n => n.dueDate >= end).slice(0, 5);
    const undated = open.filter(n => n.dueDate === 0).slice(0, 5);
    const section = (label: string, items: Note[]) =>
      items.length ? `${label}:\n${items.map(n => `- ${n.title}${n.tags.length ? ` [${n.tags.join(', ')}]` : ''}`).join('\n')}` : '';
    const inventory = [
      section('OVERDUE', overdue), section('DUE TODAY', today),
      section('UPCOMING', upcoming), section('NO DUE DATE', undated),
    ].filter(Boolean).join('\n\n');
    if (!inventory) return { plan: 'Nothing on your plate — enjoy the open day, or capture what comes to mind.', noteCount: 0 };
    const plan = await runQuickAi(
      'Act as a pragmatic daily planner. From this task inventory, produce a short plan for today: '
      + 'a numbered list in priority order (overdue first), grouping related tags, '
      + 'with a suggested time block (morning/afternoon/evening) per item and one closing focus tip. '
      + `Be concise.\n\n${inventory}`,
    );
    return { plan, noteCount: overdue.length + today.length + upcoming.length + undated.length };
  },

  // ── Help search (KnowledgeBase directly, no agent) ──
  async searchHelp(query: string) {
    await auth.requireAuth(context);
    if (!kb) return [];
    return kb.retrieve(query, { maxResults: 5 });
  },

  // ── AI assistant ──
  async getAssistantStatus() {
    await auth.requireAuth(context);
    return getAssistantRuntimeStatus();
  },

  async createConversation() {
    const user = await auth.requireAuth(context);
    return { conversationId: await assistant.createConversationId(user.username) };
  },

  async sendMessage(conversationId: string, message: string, channelId: string) {
    const user = await auth.requireAuth(context);
    await chargeAiCall(user.username);
    await requireOwnedConversation(user.username, conversationId);
    const validatedMessage = z.string().trim().min(1, 'Message is required').max(8000, 'Message is too long').parse(message);
    await assistant.stream(validatedMessage, {
      conversationId,
      channelId,
      userId: user.username,
      context: { userId: user.username },
    });
    return { submitted: true };
  },

  async getConversation(conversationId: string) {
    const user = await auth.requireAuth(context);
    // Agent read paths are not owner-scoped — authorize here.
    await requireOwnedConversation(user.username, conversationId);
    return { messages: await assistant.getConversation(conversationId) };
  },

  async getAgentChannel(channelId: string) {
    await auth.requireAuth(context);
    return assistant.getChannel(channelId);
  },

  async resumeAgent(channelId: string, responses: { interruptId: string; approved: boolean }[], conversationId: string) {
    const user = await auth.requireAuth(context);
    await requireOwnedConversation(user.username, conversationId);
    await assistant.resume(channelId, responses, {
      conversationId,
      userId: user.username,
      context: { userId: user.username },
    });
    return { submitted: true };
  },
}));
