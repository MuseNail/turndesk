// Pure core for the per-tech notes list (Item 4). Shared by the client store (optimistic applyChange)
// and the Worker DO (authoritative merge) so the two can't drift. A note = { id, text }. Every
// operation is keyed by note id, so two devices adding DIFFERENT notes both survive — there is no
// whole-list clobber (unlike the old single-string staff.patch). add is idempotent (safe to replay
// from the offline outbox); edit/remove are no-ops when the id is gone.

export const NOTES_CAP = 12;   // soft cap on notes per tech
export const NOTE_MAX = 200;   // chars per note

// Canonical array from a staff object: an existing notesList wins; else a legacy `notes` string
// migrates to a single note; else []. Tolerates junk entries.
export function normalizeNotesList(st) {
  if (st && Array.isArray(st.notesList)) {
    return st.notesList.filter(n => n && n.id).map(n => ({ id: n.id, text: String(n.text || '') }));
  }
  const s = st && typeof st.notes === 'string' ? st.notes.trim() : '';
  return s ? [{ id: 'legacy', text: s }] : [];
}

export function applyNotePatch(list, action, note) {
  const arr = Array.isArray(list) ? list.map(n => ({ id: n.id, text: n.text })) : [];
  if (!note || !note.id) return arr;
  const id = note.id;
  const text = () => String(note.text || '').slice(0, NOTE_MAX);
  if (action === 'add') {
    if (arr.some(n => n.id === id)) return arr;   // idempotent
    if (arr.length >= NOTES_CAP) return arr;      // soft cap
    return [...arr, { id, text: text() }];
  }
  if (action === 'edit') return arr.map(n => n.id === id ? { id, text: text() } : n);
  if (action === 'remove') return arr.filter(n => n.id !== id);
  return arr;
}

// Joined string mirror kept on `st.notes` for back-compat (old clients + anything reading st.notes).
export function notesMirror(list) {
  return (Array.isArray(list) ? list : []).map(n => n && n.text).filter(Boolean).join(' · ');
}
