/**
 * Backend — aws-blocks/index.ts
 *
 * Todo-notes app: per-user notes with tags + due dates, an AI assistant
 * (Agent + KnowledgeBase), and a daily email digest (CronJob + EmailClient).
 *
 * Everything runs locally with automatic mocks (canned LLM, TF-IDF search,
 * console-captured email) and deploys to AWS with zero code changes:
 * DynamoDB, Bedrock, Bedrock Knowledge Bases, EventBridge Scheduler, SES.
 */
import { ApiNamespace, Scope, AuthBasic, DistributedTable, Realtime } from '@aws-blocks/blocks';
import { Agent, BedrockModels, OllamaModels } from '@aws-blocks/bb-agent';
import { KnowledgeBase } from '@aws-blocks/bb-knowledge-base';
import { CronJob } from '@aws-blocks/bb-cron-job';
import { EmailClient } from '@aws-blocks/bb-email-client';
import { z } from 'zod';

const scope = new Scope('todo-notes-app');

// ─── Auth ────────────────────────────────────────────────────────────────────
const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});
export const authApi = auth.createApi();

// ─── Data ────────────────────────────────────────────────────────────────────
// dueDate is epoch ms; 0 = no due date (keeps it usable as a GSI sort key).
const noteSchema = z.object({
  userId: z.string(),        // partition key — per-user isolation
  noteId: z.string(),        // sort key — unique within a user
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  dueDate: z.number(),
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
  email: z.string(),
  digestEnabled: z.boolean(),
});

const profiles = new DistributedTable(scope, 'profiles', {
  schema: profileSchema,
  key: { partitionKey: 'userId' },
});

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
  title: string; body?: string; tags?: string[]; dueDate?: number;
}): Promise<Note> {
  const now = Date.now();
  const note: Note = {
    userId,
    noteId: newId(),
    title: input.title,
    body: input.body ?? '',
    tags: input.tags ?? [],
    dueDate: input.dueDate ?? 0,
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
  return await Array.fromAsync(
    index
      ? notes.query({ index, where: { userId: { equals: userId } } })
      : notes.query({ where: { userId: { equals: userId } } })
  );
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
  description: 'Todo-notes app help documentation and FAQs',
});

// ─── AI assistant — Agent block (Strands under the hood) ────────────────────
// Locally: canned keyword provider (or Ollama llama3.1:8b if running).
// Deployed: Bedrock Claude Sonnet via global inference profile.
const assistant = new Agent(scope, 'assistant', {
  model: {
    // LocalStack does not emulate Bedrock — fall back to the canned provider
    // there so the assistant still exercises the real SQS -> Lambda path.
    deployed: isLocalStack ? [{ provider: 'canned' as const }] : BedrockModels.BALANCED,
    local: [OllamaModels.SMALL], // canned provider appended implicitly as fallback
  },
  systemPrompt: [
    'You are the assistant inside a todo-notes app.',
    'You can search the user\'s notes, list what is due soon, create notes,',
    'and mark notes complete. Use searchHelp for questions about the app itself.',
    'Keep answers short. When summarizing notes, lead with overdue items.',
  ].join(' '),
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

// ─── Email digest — CronJob + EmailClient ────────────────────────────────────
// NOTE for deploy: fromAddress must be a verified SES identity in your account.
const mailer = new EmailClient(scope, 'digest-mailer', {
  fromAddress: 'noreply@example.com',
});

const DAY_MS = 24 * 60 * 60 * 1000;

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
      if (due.length === 0) continue;
      const now = Date.now();
      const lines = due.map(n => {
        const when = n.dueDate < now ? 'OVERDUE' : `due ${new Date(n.dueDate).toDateString()}`;
        return `• ${n.title} — ${when}`;
      });
      messages.push({
        to: profile.email,
        subject: `Todo-notes digest: ${due.length} item${due.length > 1 ? 's' : ''} need attention`,
        body: `Good morning!\n\nDue in the next 24 hours:\n\n${lines.join('\n')}\n`,
      });
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

  async createNote(title: string, body: string = '', tags: string[] = [], dueDate: number = 0) {
    const user = await auth.requireAuth(context);
    return createNoteFor(user.username, { title, body, tags, dueDate });
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
  async updateNote(noteId: string, patch: { title?: string; body?: string; tags?: string[]; dueDate?: number }) {
    const user = await auth.requireAuth(context);
    const note = await notes.get({ userId: user.username, noteId });
    if (!note) throw new Error('Note not found');
    const updated = {
      ...note,
      ...patch,
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
    const profile = { userId: user.username, email, digestEnabled };
    await profiles.put(profile);
    return profile;
  },

  // ── Help search (KnowledgeBase directly, no agent) ──
  async searchHelp(query: string) {
    await auth.requireAuth(context);
    if (!kb) return [];
    return kb.retrieve(query, { maxResults: 5 });
  },

  // ── AI assistant ──
  async createConversation() {
    const user = await auth.requireAuth(context);
    return { conversationId: await assistant.createConversationId(user.username) };
  },

  async sendMessage(conversationId: string, message: string, channelId: string) {
    const user = await auth.requireAuth(context);
    await assistant.stream(message, {
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
    const owned = await assistant.listConversations(user.username);
    if (!owned.some(c => c.conversationId === conversationId)) throw new Error('Not found');
    return { messages: await assistant.getConversation(conversationId) };
  },

  async getAgentChannel(channelId: string) {
    await auth.requireAuth(context);
    return assistant.getChannel(channelId);
  },

  async resumeAgent(channelId: string, responses: { interruptId: string; approved: boolean }[], conversationId: string) {
    const user = await auth.requireAuth(context);
    await assistant.resume(channelId, responses, {
      conversationId,
      userId: user.username,
      context: { userId: user.username },
    });
    return { submitted: true };
  },
}));
