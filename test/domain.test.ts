import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { filterNotes, getDueMeta, summarizeNotes, type Note } from '../src/domain/notes';

const NOW = new Date('2026-07-04T12:00:00+05:30');
const notes: Note[] = [
  { noteId: '1', title: 'Plan launch', body: 'Confirm owners', tags: ['work'], dueDate: NOW.getTime(), completed: false },
  { noteId: '2', title: 'Buy tea', body: '', tags: ['personal'], dueDate: 0, completed: true },
  { noteId: '3', title: 'Renew policy', body: 'Car insurance', tags: ['admin'], dueDate: NOW.getTime() - 86_400_000, completed: false },
];

describe('note domain helpers', () => {
  test('describes today, overdue, and missing due dates', () => {
    assert.deepEqual(getDueMeta(NOW.getTime(), NOW), { label: 'Due today', overdue: false, today: true });
    assert.deepEqual(getDueMeta(NOW.getTime() - 86_400_000, NOW), { label: '1d overdue', overdue: true, today: false });
    assert.equal(getDueMeta(0, NOW), null);
  });

  test('filters by status and searchable content', () => {
    assert.deepEqual(filterNotes(notes, 'open', '').map(note => note.noteId), ['1', '3']);
    assert.deepEqual(filterNotes(notes, 'all', 'personal').map(note => note.noteId), ['2']);
    assert.deepEqual(filterNotes(notes, 'open', 'insurance').map(note => note.noteId), ['3']);
  });

  test('summarizes the workbench', () => {
    assert.deepEqual(summarizeNotes(notes, NOW), { openCount: 2, doneCount: 1, dueNowCount: 2 });
  });
});
