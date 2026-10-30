// Saves each user's audits in this browser, separately per account. Nothing is sent anywhere.
import { migrateNoteExamples } from './model.js';

const keyFor = (userId) => `aghs-audit-builder:v2:${userId}`;

export function load(userId) {
  try {
    // Unowned legacy data must not be handed to the next person who signs in.
    const raw = localStorage.getItem(keyFor(userId));
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.audits)) return { audits: d.audits.map(migrateNoteExamples), auditor: d.auditor || '' };
  } catch {
    // Storage blocked or corrupt: start empty.
  }
  return { audits: [], auditor: '' };
}

export function save(db, userId) {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify({ audits: db.audits, auditor: db.auditor }));
    return true;
  } catch {
    return false;
  }
}
