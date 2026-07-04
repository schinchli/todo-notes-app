/**
 * Frontend entry point — src/main.ts
 *
 * A responsive notes workbench with filtering, digest settings, and an AI
 * assistant. All persistence and cloud capabilities stay behind AWS Blocks.
 */
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, AuthenticatedContent, onAuthChange } from '@aws-blocks/blocks/ui';
import { useChat } from '@aws-blocks/bb-agent/client';
import { html, render } from 'lit-html';
import { filterNotes, getDueMeta, summarizeNotes, type Note, type SortBy, type StatusFilter } from './domain/notes';
import './styles/app.css';

type ChatMessage = { role: string; content: string };
type Interrupt = { id: string; name: string; reason?: { tool?: string; input?: unknown } };

const menuBarEl = document.getElementById('menu-bar')!;
menuBarEl.appendChild(AccountMenuBar(authApi));

onAuthChange(authApi, user => {
  document.body.classList.toggle('is-signed-in', user != null);
  document.getElementById('sign-in-panel')!.hidden = user != null;
});

document.getElementById('app')!.appendChild(
  AuthenticatedContent(authApi, () => {
    const container = document.createElement('div');
    container.className = 'app-shell';

    let notes: Note[] = [];
    let notesLoading = true;
    let sortBy: SortBy;
    let statusFilter: StatusFilter = 'all';
    let searchQuery = '';
    let settings = { email: '', digestEnabled: false };
    let showSettings = false;
    let chatMessages: ChatMessage[] = [];
    let chatLoading = false;
    let pendingInterrupts: Interrupt[] = [];
    let errorMessage = '';
    let toastMessage = '';
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    let draft = { title: '', body: '', tags: '', due: '' };

    const chat = useChat({
      api: {
        sendMessage: async (convId, msg, chId) => { await api.sendMessage(convId, msg, chId); },
        createConversation: () => api.createConversation(),
        getConversation: id => api.getConversation(id),
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

    function friendlyError(error: unknown) {
      return error instanceof Error && error.message
        ? error.message
        : 'Something went wrong. Please try again.';
    }

    async function runAction(action: () => Promise<void>) {
      errorMessage = '';
      try {
        await action();
      } catch (error) {
        errorMessage = friendlyError(error);
        redraw();
      }
    }

    function showToast(message: string) {
      toastMessage = message;
      clearTimeout(toastTimer);
      redraw();
      toastTimer = setTimeout(() => {
        toastMessage = '';
        redraw();
      }, 2600);
    }

    async function load(initial = false) {
      if (initial) notesLoading = true;
      await runAction(async () => {
        notes = await api.listNotes(sortBy);
        notesLoading = false;
        redraw();
      });
    }

    function redraw() {
      const { openCount, doneCount, dueNowCount: dueCount } = summarizeNotes(notes);
      const filteredNotes = filterNotes(notes, statusFilter, searchQuery);

      render(html`
        ${errorMessage ? html`
          <div class="alert alert-error" role="alert">
            <span>${errorMessage}</span>
            <button class="icon-button" aria-label="Dismiss error" @click=${() => { errorMessage = ''; redraw(); }}>×</button>
          </div>
        ` : ''}

        <section class="today-strip" aria-label="Note summary">
          <div class="today-heading">
            <span class="eyebrow">Your workbench</span>
            <strong>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</strong>
          </div>
          <div class="metric"><strong>${openCount}</strong><span>Open</span></div>
          <div class="metric ${dueCount ? 'metric-warm' : ''}"><strong>${dueCount}</strong><span>Due now</span></div>
          <div class="metric"><strong>${doneCount}</strong><span>Completed</span></div>
        </section>

        <div class="workspace-grid">
          <main class="notes-workspace">
            <section class="capture-card" aria-labelledby="capture-title">
              <div class="section-heading">
                <div>
                  <span class="eyebrow">Quick capture</span>
                  <h2 id="capture-title">What needs your attention?</h2>
                </div>
                <span class="key-hint">Enter to save</span>
              </div>
              <div class="capture-form">
                <label class="field field-title">
                  <span>Note title</span>
                  <input id="new-title" type="text" maxlength="160" autocomplete="off"
                    placeholder="e.g. Send the project brief"
                    .value=${draft.title}
                    @input=${(e: InputEvent) => { draft.title = (e.target as HTMLInputElement).value; }}
                    @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') addNote(); }} />
                </label>
                <label class="field field-body">
                  <span>Details <em>optional</em></span>
                  <textarea id="new-body" maxlength="4000" rows="3" placeholder="Add context, links, or next steps"
                    .value=${draft.body}
                    @input=${(e: InputEvent) => { draft.body = (e.target as HTMLTextAreaElement).value; }}></textarea>
                </label>
                <div class="capture-meta">
                  <label class="field">
                    <span>Tags <em>comma separated</em></span>
                    <input id="new-tags" type="text" placeholder="work, follow-up"
                      .value=${draft.tags}
                      @input=${(e: InputEvent) => { draft.tags = (e.target as HTMLInputElement).value; }} />
                  </label>
                  <label class="field field-date">
                    <span>Due date <em>optional</em></span>
                    <input id="new-due" type="date" .value=${draft.due}
                      @input=${(e: InputEvent) => { draft.due = (e.target as HTMLInputElement).value; }} />
                  </label>
                  <button class="button button-primary add-button" @click=${addNote} ?disabled=${!draft.title.trim()}>
                    Add note
                  </button>
                </div>
              </div>
            </section>

            <section class="notes-section" aria-labelledby="notes-title">
              <div class="section-heading notes-heading">
                <div>
                  <span class="eyebrow">Notes</span>
                  <h2 id="notes-title">Your list</h2>
                </div>
                <button class="button button-quiet" aria-expanded=${showSettings}
                  @click=${toggleSettings}>Digest settings</button>
              </div>

              ${showSettings ? html`
                <form class="settings-card" @submit=${(e: SubmitEvent) => { e.preventDefault(); saveSettings(); }}>
                  <div>
                    <strong>Daily digest</strong>
                    <p>Get due and overdue notes at 8:00 AM IST.</p>
                  </div>
                  <label class="field settings-email">
                    <span>Email address</span>
                    <input id="digest-email" type="email" required .value=${settings.email} />
                  </label>
                  <label class="toggle-label">
                    <input id="digest-enabled" type="checkbox" .checked=${settings.digestEnabled} />
                    <span>Send my digest</span>
                  </label>
                  <button class="button button-primary" type="submit">Save settings</button>
                </form>
              ` : ''}

              <div class="toolbar">
                <label class="search-field">
                  <span class="sr-only">Search notes</span>
                  <input type="search" placeholder="Search notes and tags" .value=${searchQuery}
                    @input=${(e: InputEvent) => { searchQuery = (e.target as HTMLInputElement).value; redraw(); }} />
                </label>
                <div class="segmented" aria-label="Filter notes">
                  ${(['all', 'open', 'done'] as const).map(filter => html`
                    <button class=${statusFilter === filter ? 'active' : ''}
                      aria-pressed=${statusFilter === filter}
                      @click=${() => { statusFilter = filter; redraw(); }}>${filter === 'done' ? 'Completed' : filter[0].toUpperCase() + filter.slice(1)}</button>
                  `)}
                </div>
                <label class="sort-control">
                  <span>Sort</span>
                  <select @change=${(e: Event) => setSort((e.target as HTMLSelectElement).value as SortBy)}>
                    <option value="" ?selected=${!sortBy}>Recently added</option>
                    <option value="dueDate" ?selected=${sortBy === 'dueDate'}>Due date</option>
                    <option value="title" ?selected=${sortBy === 'title'}>Title</option>
                  </select>
                </label>
              </div>

              ${notesLoading ? html`
                <div class="loading-list" aria-label="Loading notes">
                  ${[1, 2, 3].map(() => html`<div class="skeleton"></div>`)}
                </div>
              ` : filteredNotes.length ? html`
                <ul class="note-list">
                  ${filteredNotes.map(note => noteCard(note))}
                </ul>
                <p class="list-caption">Showing ${filteredNotes.length} of ${notes.length} note${notes.length === 1 ? '' : 's'}</p>
              ` : html`
                <div class="empty-state">
                  <div class="empty-mark" aria-hidden="true">✓</div>
                  <h3>${notes.length ? 'No notes match this view' : 'A clear desk'}</h3>
                  <p>${notes.length ? 'Try another search or filter.' : 'Capture your first note above. Small is a perfectly good place to begin.'}</p>
                </div>
              `}
            </section>
          </main>

          <aside class="assistant-panel" aria-labelledby="assistant-title">
            <div class="assistant-heading">
              <div class="assistant-orb" aria-hidden="true"></div>
              <div>
                <span class="eyebrow">Built-in helper</span>
                <h2 id="assistant-title">Notes assistant</h2>
              </div>
            </div>
            <p class="assistant-intro">Ask about your list, find help, or prepare a note. You approve every change before it happens.</p>

            <div class="suggestion-list" aria-label="Suggested questions">
              ${['What is due this week?', 'Summarize my open notes', 'How does the digest work?'].map(prompt => html`
                <button @click=${() => sendChat(prompt)}>${prompt}</button>
              `)}
            </div>

            <div class="chat-log" id="chat-log" aria-live="polite">
              ${chatMessages.length === 0 ? html`
                <div class="chat-empty">
                  <span>Ready when you are.</span>
                  <p>Your conversation will appear here.</p>
                </div>
              ` : ''}
              ${chatMessages.map(message => html`
                <div class=${message.role === 'user' ? 'chat-msg chat-msg-user' : 'chat-msg chat-msg-assistant'}>
                  <span>${message.content}</span>
                </div>
              `)}
              ${chatLoading ? html`<div class="chat-msg chat-msg-assistant"><span class="typing"><i></i><i></i><i></i></span></div>` : ''}
              ${pendingInterrupts.map(interrupt => html`
                <div class="approval-card">
                  <span class="eyebrow">Approval needed</span>
                  <p>Allow the assistant to run <strong>${interrupt.reason?.tool ?? interrupt.name}</strong>?</p>
                  <div>
                    <button class="button button-primary" @click=${() => respondInterrupt(interrupt, true)}>Allow</button>
                    <button class="button button-quiet" @click=${() => respondInterrupt(interrupt, false)}>Decline</button>
                  </div>
                </div>
              `)}
            </div>
            <div class="chat-composer">
              <label>
                <span class="sr-only">Message the notes assistant</span>
                <textarea id="chat-input" rows="2" placeholder="Ask about your notes…"
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
                  }}></textarea>
              </label>
              <button class="button button-primary" @click=${() => sendChat()} ?disabled=${chatLoading}>Send</button>
            </div>
            <p class="assistant-footnote">Shift + Enter for a new line</p>
          </aside>
        </div>

        ${toastMessage ? html`<div class="toast" role="status">${toastMessage}</div>` : ''}
      `, container);

      const log = container.querySelector('#chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    }

    function noteCard(note: Note) {
      const due = getDueMeta(note.dueDate);
      return html`
        <li class=${`note-card ${note.completed ? 'is-complete' : ''}`}>
          <label class="check-control">
            <input type="checkbox" .checked=${note.completed} @change=${() => toggle(note.noteId)} />
            <span aria-hidden="true"></span>
            <span class="sr-only">Mark ${note.title} ${note.completed ? 'open' : 'complete'}</span>
          </label>
          <div class="note-content">
            <div class="note-title-row">
              <h3>${note.title}</h3>
              ${due ? html`<span class=${`due-pill ${due.overdue ? 'is-overdue' : ''} ${due.today ? 'is-today' : ''}`}>${due.label}</span>` : ''}
            </div>
            ${note.body ? html`<p class="note-body">${note.body}</p>` : ''}
            ${note.tags.length ? html`
              <div class="tag-list">${note.tags.map(tag => html`<span>${tag}</span>`)}</div>
            ` : ''}
          </div>
          <button class="icon-button delete-button" aria-label=${`Delete ${note.title}`} @click=${() => remove(note)}>×</button>
        </li>
      `;
    }

    async function addNote() {
      const title = draft.title.trim();
      if (!title) {
        (container.querySelector('#new-title') as HTMLInputElement | null)?.focus();
        return;
      }
      await runAction(async () => {
        const tags = [...new Set(draft.tags.split(',').map(tag => tag.trim()).filter(Boolean))];
        const dueDate = draft.due ? new Date(`${draft.due}T12:00:00`).getTime() : 0;
        await api.createNote(title, draft.body.trim(), tags, dueDate);
        draft = { title: '', body: '', tags: '', due: '' };
        await load();
        showToast('Note added');
        requestAnimationFrame(() => (container.querySelector('#new-title') as HTMLInputElement | null)?.focus());
      });
    }

    function setSort(value: SortBy) {
      sortBy = value || undefined;
      load();
    }

    async function toggle(noteId: string) {
      await runAction(async () => {
        await api.toggleNote(noteId);
        await load();
      });
    }

    async function remove(note: Note) {
      if (!window.confirm(`Delete “${note.title}”? This cannot be undone.`)) return;
      await runAction(async () => {
        await api.deleteNote(note.noteId);
        await load();
        showToast('Note deleted');
      });
    }

    async function toggleSettings() {
      showSettings = !showSettings;
      if (showSettings) {
        await runAction(async () => { settings = await api.getSettings(); });
      }
      redraw();
    }

    async function saveSettings() {
      const email = (container.querySelector('#digest-email') as HTMLInputElement).value.trim();
      const enabled = (container.querySelector('#digest-enabled') as HTMLInputElement).checked;
      await runAction(async () => {
        settings = await api.updateSettings(email, enabled);
        showSettings = false;
        redraw();
        showToast('Digest settings saved');
      });
    }

    async function sendChat(suggestedMessage?: string) {
      const input = container.querySelector('#chat-input') as HTMLTextAreaElement | null;
      const message = (suggestedMessage ?? input?.value ?? '').trim();
      if (!message || chatLoading) return;
      if (input) input.value = '';
      await runAction(async () => { await chat.sendMessage(message); });
    }

    async function respondInterrupt(interrupt: Interrupt, approved: boolean) {
      pendingInterrupts = pendingInterrupts.filter(item => item.id !== interrupt.id);
      redraw();
      await runAction(async () => {
        await chat.respondToInterrupt([{ interruptId: interrupt.id, approved }]);
        await load();
      });
    }

    (async () => {
      try {
        const channel = await api.subscribeNotes();
        const subscription = channel.subscribe(() => load());
        await subscription.established;
      } catch {
        // Realtime is optional in local development and LocalStack.
      }
    })();

    load(true);
    return container;
  }),
);
