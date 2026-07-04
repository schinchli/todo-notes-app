/** Shared note types and presentation-safe domain helpers. */
export type Note = {
  noteId: string;
  title: string;
  body: string;
  tags: string[];
  dueDate: number;
  completed: boolean;
};

export type SortBy = 'dueDate' | 'title' | undefined;
export type StatusFilter = 'all' | 'open' | 'done';

export type DueMeta = {
  label: string;
  overdue: boolean;
  today: boolean;
};

export function getDueMeta(dueDate: number, now = new Date()): DueMeta | null {
  if (!dueDate) return null;

  const due = new Date(dueDate);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const days = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000);
  const label = days < 0
    ? `${Math.abs(days)}d overdue`
    : days === 0 ? 'Due today'
    : days === 1 ? 'Due tomorrow'
    : `Due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  return { label, overdue: days < 0, today: days === 0 };
}

export function filterNotes(notes: Note[], status: StatusFilter, searchQuery: string): Note[] {
  const query = searchQuery.trim().toLowerCase();
  return notes.filter(note => {
    const matchesStatus = status === 'all'
      || (status === 'done' ? note.completed : !note.completed);
    const matchesQuery = !query || [note.title, note.body, ...note.tags]
      .some(value => value.toLowerCase().includes(query));
    return matchesStatus && matchesQuery;
  });
}

export function summarizeNotes(notes: Note[], now = new Date()) {
  const openCount = notes.filter(note => !note.completed).length;
  return {
    openCount,
    doneCount: notes.length - openCount,
    dueNowCount: notes.filter(note => {
      const due = getDueMeta(note.dueDate, now);
      return !note.completed && due && (due.overdue || due.today);
    }).length,
  };
}
