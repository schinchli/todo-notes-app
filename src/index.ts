/**
 * Frontend — src/index.ts
 *
 * Todo-notes UI: notes with tags + due dates, digest settings, and an AI
 * assistant chat panel (streams via Realtime, approves state-changing tools).
 */
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, AuthenticatedContent, onAuthChange } from '@aws-blocks/blocks/ui';
import { useChat } from '@aws-blocks/bb-agent/client';
import { html, render } from 'lit-html';

// ─── Auth ────────────────────────────────────────────────────────────────────
const menuBarEl = document.getElementById('menu-bar')!;
menuBarEl.appendChild(AccountMenuBar(authApi));

onAuthChange(authApi, user => {
  document.getElementById('signInMessage')!.style.display = user == null ? '' : 'none';
});

// ─── App (shown when authenticated) ─────────────────────────────────────────
document.getElementById('app')!.appendChild(
  AuthenticatedContent(authApi, () => {
    const container = document.createElement('div');

    type Note = {
      noteId: string; title: string; body: string; tags: string[];
      dueDate: number; completed: boolean;
    };
    type ChatMessage = { role: string; content: string };
    type Interrupt = { id: string; name: string; reason?: { tool?: string; input?: unknown } };

    let notes: Note[] = [];
    let sortBy: 'dueDate' | 'title' | undefined;
    let settings = { email: '', digestEnabled: false };
    let showSettings = false;
    let chatMessages: ChatMessage[] = [];
    let chatLoading = false;
    let pendingInterrupts: Interrupt[] = [];

    // ── Assistant chat (useChat handles subscribe-before-send ordering) ──
    const chat = useChat({
      api: {
        sendMessage: async (convId, msg, chId) => { await api.sendMessage(convId, msg, chId); },
        createConversation: () => api.createConversation(),
        getConversation: (id) => api.getConversation(id),
        resume: async (chId, responses, convId) => { await api.resumeAgent(chId, responses, convId!); },
      },
      subscribe: async (channelId, handler) => {
        const channel = await api.getAgentChannel(channelId);
        return channel.subscribe(handler);
      },
      onMessagesChange: (msgs: ChatMessage[]) => { chatMessages = msgs; redraw(); },
      onLoadingChange: (loading: boolean) => { chatLoading = loading; redraw(); },
      onInterrupt: (interrupts: Interrupt[]) => { pendingInterrupts = interrupts; redraw(); },
    });

    async function load() {
      notes = await api.listNotes(sortBy);
      redraw();
    }

    function fmtDue(dueDate: number) {
      if (!dueDate) return html``;
      const overdue = dueDate < Date.now();
      return html`<span class="due ${overdue ? 'overdue' : ''}">
        ${overdue ? 'OVERDUE — ' : 'due '}${new Date(dueDate).toLocaleDateString()}
      </span>`;
    }

    function redraw() {
      render(html`
        <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">

          <!-- ── Notes column ── -->
          <div style="flex:2;min-width:380px">
            <h2>Notes</h2>
            <div style="margin-bottom:12px;display:flex;flex-direction:column;gap:2px">
              <div style="display:flex;gap:4px;flex-wrap:wrap">
                <input id="new-title" type="text" placeholder="Title — press Enter to add" style="flex:1;min-width:200px"
                  @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') addNote(); }} />
                <button @click=${addNote}>Add</button>
              </div>
              <textarea id="new-body" placeholder="Body (optional)" rows="2"></textarea>
              <div style="display:flex;gap:4px;flex-wrap:wrap">
                <input id="new-tags" type="text" placeholder="tags, comma, separated" style="flex:1" />
                <input id="new-due" type="date" />
              </div>
            </div>
            <div style="margin-bottom:12px;font-size:0.85em;color:#666">
              Sort:
              <button @click=${() => setSort(undefined)} style="font-weight:${!sortBy ? 'bold' : 'normal'}">Default</button>
              <button @click=${() => setSort('dueDate')} style="font-weight:${sortBy === 'dueDate' ? 'bold' : 'normal'}">Due date</button>
              <button @click=${() => setSort('title')} style="font-weight:${sortBy === 'title' ? 'bold' : 'normal'}">Title</button>
            </div>
            <ul>
              ${notes.map(n => html`
                <li style="margin:10px 0;padding:8px;border:1px solid #eee;border-radius:6px;${n.completed ? 'opacity:0.5' : ''}">
                  <div style="display:flex;align-items:center;gap:8px">
                    <input type="checkbox" .checked=${n.completed} @change=${() => toggle(n.noteId)} />
                    <span style="flex:1;font-weight:500;${n.completed ? 'text-decoration:line-through' : ''}">${n.title}</span>
                    ${fmtDue(n.dueDate)}
                    <button @click=${() => remove(n.noteId)}>×</button>
                  </div>
                  ${n.body ? html`<div style="margin:4px 0 0 26px;font-size:0.9em;color:#555;white-space:pre-wrap">${n.body}</div>` : ''}
                  ${n.tags.length ? html`<div style="margin:4px 0 0 26px">${n.tags.map(t => html`<span class="tag">${t}</span>`)}</div>` : ''}
                </li>
              `)}
            </ul>
            <p style="color:#888;font-size:0.85em">${notes.filter(n => !n.completed).length} remaining</p>

            <!-- ── Digest settings ── -->
            <button @click=${async () => { showSettings = !showSettings; if (showSettings) settings = await api.getSettings(); redraw(); }}>
              ⚙ Digest settings
            </button>
            ${showSettings ? html`
              <div style="border:1px solid #eee;border-radius:6px;padding:10px;margin-top:6px;font-size:0.9em">
                <label>Email: <input id="digest-email" type="email" .value=${settings.email} /></label>
                <label style="margin-left:8px">
                  <input id="digest-enabled" type="checkbox" .checked=${settings.digestEnabled} />
                  Send me a daily digest of due notes (8 AM IST)
                </label>
                <button @click=${saveSettings}>Save</button>
              </div>` : ''}
          </div>

          <!-- ── Assistant column ── -->
          <div style="flex:1;min-width:300px">
            <h2>Assistant</h2>
            <div class="chat-log" id="chat-log">
              ${chatMessages.length === 0 ? html`<p style="color:#999">Try: "what's due this week?", "add a note to renew the car insurance by next Friday", or "how does the email digest work?"</p>` : ''}
              ${chatMessages.map(m => html`
                <div class="${m.role === 'user' ? 'chat-msg-user' : 'chat-msg-assistant'}"><span>${m.content}</span></div>
              `)}
              ${chatLoading ? html`<div class="chat-msg-assistant"><span>…</span></div>` : ''}
              ${pendingInterrupts.map(i => html`
                <div style="border:1px solid #ffb74d;background:#fff3e0;border-radius:6px;padding:8px;margin:6px 0">
                  Allow the assistant to run <strong>${i.reason?.tool ?? i.name}</strong>?
                  <button @click=${() => respondInterrupt(i, true)}>Yes</button>
                  <button @click=${() => respondInterrupt(i, false)}>No</button>
                </div>
              `)}
            </div>
            <div style="display:flex;gap:4px;margin-top:6px">
              <input id="chat-input" type="text" placeholder="Ask about your notes…" style="flex:1;min-width:150px"
                @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') sendChat(); }} />
              <button @click=${sendChat} ?disabled=${chatLoading}>Send</button>
            </div>
          </div>
        </div>
      `, container);
      const log = container.querySelector('#chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    }

    async function addNote() {
      const title = (container.querySelector('#new-title') as HTMLInputElement).value.trim();
      if (!title) return;
      const body = (container.querySelector('#new-body') as HTMLTextAreaElement).value.trim();
      const tags = (container.querySelector('#new-tags') as HTMLInputElement).value
        .split(',').map(t => t.trim()).filter(Boolean);
      const dueRaw = (container.querySelector('#new-due') as HTMLInputElement).value;
      const dueDate = dueRaw ? Date.parse(dueRaw) : 0;
      await api.createNote(title, body, tags, dueDate);
      ['#new-title', '#new-body', '#new-tags', '#new-due'].forEach(sel => {
        (container.querySelector(sel) as HTMLInputElement).value = '';
      });
      await load();
    }

    function setSort(s: 'dueDate' | 'title' | undefined) {
      sortBy = s;
      load();
    }

    async function toggle(noteId: string) {
      try { await api.toggleNote(noteId); } catch { /* conflict — just reload */ }
      await load();
    }

    async function remove(noteId: string) {
      await api.deleteNote(noteId);
      await load();
    }

    async function saveSettings() {
      const email = (container.querySelector('#digest-email') as HTMLInputElement).value.trim();
      const enabled = (container.querySelector('#digest-enabled') as HTMLInputElement).checked;
      settings = await api.updateSettings(email, enabled);
      showSettings = false;
      redraw();
    }

    async function sendChat() {
      const input = container.querySelector('#chat-input') as HTMLInputElement;
      const message = input.value.trim();
      if (!message || chatLoading) return;
      input.value = '';
      await chat.sendMessage(message);
    }

    async function respondInterrupt(i: Interrupt, approved: boolean) {
      pendingInterrupts = pendingInterrupts.filter(p => p.id !== i.id);
      redraw();
      await chat.respondToInterrupt([{ interruptId: i.id, approved }]);
      await load(); // approved tools may have changed notes
    }

    // Realtime: reflect changes from other tabs/devices (and agent tool writes)
    (async () => {
      try {
        const channel = await api.subscribeNotes();
        const sub = channel.subscribe(() => load());
        await sub.established;
      } catch { /* realtime not available in local dev */ }
    })();

    load();
    return container;
  })
);
