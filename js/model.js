// Audit data shapes, formatting, and everything derived from answers
// (flags, reason text, notes). Shared by the UI and the PDF builder.
import { QUESTIONS, GENERAL_EXAMPLES, PAY_PERIOD_ANCHOR } from './config.js';

const pad = (n) => String(n).padStart(2, '0');

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => toISO(new Date());

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, days) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

// 09/27/2026
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// October 15, 2026
export function fmtLong(iso) {
  if (!iso) return '';
  return parseISO(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// 9/27
export function fmtShort(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
}

// "07:00" -> "07:00 AM"
export function fmtTime(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${pad(h)}:${pad(m)} ${ap}`;
}

// Reads a typed time the way people write it: "7", "7a", "7:30 pm", "730p", "19:30", "noon".
// Returns "HH:MM" (24-hour), "" for an empty box, or null if it isn't a time.
export function parseTime(text) {
  const s = String(text || '').trim().toLowerCase().replace(/[\s.]/g, '');
  if (!s) return '';
  if (s === 'noon') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3][0] === 'p' && h !== 12) h += 12;
    if (m[3][0] === 'a' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(min)}`;
}

export function payPeriod(audit) {
  const { payStart, payEnd } = audit;
  if (payStart && payEnd) return `${fmtShort(payStart)} - ${fmtShort(payEnd)}`;
  return fmtShort(payStart || payEnd);
}

// ---- Pay periods ----

// Whole days between two ISO dates, immune to daylight-saving shifts.
const daysBetween = (a, b) => {
  const utc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(b) - utc(a)) / 86400000);
};

const periodStart = (index) => addDays(PAY_PERIOD_ANCHOR, index * 14);
const payDateOf = (index) => addDays(periodStart(index), 19); // the Friday after the period ends

// A pay period by its position in the cycle (0 = first period of 2026).
// `number` restarts at 1 each year, counted by the year of the pay date, as on the AGHS schedule.
export function payPeriodAt(index) {
  const year = payDateOf(index).slice(0, 4);
  let first = index;
  while (payDateOf(first - 1).slice(0, 4) === year) first--;
  const start = periodStart(index);
  return { index, number: index - first + 1, year, start, end: addDays(start, 13), payDate: payDateOf(index) };
}

export const payPeriodIndexFor = (iso) => Math.floor(daysBetween(PAY_PERIOD_ANCHOR, iso) / 14);

export const currentPayPeriod = (today = todayISO()) => payPeriodAt(payPeriodIndexFor(today));
export const lastPayPeriod = (today = todayISO()) => payPeriodAt(payPeriodIndexFor(today) - 1);

// New audits cover the most recent pay period that has already ended.
export function lastCompletedPayPeriod(today = todayISO()) {
  const p = lastPayPeriod(today);
  return { payStart: p.start, payEnd: p.end };
}

// "Oct 11 – Oct 24, 2026"
export function fmtRange(startIso, endIso) {
  const f = (iso, opts) => parseISO(iso).toLocaleDateString('en-US', opts);
  return `${f(startIso, { month: 'short', day: 'numeric' })} – ${f(endIso, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

export const dateLabel = (e) => (e.allShifts ? 'All shifts' : fmtDate(e.date));

export function shiftLabel(e) {
  if (e.allShifts) return 'All shifts';
  if (!e.shiftStart && !e.shiftEnd) return '';
  return `${fmtTime(e.shiftStart)} - ${fmtTime(e.shiftEnd)}`;
}

// ---- Creating things ----

const blankCheck = () => ({ answer: null, reasons: [], otherOn: false, other: '', notes: '' });

export function newEntry() {
  return {
    id: uid(),
    createdAt: Date.now(),
    allShifts: false,
    otherThanListed: false,
    date: '',
    author: '',
    shiftStart: '',
    shiftEnd: '',
    checks: Object.fromEntries(QUESTIONS.map((q) => [q.key, blankCheck()])),
    reasonOverride: null,
  };
}

const SITE_TEXT_FIELDS = ['name', 'address', 'phone', 'managerTitle', 'manager', 'cell', 'email', 'supervisor'];

// A site/home as stored in a sites file: text fields plus a list of residents.
export function cleanSite(s) {
  const site = { id: String(s.id || uid()) };
  for (const f of SITE_TEXT_FIELDS) site[f] = String(s[f] ?? '').trim();
  site.residents = (s.residents || []).map((r) => String(r).trim()).filter(Boolean);
  return site;
}

export function newAudit(site, auditor) {
  const { id, ...snapshot } = cleanSite(site);
  return {
    id: uid(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    auditDate: todayISO(),
    auditor: auditor || '',
    siteId: id,
    site: snapshot,
    ...lastCompletedPayPeriod(),
    individuals: {},
    general: {
      notes: '',
      repeatStaff: null, // null = use the automatic suggestions
      recommendations: GENERAL_EXAMPLES.recommendations.map((_, exampleIndex) => ({ title: '', text: '', exampleIndex })),
      closing: '',
      examplesAsPlaceholders: true,
    },
  };
}

// Existing audits used to save the examples as real text. Convert exact defaults
// once, keeping custom writing and later deliberately typed example wording.
export function migrateNoteExamples(audit) {
  const general = audit.general;
  if (!general || general.examplesAsPlaceholders) return audit;
  for (const recommendation of general.recommendations || []) {
    const exampleIndex = GENERAL_EXAMPLES.recommendations.findIndex((example) =>
      recommendation.title === example.title || recommendation.text === example.text);
    if (exampleIndex < 0) continue;
    const example = GENERAL_EXAMPLES.recommendations[exampleIndex];
    recommendation.exampleIndex = exampleIndex;
    if (recommendation.title === example.title) recommendation.title = '';
    if (recommendation.text === example.text) recommendation.text = '';
  }
  if (general.closing === GENERAL_EXAMPLES.closing) general.closing = '';
  general.examplesAsPlaceholders = true;
  return audit;
}

export function individual(audit, name) {
  if (!Object.hasOwn(audit.individuals, name)) {
    Object.defineProperty(audit.individuals, name, { value: { notes: '', entries: [] }, writable: true, enumerable: true, configurable: true });
  }
  return audit.individuals[name];
}

export const sortNames = (names) => [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

// ---- Deriving from answers ----

export const isFlagged = (q, check) => check?.answer === q.flagOn;
export const entryFlags = (e) => QUESTIONS.filter((q) => isFlagged(q, e.checks[q.key]));
export const entryFlagged = (e) => entryFlags(e).length > 0;
export const entryComplete = (e) => QUESTIONS.every((q) => e.checks[q.key].answer);

function sentence(s) {
  s = s.trim();
  s = s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

export function generatedReason(e) {
  const parts = [];
  for (const q of entryFlags(e)) {
    const c = e.checks[q.key];
    for (const r of q.reasons) if (c.reasons.includes(r.key)) parts.push(r.text);
    if (c.otherOn && c.other.trim()) parts.push(sentence(c.other));
  }
  return parts.join(' ');
}

export const entryReason = (e) => (e.reasonOverride ?? '').trim() || generatedReason(e);

// Dated shifts in date/time order, then "all shifts" rows.
export function sortedEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.allShifts !== b.allShifts) return a.allShifts ? 1 : -1;
    return (a.date + a.shiftStart).localeCompare(b.date + b.shiftStart) || a.createdAt - b.createdAt;
  });
}

// The individual's own notes, then any notes written on a shift's questions.
export function individualNotes(audit, name) {
  const ind = Object.hasOwn(audit.individuals, name) ? audit.individuals[name] : null;
  if (!ind) return [];
  const lines = splitLines(ind.notes);
  for (const e of sortedEntries(ind.entries)) {
    const label = [dateLabel(e), e.allShifts ? '' : shiftLabel(e)].filter(Boolean).join(', ');
    const who = e.author ? ` (${e.author})` : '';
    for (const q of QUESTIONS) {
      const n = e.checks[q.key].notes.trim();
      if (n) lines.push(`${label}${who}: ${n}`);
    }
  }
  return lines;
}

export const splitLines = (text) =>
  (text || '').split('\n').map((s) => s.trim().replace(/^[-–•*]\s*/, '')).filter(Boolean);

// An individual is done once they have a flagged shift, or are marked as having adequate documentation.
export function individualDone(audit, name) {
  const ind = Object.hasOwn(audit.individuals, name) ? audit.individuals[name] : null;
  if (!ind) return false;
  return Boolean(ind.adequate) || ind.entries.some((e) => entryComplete(e) && entryFlagged(e));
}

export const remainingIndividuals = (audit) => audit.site.residents.filter((n) => !individualDone(audit, n));

// The audit can be marked complete while working on the last individual (all but one done).
export const canCompleteAudit = (audit) => remainingIndividuals(audit).length <= 1;

export const allEntries = (audit) => Object.values(audit.individuals).flatMap((i) => i.entries);

// Authors with flagged submissions, most flags first. An "all shifts" row counts as repeated on its own.
export function flaggedAuthors(audit) {
  const counts = new Map();
  for (const e of allEntries(audit)) {
    const name = e.author.trim();
    if (!name || !entryFlagged(e)) continue;
    counts.set(name, (counts.get(name) || 0) + (e.allShifts ? 2 : 1));
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export const suggestedRepeatStaff = (audit) => flaggedAuthors(audit).filter((a) => a.count >= 2).map((a) => a.name);

export const repeatStaff = (audit) => audit.general.repeatStaff ?? suggestedRepeatStaff(audit);
