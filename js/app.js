import { QUESTIONS, GENERAL_EXAMPLES, APP_VERSION, GITHUB_URL } from './config.js';
import { load, save } from './store.js';
import { buildPdf, pdfFileName } from './pdf.js';
import { OCTICONS } from './octicons.js';
import { logoSvg } from './logo.js';
import * as api from './api.js';
import { completionMatchesAudit, canReopenCompletion } from './progress.js';
import { createAuditWatcher, SITE_BUSY_MESSAGE } from './audit-watcher.js';
import { createSessionGuard } from './session-guard.js';
import {
  activityStorage, createIdleSession, createTabCoordinator,
  IDLE_BEFORE_WARNING_MS, LOGOUT_WARNING_MS,
} from './session-lifecycle.js';
import {
  newAudit, newEntry, individual, sortNames, fmtDate, fmtLong, payPeriod, addDays, todayISO, parseISO, parseTime, fmtTime,
  lastPayPeriod, currentPayPeriod, fmtRange, payPeriodAt, payPeriodIndexFor,
  dateLabel, shiftLabel, entryFlagged, entryComplete, entryReason, generatedReason, sortedEntries,
  individualNotes, allEntries, flaggedAuthors, repeatStaff, isFlagged,
  individualDone, remainingIndividuals, canCompleteAudit,
} from './model.js';

const app = document.getElementById('app');
const saveStateEl = document.getElementById('save-state');

let session = { checked: false, profile: null }; // nothing renders until the sign-in check finishes
let db = { audits: [], auditor: '' };
let binds = {}; // objects that data-bind="root:path" inputs write into, set per view
const freshUi = () => ({
  error: '',
  pdfUrl: null,
  homes: null, // homes from the database; null until loaded
  homesError: '',
  completions: {}, // shared progress per pay period start: { list, loadedAt, loading, error }
  completeMsg: null, // { ok, text } after marking an audit complete or reopening it
  completing: false,
  deleting: false,
  pickingSite: false,
  progressOpen: false,
  login: { username: '', password: '', busy: false, error: '' },
  admin: { tab: 'homes', users: null, notice: '', error: '', busy: false, draft: null, draftFor: null, addingUser: false, newUser: null, resetFor: null, resetPassword: '' },
});
let ui = freshUi();
let lastHash = null;
let lastViewKey = null;
let lastMotionRoute = null;
let pageTransition = null;
let renderRevision = 0;
let routeAnimationTimer;
let auditWatcher = null;
let sessionGuard = null;
let tabCoordinator = null;
let idleSession = null;
let toastTimer;
let themeTransitionTimer;

const SESSION_DURATION_SECONDS = (IDLE_BEFORE_WARNING_MS + LOGOUT_WARNING_MS) / 1000;

function sessionTimerState(seconds, warning = seconds <= LOGOUT_WARNING_MS / 1000) {
  const active = seconds >= SESSION_DURATION_SECONDS;
  const danger = !active && warning;
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return {
    active,
    danger,
    idle: !active && !danger,
    label: active ? 'Active' : `${minutes}:${remainder}`,
  };
}

function renderSessionTimer(seconds, warning) {
  const timer = document.getElementById('session-timer');
  if (!timer) return;
  if (!session.profile) {
    timer.hidden = true;
    return;
  }
  const state = sessionTimerState(seconds, warning);
  timer.innerHTML = `${icon(state.active ? 'check-circle' : state.danger ? 'alert-circle' : 'clock')}<span>${state.label}</span>`;
  timer.classList.toggle('is-active', state.active);
  timer.classList.toggle('is-idle', state.idle);
  timer.classList.toggle('is-warning', state.danger);
  timer.title = state.active ? 'Session active' : state.danger ? 'Session expires in one minute or less' : 'Session inactivity timer';
  timer.hidden = false;
}

function showToast(message) {
  const toast = document.getElementById('audit-toast');
  toast.innerHTML = `${icon('alert-circle', 20)}<span>${esc(message)}</span>`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

function showSessionWarning(seconds) {
  const toast = document.getElementById('session-toast');
  if (!toast.querySelector('[data-session-countdown]')) {
    toast.innerHTML = `${icon('alert-circle', 20)}<span data-session-countdown></span><button class="btn btn-sm" type="button" data-stay-signed-in>Stay signed in</button>`;
  }
  toast.querySelector('[data-session-countdown]').textContent = `Warning: session expires in ${seconds}s due to inactivity.`;
  toast.hidden = false;
}

function hideSessionWarning() {
  document.getElementById('session-toast').hidden = true;
}

const needsReservation = (audit) => audit && allSites().some((h) => h.id === audit.siteId) && !completionOf(audit);

function syncAuditWatcher() {
  if (!auditWatcher || ui.pickingSite) return;
  auditWatcher.watch(parseRoute()[0] === 'new');
  const audit = currentAudit();
  const target = auditWatcher.snapshot().target;
  if (needsReservation(audit)) {
    if (target?.homeId !== audit.siteId || target?.auditId !== audit.id) {
      auditWatcher.open({ homeId: audit.siteId, auditId: audit.id });
    }
  } else {
    auditWatcher.close();
  }
}

function auditEditingBlocked() {
  const audit = currentAudit();
  if (!auditWatcher || !needsReservation(audit) || auditWatcher.owns(audit.siteId, audit.id)) return false;
  showToast(auditWatcher.snapshot().status === 'blocked' ? SITE_BUSY_MESSAGE : 'Checking site availability. Please try again.');
  render();
  return true;
}

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const href = (...parts) => '#/' + parts.map(encodeURIComponent).join('/');
const go = (...parts) => { location.hash = href(...parts); };

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o && !['__proto__', 'constructor', 'prototype'].includes(k) && Object.hasOwn(o, k) ? o[k] : undefined, obj);
}
function setPath(obj, path, val) {
  const keys = path.split('.');
  if (keys.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) return false;
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o && Object.hasOwn(o, k) ? o[k] : null, obj);
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, last)) return false;
  parent[last] = val;
  return true;
}

let saveTimer;
function persist(audit, savedMsg = 'All changes saved') {
  if (!session.profile) return;
  if (audit) audit.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveStateEl.textContent = 'Saving…';
  saveTimer = setTimeout(() => {
    saveStateEl.textContent = save(db, session.profile.id) ? savedMsg : 'Couldn’t save in this browser';
  }, 300);
}

const allSites = () => ui.homes || [];
const isAdmin = () => Boolean(session.profile?.is_admin);

async function refreshHomes() {
  const state = ui;
  try {
    const homes = await api.listHomes();
    if (state === ui && session.profile) {
      state.homes = homes;
      state.homesError = '';
    }
  } catch (err) {
    if (state === ui) state.homesError = err.message;
  }
}

const findAudit = (id) => db.audits.find((a) => a.id === id);

function download(blob, filename) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const icon = (name, size = 16) =>
  `<svg class="octicon octicon-${name}" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${OCTICONS[name]}</svg>`;

// ---------- Primer building blocks ----------

function field({ label, bind, value = '', type = 'text', placeholder = '', hint = '', attrs = '', wide = false, optional = false }) {
  const id = 'f-' + bind.replace(/[^\w]/g, '-');
  const described = hint ? `aria-describedby="${id}-caption"` : '';
  const control = type === 'textarea'
    ? `<textarea class="form-control" id="${id}" data-bind="${bind}" placeholder="${esc(placeholder)}" ${described} ${attrs}>${esc(value)}</textarea>`
    : `<input class="form-control" id="${id}" type="${type}" data-bind="${bind}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${described} ${attrs}>`;
  return `<div class="FormField ${wide ? 'wide' : ''}">
      <label class="FormField-label" for="${id}">${label}${optional ? '<span class="FormField-optional">(optional)</span>' : ''}</label>
      ${control}
      ${hint ? `<p class="FormField-caption" id="${id}-caption">${hint}</p>` : ''}
    </div>`;
}

const errorBox = () => (ui.error ? `<div class="flash flash-error" role="alert">${icon('alert')}<span>${esc(ui.error)}</span></div>` : '');

function breadcrumbs(items, extraClass = '') {
  return `<nav aria-label="Breadcrumb"><ol class="Breadcrumbs ${extraClass}">${items
    .map(([label, link], i) => `<li class="Breadcrumbs-item">${
      i === items.length - 1 ? `<span aria-current="page">${esc(label)}</span>` : `<a href="${link}">${esc(label)}</a>`
    }</li>`)
    .join('')}</ol></nav>`;
}

const auditLabel = (audit) => `${audit.site.name} · ${payPeriod(audit)}`;

// Title, summary and tab navigation shared by the audit-level pages.
function auditHeader(audit, current) {
  const entries = allEntries(audit);
  const flagged = entries.filter(entryFlagged).length;
  const tabs = [
    ['details', 'Details', 'note', href('a', audit.id, 'setup')],
    ['people', 'Individuals', 'people', href('a', audit.id), audit.site.residents.length],
    ['general', 'General notes', 'checklist', href('a', audit.id, 'general')],
    ['pdf', 'PDF', 'file', href('a', audit.id, 'pdf')],
  ];
  return `
    ${breadcrumbs([['Audits', '#/'], [auditLabel(audit)]], 'AuditBreadcrumbs')}
    <div class="PageHeader AuditHeader">
      <div>
        <h1 class="PageHeader-title">${esc(audit.site.name)}</h1>
        <p class="PageHeader-description" data-audit-summary>Pay period ${esc(payPeriod(audit) || '—')} · Dated ${esc(fmtLong(audit.auditDate))}${audit.auditor ? ` · Audit by ${esc(audit.auditor)}` : ''}</p>
      </div>
      <div class="PageHeader-actions" data-audit-stats>
        <span class="Label Label--large">${icon('clock')} ${plural(entries.length, 'shift')} reviewed</span>
        <span class="Label Label--large ${flagged ? 'Label--danger' : ''}">${icon(flagged ? 'issue-opened' : 'check-circle')} ${flagged} flagged</span>
        ${completionOf(audit) ? `<span class="Label Label--large Label--success">${icon('check-circle')} Complete</span>` : ''}
      </div>
    </div>
    <nav class="UnderlineNav AuditTabs" aria-label="Audit sections">${tabs
      .map(([key, label, ic, link, count]) => `<a class="UnderlineNav-item" data-audit-tab="${key}" href="${link}" ${key === current ? 'aria-current="page"' : ''}>
          ${icon(ic)}<span>${label}</span>${count != null ? `<span class="Counter">${count}</span>` : ''}</a>`)
      .join('')}</nav>`;
}

const auditTabView = (audit, tab, title, html) => ({
  title,
  html,
  shellKey: `audit:${audit.id}`,
  shellTab: tab,
  shellHtml: auditHeader(audit, tab),
});

function answerLabel(q, check) {
  if (!check.answer) return `<span class="Label">${q.short}</span>`;
  const bad = isFlagged(q, check);
  return `<span class="Label ${bad ? 'Label--danger' : 'Label--success'}">${icon(bad ? 'x' : 'check')}${q.short}</span>`;
}

// ---------- shared progress ----------

// Completed audits for a pay period, shared by all users. Loads (or refreshes after 30s) on demand.
function completionsFor(payStart) {
  const c = ui.completions[payStart];
  if (!c || (!c.loading && Date.now() - c.loadedAt > 30000)) loadCompletions(payStart);
  return ui.completions[payStart] || { list: null };
}

async function loadCompletions(payStart) {
  const c = ui.completions[payStart] || (ui.completions[payStart] = { list: null, loadedAt: 0, loading: false, error: '' });
  if (c.loading) return c.request;
  c.loading = true;
  const state = ui;
  const version = c.version || 0;
  const before = JSON.stringify(c.list);
  const beforeError = c.error;
  c.request = (async () => {
    try {
      const list = await api.listCompletions(payStart);
      if (state === ui && (c.version || 0) === version) {
        c.list = list;
        c.error = '';
      }
    } catch (err) {
      if (state === ui && (c.version || 0) === version) {
        c.error = /audit_completions/.test(err.message) ? 'missing-table' : err.message;
      }
    }
    c.loading = false;
    c.loadedAt = Date.now();
    // Re-draw only if something changed, and never while someone is typing.
    const typing = app.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (state === ui && session.profile && (JSON.stringify(c.list) !== before || c.error !== beforeError) && !typing) render();
  })();
  return c.request;
}

const homeCompletionOf = (audit) => completionsFor(audit.payStart).list?.find((r) => r.home_id === audit.siteId) || null;
const completionOf = (audit) => {
  const rec = homeCompletionOf(audit);
  return completionMatchesAudit(rec, audit, session.profile?.id) ? rec : null;
};

function cacheCompletion(payStart, record) {
  const c = ui.completions[payStart] || (ui.completions[payStart] = {});
  c.version = (c.version || 0) + 1;
  c.list = [...(c.list || []).filter((r) => r.home_id !== record.home_id), record];
  c.loadedAt = Date.now();
  c.error = '';
}

async function removeCompletion(record) {
  if (!canReopenCompletion(record, session.profile)) throw new Error('Only admins can undo audit progress.');
  await api.reopenAudit(record.id);
  const c = ui.completions[record.pay_period_start];
  if (c) {
    c.version = (c.version || 0) + 1;
    c.list = c.list?.filter((r) => r.id !== record.id) || [];
    c.error = '';
    c.loadedAt = Date.now();
  }
  for (const audit of db.audits) {
    if (completionMatchesAudit(record, audit, session.profile.id)) {
      delete audit.completedAt;
      delete audit.completionId;
    }
  }
  persist();
}

const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// "Mark audit as complete" (shown while working on the last individual) or the completed state.
function completionPanel(audit, name = null) {
  const msg = ui.completeMsg
    ? `<div class="flash ${ui.completeMsg.ok ? 'flash-success' : 'flash-error'}" role="status">${icon(ui.completeMsg.ok ? 'check-circle' : 'alert')}<span>${esc(ui.completeMsg.text)}</span></div>`
    : '';
  const rec = homeCompletionOf(audit);
  if (rec) {
    const linked = completionMatchesAudit(rec, audit, session.profile.id);
    return `${msg}<div class="Box CompletePanel is-complete"><div class="Box-row">
        <span class="CompletePanel-icon">${icon('check-circle', 24)}</span>
        <div class="flex-1">
          <p class="CompletePanel-title">${linked ? 'Audit complete' : 'Home already audited'}</p>
          <p class="CompletePanel-text">Marked complete by ${esc(rec.completed_by_name || 'a user')} on ${esc(shortDate(rec.completed_at))}. ${esc(audit.site.name)} counts toward this pay period’s progress.</p>
        </div>
        ${canReopenCompletion(rec, session.profile) ? `<button class="btn btn-sm" data-action="reopenHome" data-id="${esc(rec.id)}" data-period="${esc(audit.payStart)}" ${ui.completing ? 'disabled' : ''}>${icon('undo')}Reopen</button>` : ''}
      </div></div>`;
  }
  const left = remainingIndividuals(audit);
  const othersLeft = name ? left.filter((n) => n !== name) : left;
  const ready = name ? othersLeft.length === 0 : canCompleteAudit(audit);
  if (!ready) return msg;
  const text = left.length === 0
    ? `Every individual at ${esc(audit.site.name)} is done.`
    : name && left[0] === name
      ? `${esc(name)} is the last individual. When you’re done here, mark the audit complete.`
      : `Only ${esc(left[0])} is left.`;
  return `${msg}<div class="Box CompletePanel"><div class="Box-row">
      <span class="CompletePanel-icon">${icon('checklist', 24)}</span>
      <div class="flex-1">
        <p class="CompletePanel-title">Ready to finish this audit</p>
        <p class="CompletePanel-text">${text} Marking it complete updates the pay period progress for everyone.</p>
      </div>
      <button class="btn btn-primary" data-action="markAuditComplete" ${ui.completing ? 'disabled' : ''}>${icon(ui.completing ? 'sync' : 'check')}Mark audit as complete</button>
    </div></div>`;
}

// Homes audited for the pay period being audited (the last one), shared by everyone.
// Returns null while loading, or { missingTable } if supabase/progress.sql hasn't been run.
function progressState() {
  const period = lastPayPeriod();
  const c = completionsFor(period.start);
  if (c.error === 'missing-table') return { missingTable: true };
  if (c.error) return { error: c.error };
  if (ui.homes === null || c.list === null) return null;
  const homes = allSites();
  const doneBy = new Map(c.list.map((r) => [r.home_id, r]));
  const done = homes.filter((h) => doneBy.has(h.id)).length;
  const total = homes.length;
  const state = { period, homes, doneBy, done, total, pct: total ? Math.round((done / total) * 100) : 0, complete: total > 0 && done === total };
  if (state.complete) celebrateOnce(period);
  return state;
}

const progressBar = (st, small = false) => `<div class="ProgressBar ${small ? 'ProgressBar--small' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="${st.total}" aria-valuenow="${st.done}" aria-label="${st.done} of ${st.total} homes audited">
    <span class="ProgressBar-fill" style="width: ${st.pct}%"></span>
  </div>`;

// Full progress card on the Audits page.
function progressCard() {
  const st = progressState();
  if (st?.missingTable) {
    return isAdmin()
      ? `<div class="flash flash-warn">${icon('alert')}<span>Shared progress is off. Run <code>supabase/progress.sql</code> in the Supabase SQL Editor to turn it on.</span></div>`
      : '';
  }
  if (st?.error) return `<div class="flash flash-error" role="alert">${icon('alert')}<span>Couldn’t load audit progress. ${esc(st.error)}</span><button class="btn btn-sm" data-action="refreshProgress">Retry</button></div>`;
  if (!st) return `<div class="Box ProgressCard"><div class="Box-body"><p class="m-0 color-fg-muted">${icon('sync')} Loading progress…</p></div></div>`;
  const { period, homes, doneBy, done, total, complete } = st;
  return `<section class="Box ProgressCard ${complete ? 'is-complete' : ''}" aria-label="Pay period progress">
      <div class="Box-body">
        ${ui.completeMsg ? `<p class="${ui.completeMsg.ok ? 'color-fg-success' : 'color-fg-danger'}" role="status">${esc(ui.completeMsg.text)}</p>` : ''}
        ${complete ? `<p class="ProgressCard-congrats" role="status">🎉 Congratulations! Every home has been audited for pay period #${period.number}.</p>` : ''}
        <div class="ProgressCard-head">
          <div>
            <h2 class="ProgressCard-title">Pay period #${period.number} progress</h2>
            <p class="ProgressCard-sub">${esc(fmtRange(period.start, period.end))}</p>
          </div>
          <p class="ProgressCard-count"><strong>${done}</strong> of ${total} homes audited</p>
        </div>
        ${progressBar(st)}
        <ul class="ProgressHomes">${homes.map((h) => {
          const r = doneBy.get(h.id);
          const tip = r ? `Completed by ${r.completed_by_name || 'a user'} on ${shortDate(r.completed_at)}` : 'Not audited yet';
          return `<li class="ProgressHomes-item ${r ? 'is-done' : ''}" title="${esc(tip)}"><span class="sr-only">${esc(tip)}: </span>${icon(r ? 'check-circle' : 'clock', 12)}${esc(h.name)}${canReopenCompletion(r, session.profile) ? `<button class="LinkBtn" data-action="reopenHome" data-id="${esc(r.id)}" data-period="${esc(period.start)}" aria-label="Undo ${esc(h.name)} audit completion" ${ui.completing ? 'disabled' : ''}>Undo</button>` : ''}</li>`;
        }).join('')}</ul>
      </div>
    </section>`;
}

// A compact progress bar on every signed-in page. Its details expand in place,
// without pushing the page title through a route transition.
function progressDisclosure() {
  const st = progressState();
  if (st?.missingTable) return isAdmin()
    ? `<div class="flash flash-warn ProgressNotice">${icon('alert')}<span>Shared progress is off.</span></div>` : '';
  if (st?.error) return `<div class="flash flash-error ProgressNotice" role="alert">${icon('alert')}<span>Couldn’t load audit progress.</span><button class="btn btn-sm" data-action="refreshProgress">Retry</button></div>`;
  if (!st) return `<div class="ProgressDisclosure"><div class="ProgressStrip is-loading" role="status">${icon('sync')}<span>Loading audit progress…</span></div></div>`;
  if (!st.total) return '';
  const { period, homes, doneBy, done, total, complete } = st;
  const open = ui.progressOpen;
  return `<section class="ProgressDisclosure ${open ? 'is-open' : ''}" aria-label="Pay period progress">
      <button class="ProgressStrip ${complete ? 'is-complete' : ''}" type="button" data-action="toggleProgress" aria-expanded="${open}" aria-controls="progress-details">
        <span class="ProgressStrip-label">${complete ? '🎉' : icon('checklist')} Pay period #${period.number}</span>
        ${progressBar(st, true)}
        <span class="ProgressStrip-count">${complete ? 'All homes audited' : `<strong>${done}</strong>/${total} homes`}</span>
        <span class="ProgressStrip-toggle">Details ${icon('chevron-down')}</span>
      </button>
      <div class="ProgressDropShell" id="progress-details" aria-hidden="${!open}" ${open ? '' : 'inert'}>
        <div class="ProgressDropdown">
          <div class="Box-body">
            ${ui.completeMsg ? `<p class="${ui.completeMsg.ok ? 'color-fg-success' : 'color-fg-danger'}" role="status">${esc(ui.completeMsg.text)}</p>` : ''}
            ${complete ? `<p class="ProgressCard-congrats" role="status">🎉 Congratulations! Every home has been audited for pay period #${period.number}.</p>` : ''}
            <div class="ProgressDropdown-head">
              <div><strong>Pay period #${period.number}</strong><span>${esc(fmtRange(period.start, period.end))}</span></div>
              <span><strong>${done}</strong> of ${total} homes audited</span>
            </div>
            <ul class="ProgressHomes">${homes.map((h) => {
              const record = doneBy.get(h.id);
              const tip = record ? `Completed by ${record.completed_by_name || 'a user'} on ${shortDate(record.completed_at)}` : 'Not audited yet';
              return `<li class="ProgressHomes-item ${record ? 'is-done' : ''}" title="${esc(tip)}"><span class="sr-only">${esc(tip)}: </span>${icon(record ? 'check-circle' : 'clock', 12)}${esc(h.name)}${canReopenCompletion(record, session.profile) ? `<button class="LinkBtn" data-action="reopenHome" data-id="${esc(record.id)}" data-period="${esc(period.start)}" aria-label="Undo ${esc(h.name)} audit completion" ${ui.completing ? 'disabled' : ''}>Undo</button>` : ''}</li>`;
            }).join('')}</ul>
          </div>
        </div>
      </div>
    </section>`;
}

// Confetti once per user per pay period, the first time they see every home audited.
function celebrateOnce(period) {
  const key = `aghs-celebrated:${session.profile?.id}:${period.start}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch {
    if (ui.celebrated?.[period.start]) return; // storage blocked: once per visit instead
  }
  ui.celebrated = { ...ui.celebrated, [period.start]: true };
  setTimeout(launchConfetti, 250);
}

let confettiLoad;
async function launchConfetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  confettiLoad ||= new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), {
      src: 'js/vendor/confetti.browser.js',
      onload: () => resolve(window.confetti),
      onerror: reject,
    });
    document.head.appendChild(script);
  });
  try {
    const confetti = await confettiLoad;
    const colors = ['#4aacf7', '#e3413f', '#2da44e', '#ffffff', '#f2cc60']; // AGHS blue and red, Primer green
    const burst = (x, angle) => confetti({ particleCount: 90, spread: 70, startVelocity: 55, angle, origin: { x, y: 0.7 }, colors, zIndex: 200 });
    burst(0.15, 60);
    burst(0.85, 120);
    setTimeout(() => confetti({ particleCount: 140, spread: 120, startVelocity: 40, origin: { x: 0.5, y: 0.35 }, colors, zIndex: 200, scalar: 1.1 }), 350);
  } catch {
    // No confetti if the library can't load; the congratulations text still shows.
  }
}

// ---------- views ----------

function viewHome() {
  binds = {};
  const audits = [...db.audits].sort((a, b) => b.updatedAt - a.updatedAt);
  const body = audits.length
    ? `<div class="Box">
        <div class="Box-header"><h2 class="Box-title">Your audits</h2><span class="Counter">${audits.length}</span></div>
        ${audits.map(auditRow).join('')}
      </div>`
    : `<div class="Box"><div class="blankslate">
        <span class="blankslate-icon">${icon('file-badge', 24)}</span>
        <h2 class="blankslate-heading">No audits yet? Start here!</h2>
        <p>Audits are saved on this device. Completed homes are shared with everyone.</p>
        <a class="btn btn-primary blankslate-action" href="#/new">${icon('plus')}Start a new audit</a>
      </div></div>`;
  return {
    title: 'Audits',
    html: `
      <div class="PageHeader" style="view-transition-name: page-heading">
        <div>
          <h1 class="PageHeader-title">Documentation audits</h1>
          <p class="PageHeader-description">Review submitted documentation and report indiscrepancies.</p>
        </div>
        <div class="PageHeader-actions">
          <a class="btn btn-primary" href="#/new">${icon('plus')}New audit</a>
        </div>
      </div>
      ${body}
    `};
}

function auditRow(a) {
  const entries = allEntries(a);
  const flagged = entries.filter(entryFlagged).length;
  return `<div class="Box-row Box-row--hover AuditRow">
      <span class="AuditRow-icon">${icon('file-badge')}</span>
      <div class="AuditRow-main">
        <div class="AuditRow-titleLine">
          <a class="AuditRow-title" href="${href('a', a.id)}">${esc(a.site.name)}</a>
          <span class="Label">${esc(payPeriod(a) || 'No pay period')}</span>
          ${completionOf(a) ? `<span class="Label Label--success">${icon('check')}Complete</span>` : ''}
          ${entries.length ? `<span class="Label ${flagged ? 'Label--danger' : 'Label--success'}">${flagged ? `${flagged} flagged` : 'No issues'}</span>` : ''}
        </div>
        <div class="AuditRow-meta">Dated ${esc(fmtLong(a.auditDate))}${a.auditor ? ` · ${esc(a.auditor)}` : ''} · ${plural(a.site.residents.length, 'individual')} · ${plural(entries.length, 'shift')} reviewed</div>
      </div>
      <div class="AuditRow-actions">
        <a class="btn btn-sm" href="${href('a', a.id, 'pdf')}">${icon('file')}PDF</a>
        <button class="btn btn-sm" data-action="exportAudit" data-id="${esc(a.id)}" title="Download a backup of this audit">${icon('download')}Backup</button>
        <button class="btn-octicon btn-octicon-danger" data-action="deleteAudit" data-id="${esc(a.id)}" aria-label="Delete ${esc(a.site.name)} audit" title="Delete audit">${icon('trash')}</button>
      </div>
    </div>`;
}

function viewNew() {
  binds = {};
  const sites = allSites();
  const header = `
    ${breadcrumbs([['Audits', '#/'], ['New audit']])}
    <div class="PageHeader" style="view-transition-name: page-heading">
      <div>
        <h1 class="PageHeader-title">Which home are you auditing?</h1>
      </div>
    </div>`;
  if (ui.homes === null) {
    if (!ui.homesError) refreshHomes().then(() => parseRoute()[0] === 'new' && render());
    return {
      title: 'New audit',
      html: `${header}${ui.homesError
        ? `<div class="flash flash-error">${icon('alert')}<span>Couldn’t load homes: ${esc(ui.homesError)}</span></div>`
        : `<div class="Box"><div class="blankslate"><span class="blankslate-icon">${icon('sync', 24)}</span><p>Loading homes…</p></div></div>`}`,
    };
  }
  const lastPeriod = lastPayPeriod();
  const activity = auditWatcher?.snapshot();
  const doneList = completionsFor(lastPeriod.start).list || [];
  const tiles = sites
    .map((s) => {
      const rec = doneList.find((r) => r.home_id === s.id);
      const occupied = activity?.list.find((r) => r.home_id === s.id);
      const blocked = occupied && occupied.user_id !== session.profile.id;
      const content = `
        ${rec ? `<span class="Label Label--success HomeTile-badge" title="Completed by ${esc(rec.completed_by_name || 'a user')} on ${esc(shortDate(rec.completed_at))}">${icon('check')}Audited #${lastPeriod.number}</span>` : ''}
        <span class="HomeTile-name">${esc(s.name)}</span>
        ${occupied ? `<span class="HomeTile-warning">${icon('alert-circle')} ${blocked ? 'This site is already being audited' : 'You’re auditing this site'}</span>` : ''}
        <span class="HomeTile-line">${icon('location')}<span>${esc(s.address || 'No address')}</span></span>
        ${s.manager ? `<span class="HomeTile-line">${icon('person')}<span>${esc(s.managerTitle || 'Lead/Manager')}: ${esc(s.manager)}</span></span>` : ''}
        <span class="HomeTile-line">${icon('people')}<span>${plural(s.residents.length, 'resident')}</span></span>`;
      if (rec) {
        return `<div class="HomeTile-wrap"><div class="HomeTile HomeTile--static is-done ${occupied ? 'is-auditing' : ''}" aria-disabled="true">
          ${content}
          <div class="HomeTile-footer">
            <span class="HomeTile-go HomeTile-go--complete">${icon('check-circle')} Completed by ${esc(rec.completed_by_name || 'a user')}</span>
            ${canReopenCompletion(rec, session.profile) ? `<button class="LinkBtn HomeTile-undo" data-action="reopenHome" data-id="${esc(rec.id)}" data-period="${esc(lastPeriod.start)}" aria-label="Undo ${esc(s.name)} audit completion" ${ui.completing || ui.pickingSite ? 'disabled' : ''}>${icon('undo')} Undo</button>` : ''}
          </div>
        </div></div>`;
      }
      return `<div class="HomeTile-wrap"><button class="HomeTile ${occupied ? 'is-auditing' : ''}" data-action="pickSite" data-id="${esc(s.id)}" ${blocked ? 'aria-disabled="true"' : ''} ${ui.pickingSite ? 'disabled' : ''}>
        ${content}
        <span class="HomeTile-go">${blocked ? `${icon('alert-circle')} Site in use` : `Start audit ${icon('arrow-right')}`}</span>
      </button></div>`;
    })
    .join('');
  return {
    title: 'New audit',
    html: `${header}
      ${activity?.error ? `<div class="flash flash-warn" role="status">${icon('alert-circle')}<span>Couldn’t check site availability. Please try again.</span><button class="btn btn-sm" data-action="refreshActivity">Retry</button></div>` : !activity?.loaded ? '<p class="color-fg-muted" role="status">Checking site availability…</p>' : ''}
      ${sites.length
        ? `<div class="HomeGrid">${tiles}</div>`
        : `<div class="Box"><div class="blankslate">
            <span class="blankslate-icon">${icon('home', 24)}</span>
            <h2 class="blankslate-heading">No homes yet</h2>
            <p>${isAdmin() ? 'Add homes in the admin dashboard.' : 'Your administrator hasn’t added any homes yet.'}</p>
            ${isAdmin() ? `<a class="btn btn-primary blankslate-action" href="#/admin">${icon('shield-lock')}Open admin dashboard</a>` : ''}
          </div></div>`}`,
  };
}

// Pay period picker: the last finished period (the default for new audits) or the current one.
function payPeriodSelect(audit) {
  const status = completionsFor(audit.payStart);
  const completed = Boolean(completionOf(audit) || ((status.loading || status.error) && (audit.completionId || audit.completedAt)));
  const choices = [['Last pay period', lastPayPeriod()], ['Current pay period', currentPayPeriod()]]
    .map(([label, p]) => ({ label: `${label} · #${p.number} · ${fmtRange(p.start, p.end)}`, start: p.start, payDate: p.payDate }));
  // An older audit may cover an earlier period; keep it selectable so it isn't silently changed.
  if (audit.payStart && !choices.some((c) => c.start === audit.payStart)) {
    choices.unshift({ label: `Saved pay period · ${fmtRange(audit.payStart, audit.payEnd || audit.payStart)}`, start: audit.payStart });
  }
  const selected = choices.find((c) => c.start === audit.payStart) || choices[0];
  return `<div class="FormField wide">
      <label class="FormField-label" for="f-audit-payStart">Pay period</label>
      <select class="form-select" id="f-audit-payStart" data-bind="audit:payStart" data-rerender aria-describedby="f-audit-payStart-caption" ${completed ? 'disabled' : ''}>
        ${choices.map((c) => `<option value="${c.start}" ${c === selected ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
      </select>
      <p class="FormField-caption" id="f-audit-payStart-caption">${completed ? 'Reopen this audit to change its pay period.' : `${selected.payDate ? `Paid ${esc(fmtLong(selected.payDate))}. ` : ''}New audits start on the last pay period, from the AGHS pay schedule.`}</p>
    </div>`;
}

function viewSetup(audit) {
  binds = { audit };
  const isToday = audit.auditDate === todayISO();
  return auditTabView(audit, 'details', `${audit.site.name} · Details`, `
      <div class="Box">
        <div class="Box-header"><h2 class="Box-title">Audit</h2></div>
        <div class="Box-body">
          <div class="FormGrid">
            ${field({ label: 'Audit by', bind: 'audit:auditor', value: audit.auditor, placeholder: 'Your full name' })}
            <div class="FormField">
              <label class="FormField-label" for="f-date">Audit date</label>
              <input class="form-control" id="f-date" type="date" data-bind="audit:auditDate" value="${esc(audit.auditDate)}">
              <p class="FormField-caption">${isToday ? 'Set to today for each new audit.' : `<button class="LinkBtn" data-action="dateToday">Use today’s date</button>`}</p>
            </div>
            ${payPeriodSelect(audit)}
          </div>
        </div>
      </div>
      <div class="Box">
        <div class="Box-header">
          <h2 class="Box-title">${icon('home')} ${esc(audit.site.name)}</h2>
          <div class="Box-headerActions"><span class="Label">${icon('lock')}Managed by AGHS</span></div>
        </div>
        <div class="Box-body">
          <dl class="HomeFacts">
            <div><dt>Location</dt><dd>${esc(audit.site.address || '—')}</dd></div>
            <div><dt>${esc(audit.site.managerTitle || 'Lead/Manager')}</dt><dd>${esc(audit.site.manager || '—')}</dd></div>
          </dl>
        </div>
        <div class="Box-body">
          <p class="HomeFacts-label">Individuals</p>
          <ul class="ResidentList">${sortNames(audit.site.residents).map((r) => `<li><span class="InitialsAvatar">${esc(initials(r))}</span>${esc(r)}</li>`).join('')}</ul>
          <p class="FormField-caption">Home details are printed in the PDF’s Audit Information section. Each individual gets their own table in the audit log.</p>
        </div>
      </div>
      ${errorBox()}
      <div class="NavBar">
        <a class="btn" href="#/">${icon('chevron-left')}All audits</a>
        <div class="NavBar-end"><button class="btn btn-primary" data-action="setupNext">Choose individuals${icon('chevron-right')}</button></div>
      </div>`);
}

function viewHub(audit) {
  binds = {};
  const rows = sortNames(audit.site.residents)
    .map((name) => {
      const entries = audit.individuals[name]?.entries || [];
      const flagged = entries.filter(entryFlagged).length;
      const unfinished = entries.some((e) => !entryComplete(e));
      const done = individualDone(audit, name);
      const adequate = audit.individuals[name]?.adequate && !flagged;
      return `<a class="Box-row Box-row--link" href="${href('a', audit.id, 'i', name)}">
          <span class="InitialsAvatar ${done ? 'InitialsAvatar--done' : ''}">${done ? icon('check') : esc(initials(name))}</span>
          <span class="PersonRow-main">
            <span class="PersonRow-name d-block">${esc(name)}</span>
            <span class="PersonRow-meta">${entries.length ? `${plural(entries.length, 'shift')} reviewed` : adequate ? 'Reviewed, nothing to flag' : 'Not started'}</span>
          </span>
          ${unfinished ? '<span class="Label Label--attention">Unfinished</span>' : ''}
          ${adequate ? `<span class="Label Label--success">${icon('check')}Adequate</span>`
            : entries.length ? `<span class="Label ${flagged ? 'Label--danger' : ''}">${flagged ? `${flagged} flagged` : 'Nothing flagged yet'}</span>` : ''}
          <span class="PersonRow-chevron">${icon('chevron-right')}</span>
        </a>`;
    })
    .join('');
  return auditTabView(audit, 'people', `${audit.site.name} · Individuals`, `
      <div>
        <h2 class="SectionHeading">Which individual would you like to audit?</h2>
        <p class="PageHeader-description">Come back here any time to switch between individuals.</p>
      </div>
      <div class="Box">
        ${rows || '<div class="blankslate blankslate--narrow"><p>No individuals are listed for this home. Add them to your homes file and import it again.</p></div>'}
      </div>
      ${completionPanel(audit)}
      <div class="NavBar">
        <a class="btn" href="${href('a', audit.id, 'setup')}">${icon('chevron-left')}Details</a>
        <div class="NavBar-end"><a class="btn btn-primary" href="${href('a', audit.id, 'general')}">General notes${icon('chevron-right')}</a></div>
      </div>`);
}

function viewIndividual(audit, name) {
  const ind = individual(audit, name);
  binds = { ind };
  const entries = sortedEntries(ind.entries);
  const rows = entries
        .map((e) => {
          const status = !entryComplete(e) ? '<span class="Label Label--attention">Unfinished</span>'
            : entryFlagged(e) ? '<span class="Label Label--danger">In audit log</span>' : '<span class="Label Label--success">No issues</span>';
          return `<div class="Box-row EntryRow">
              <a class="EntryRow-link" href="${href('a', audit.id, 'i', name, 'e', e.id, entryComplete(e) ? 'review' : 'details')}">
                <span><span class="EntryRow-date d-block">${esc(dateLabel(e) || 'No date')}</span>${e.allShifts ? '' : `<span class="EntryRow-shift">${esc(shiftLabel(e) || 'No shift time')}</span>`}</span>
                <span class="EntryRow-author">${icon('person')} ${esc(e.author || 'No author')}</span>
                ${status}
                <span class="EntryRow-labels">${QUESTIONS.map((q) => answerLabel(q, e.checks[q.key])).join('')}</span>
              </a>
              <button class="btn-octicon btn-octicon-danger" data-action="deleteEntry" data-id="${esc(e.id)}" aria-label="Delete this shift" title="Delete shift">${icon('trash')}</button>
            </div>`;
        })
        .join('');

  const flaggedAny = entries.some((e) => entryComplete(e) && entryFlagged(e));
  const doneLabel = individualDone(audit, name)
    ? `<span class="Label Label--success Label--large">${icon('check')}${ind.adequate && !flaggedAny ? 'Adequate documentation' : 'Done'}</span>` : '';
  // With shifts but nothing flagged: offer to mark the documentation adequate.
  const adequacy = !entries.length || flaggedAny ? '' : ind.adequate
    ? `<div class="flash flash-success">${icon('check-circle')}<div class="flex-1"><strong>Adequate documentation.</strong> ${esc(name)} is done; nothing is flagged.</div>
        <button class="btn btn-sm" data-action="undoAdequate">${icon('undo')}Undo</button></div>`
    : `<div class="Box AdequateBox"><div class="Box-row">
        <span class="color-fg-muted">${icon('info')}</span>
        <p class="flex-1 m-0">No shifts are flagged for ${esc(name)}. If their documentation is fine, mark it adequate to move on.</p>
        <button class="btn" data-action="markAdequate">${icon('check-circle')}Individual has adequate documentation</button>
      </div></div>`;

  // No shifts yet: a centered hero puts "Add a shift" front and center.
  const top = entries.length
    ? `<div class="PageHeader" style="view-transition-name: person-heading">
        <div class="PageHeader-lead">
          <span class="InitialsAvatar InitialsAvatar--large">${esc(initials(name))}</span>
          <div>
            <h1 class="PageHeader-title">${esc(name)}</h1>
            <p class="PageHeader-description">${esc(audit.site.name)} · Pay period ${esc(payPeriod(audit))}</p>
          </div>
        </div>
        <div class="PageHeader-actions">${doneLabel}<button class="btn btn-primary" data-action="addEntry">${icon('plus')}Add a shift</button></div>
      </div>
      <div class="Box">
        <div class="Box-header"><h2 class="Box-title">Flagged documentation</h2><span class="Counter">${entries.length}</span></div>
        ${rows}
      </div>
      ${adequacy}`
    : `<section class="IndividualHero" style="view-transition-name: person-heading">
        <span class="InitialsAvatar InitialsAvatar--hero">${esc(initials(name))}</span>
        <h1 class="IndividualHero-name">${esc(name)}</h1>
        <p class="IndividualHero-meta">
          <span>${icon('home')} ${esc(audit.site.name)}</span>
          <span>${icon('calendar')} Pay period ${esc(payPeriod(audit))}</span>
        </p>
        ${ind.adequate
          ? `<p class="IndividualHero-done">${icon('check-circle', 20)} Adequate documentation</p>
             <p class="IndividualHero-text">${esc(name)} is done, with nothing flagged. Add a shift if you find something after all.</p>
             <div class="IndividualHero-actions">
               <button class="btn btn-large" data-action="addEntry">${icon('plus')}Add a shift</button>
               <button class="btn btn-large btn-invisible" data-action="undoAdequate">${icon('undo')}Undo</button>
             </div>`
          : `<p class="IndividualHero-text">No shifts reviewed yet. Add a shift to flag documentation, or mark it adequate if nothing needs flagging.</p>
             <div class="IndividualHero-actions">
               <button class="btn btn-primary btn-large" data-action="addEntry" autofocus>${icon('plus')}Add a shift</button>
               <button class="btn btn-large" data-action="markAdequate">${icon('check-circle')}Individual has adequate documentation</button>
             </div>`}
      </section>`;

  const fromShifts = individualNotes(audit, name).slice(splitCount(ind.notes));
  return {
    title: `${name} · ${audit.site.name}`,
    html: `
      ${breadcrumbs([['Audits', '#/'], [auditLabel(audit), href('a', audit.id)], [name]])}
      ${top}
      ${completionPanel(audit, name)}
      <div class="Box">
        <div class="Box-header"><h2 class="Box-title">Notes for ${esc(name)}</h2></div>
        <div class="Box-body">
          ${field({ label: 'General notes about this individual', bind: 'ind:notes', type: 'textarea', value: ind.notes, placeholder: 'e.g. There is only one submission of documentation on the 29th of September.', hint: 'Each line becomes a bullet under this individual’s Notes in the PDF.' })}
          ${fromShifts.length ? `<div class="NotesPreview mt-3"><p class="NotesPreview-title">Also included from shift notes</p><ul>${fromShifts.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
        </div>
      </div>
      <div class="NavBar">
        <a class="btn" href="${href('a', audit.id)}">${icon('chevron-left')}All individuals</a>
      </div>`,
  };
}

const splitCount = (text) => (text || '').split('\n').filter((s) => s.trim().replace(/^[-–•*]\s*/, '')).length;

const ENTRY_STEPS = [['details', 'Shift'], ...QUESTIONS.map((q) => [q.key, q.short]), ['review', 'Review']];

function viewEntry(audit, name, entry, step) {
  binds = { entry };
  const idx = ENTRY_STEPS.findIndex((s) => s[0] === step);
  const detailsDone = entry.author && (entry.allShifts || (entry.date && entry.shiftStart && entry.shiftEnd));
  const steps = `<ol class="ProgressSteps">${ENTRY_STEPS.map(([key, label], i) => {
    const q = QUESTIONS.find((x) => x.key === key);
    let state = '';
    let marker = '';
    if (q && entry.checks[key].answer) {
      const bad = isFlagged(q, entry.checks[key]);
      state = bad ? 'is-bad' : 'is-good';
      marker = icon(bad ? 'x' : 'check', 12);
    } else if (key === 'details' && detailsDone) {
      state = 'is-done';
      marker = icon('check', 12);
    }
    return `<li class="ProgressSteps-item ${state} ${i === idx ? 'is-current' : ''}">
        <a class="ProgressSteps-link" href="${href('a', audit.id, 'i', name, 'e', entry.id, key)}" ${i === idx ? 'aria-current="step"' : ''}>
          <span class="ProgressSteps-marker">${marker}</span>${label}</a></li>`;
  }).join('')}</ol>`;

  let body;
  if (step === 'details') body = entryDetails(audit, name, entry);
  else if (step === 'review') body = entryReview(audit, name, entry);
  else body = entryQuestion(name, entry, QUESTIONS.find((q) => q.key === step));

  const back = idx > 0
    ? `<a class="btn" href="${href('a', audit.id, 'i', name, 'e', entry.id, ENTRY_STEPS[idx - 1][0])}">${icon('chevron-left')}Back</a>`
    : `<a class="btn" href="${href('a', audit.id, 'i', name)}">${icon('chevron-left')}${esc(name)}</a>`;
  const next = step === 'review'
    ? `<div class="NavBar-end">
         <button class="btn" data-action="addEntry">${icon('plus')}Add another shift</button>
         <a class="btn btn-primary" href="${href('a', audit.id, 'i', name)}">${icon('check')}Done</a>
       </div>`
    : `<div class="NavBar-end"><button class="btn btn-primary" data-action="entryNext" data-step="${step}">Next${icon('chevron-right')}</button></div>`;

  return {
    title: `${name} · Shift`,
    html: `
      ${breadcrumbs([['Audits', '#/'], [auditLabel(audit), href('a', audit.id)], [name, href('a', audit.id, 'i', name)], ['Shift']])}
      ${steps}
      ${body}
      ${errorBox()}
      <div class="NavBar">${back}${next}</div>`,
  };
}

// The 14 days of the audit's pay period as a two-week calendar (periods run Sunday to Saturday).
function shiftCalendar(audit, name, e) {
  if (!audit.payStart) {
    return field({ label: 'Submission date', bind: 'entry:date', type: 'date', value: e.date, wide: true });
  }
  const days = Array.from({ length: 14 }, (_, i) => addDays(audit.payStart, i));
  const period = payPeriodAt(payPeriodIndexFor(audit.payStart));
  const today = todayISO();
  const shiftsOn = {};
  for (const other of individual(audit, name).entries) {
    if (other !== e && !other.allShifts && other.date) shiftsOn[other.date] = (shiftsOn[other.date] || 0) + 1;
  }
  const long = (iso) => parseISO(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const cells = days.map((iso, i) => {
    const d = parseISO(iso);
    const showMonth = i === 0 || d.getDate() === 1;
    const count = shiftsOn[iso] || 0;
    const label = `${long(iso)}${count ? `, ${plural(count, 'shift')} already added` : ''}${iso === today ? ', today' : ''}`;
    return `<button type="button" class="ShiftCal-day ${iso === today ? 'is-today' : ''}" data-action="pickShiftDate" data-date="${iso}"
        aria-pressed="${e.date === iso}" aria-label="${esc(label)}" title="${esc(label)}">
        <span class="ShiftCal-month">${showMonth ? d.toLocaleDateString('en-US', { month: 'short' }) : '&nbsp;'}</span>
        <span class="ShiftCal-num">${d.getDate()}</span>
        <span class="ShiftCal-dots">${'<span class="ShiftCal-dot"></span>'.repeat(Math.min(count, 3))}</span>
      </button>`;
  });
  const outside = e.date && !days.includes(e.date);
  return `<div class="FormField wide">
      <span class="FormField-label" id="shift-date-label">Submission date</span>
      <div class="ShiftCal" role="group" aria-labelledby="shift-date-label">
        <div class="ShiftCal-head">
          <span>${icon('calendar')} Pay period #${period.number} · ${esc(fmtRange(audit.payStart, audit.payEnd))}</span>
          <span class="ShiftCal-picked">${e.date && !outside ? esc(long(e.date)) : 'Pick a day'}</span>
        </div>
        <div class="ShiftCal-grid">
          ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => `<span class="ShiftCal-dow" aria-hidden="true">${w}</span>`).join('')}
          ${cells.join('')}
        </div>
      </div>
      <p class="FormField-caption">${outside
        ? `${icon('alert', 12)} This shift is saved as ${esc(fmtDate(e.date))}, outside this pay period. Pick a day above to change it.`
        : `Only days in this audit’s pay period. A dot means a shift for ${esc(name)} is already added that day.`}</p>
    </div>`;
}

// Every hour (shifts start and end on the hour), for the suggestions list under the time boxes.
const TIME_OPTIONS = Array.from({ length: 24 }, (_, h) => `<option value="${fmtTime(`${String(h).padStart(2, '0')}:00`)}">`).join('');

const TIME_HINT = 'Type it any way: 7a, 7 pm, 3p or 15:00.';

// A plain, empty text box for a time (the browser's time box keeps "--:-- --" in it while you type).
// It's tidied into "07:30 PM" when you leave the box; see the [data-time] handler below.
function timeField(label, bind, value) {
  const id = 'f-' + bind.replace(/[^\w]/g, '-');
  return `<div class="FormField">
      <label class="FormField-label" for="${id}">${label}</label>
      <input class="form-control" id="${id}" type="text" data-time="${bind}" value="${esc(fmtTime(value))}"
        placeholder="e.g. 7:00 AM" list="time-options" autocomplete="off" spellcheck="false" aria-describedby="${id}-caption">
      <p class="FormField-caption" id="${id}-caption">${TIME_HINT}</p>
    </div>`;
}

function entryDetails(audit, name, e) {
  const authors = [...new Set(allEntries(audit).map((x) => x.author.trim()).filter(Boolean))];
  return `
    <div>
      <h1 class="PageHeader-title">Which documentation are you auditing?</h1>
      <p class="PageHeader-description">These fill the Submission Date, Author and Shift columns of the audit log.</p>
    </div>
    <div class="Box">
      <div class="Box-body">
        <div class="FormGrid">
          ${field({ label: 'Author (DSP staff)', bind: 'entry:author', value: e.author, placeholder: 'Full name', attrs: `list="authors" autocomplete="off" ${e.author ? '' : 'autofocus'}`, wide: true })}
          <datalist id="authors">${authors.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
          ${e.allShifts ? '' : `
            ${shiftCalendar(audit, name, e)}
            ${timeField('Shift start', 'entry:shiftStart', e.shiftStart)}
            ${timeField('Shift end', 'entry:shiftEnd', e.shiftEnd)}
            <datalist id="time-options">${TIME_OPTIONS}</datalist>`}
        </div>
      </div>
      <div class="Box-body">
        <label class="CheckRow">
          <input type="checkbox" data-bind="entry:allShifts" data-rerender ${e.allShifts ? 'checked' : ''}>
          <span class="CheckRow-text"><span class="CheckRow-label">Applies to all shifts by this author</span><span class="CheckRow-caption">Prints “ALL SHIFTS DOCUMENTED” instead of a date and shift.</span></span>
        </label>
        ${e.allShifts ? `<label class="CheckRow CheckRow--nested mt-3">
            <input type="checkbox" data-bind="entry:otherThanListed" ${e.otherThanListed ? 'checked' : ''}>
            <span class="CheckRow-text"><span class="CheckRow-label">Other than the shifts listed separately</span><span class="CheckRow-caption">Adds “(Other than listed above)”.</span></span>
          </label>` : ''}
      </div>
    </div>`;
}

function entryQuestion(name, e, q) {
  const c = e.checks[q.key];
  const flagged = isFlagged(q, c);
  const choices = ['yes', 'no']
    .map((v) => `<button class="Choice ${v === q.flagOn ? 'Choice--flag' : 'Choice--ok'}" data-action="answer" data-q="${q.key}" data-v="${v}" aria-pressed="${c.answer === v}">
        ${icon(v === 'yes' ? 'check-circle' : 'x-circle', 20)}<span>${v === 'yes' ? 'Yes' : 'No'}</span></button>`)
    .join('');
  const reasonRow = (checked, label, input) => `<label class="Box-row ReasonRow ${checked ? 'is-checked' : ''}">${input}<span class="ReasonRow-label">${label}</span></label>`;
  const reasons = flagged
    ? `<div class="Box ReasonBox">
        <div class="Box-header">
          <h2 class="Box-title">${q.why}</h2>
          <span class="f6 color-fg-muted">Choose all that apply. These write the Reason column.</span>
        </div>
        ${q.reasons.map((r) => reasonRow(c.reasons.includes(r.key), r.label,
          `<input type="checkbox" data-action="toggleReason" data-q="${q.key}" data-r="${r.key}" ${c.reasons.includes(r.key) ? 'checked' : ''}>`)).join('')}
        ${reasonRow(c.otherOn, 'Other', `<input type="checkbox" data-bind="entry:checks.${q.key}.otherOn" data-rerender ${c.otherOn ? 'checked' : ''}>`)}
        ${c.otherOn ? `<div class="Box-body">${field({ label: 'Describe the reason', bind: `entry:checks.${q.key}.other`, type: 'textarea', value: c.other, placeholder: 'e.g. Behaviors were described throughout the documentation, but…', attrs: 'autofocus' })}</div>` : ''}
      </div>`
    : '';
  return `
    <div>
      <h1 class="PageHeader-title">${q.title}</h1>
      <p class="PageHeader-description">${q.help}</p>
    </div>
    <div class="Choices" role="group" aria-label="${esc(q.title)}">${choices}</div>
    ${reasons}
    <div class="Box">
      <div class="Box-body">
        ${field({ label: 'Notes', optional: true, bind: `entry:checks.${q.key}.notes`, type: 'textarea', value: c.notes, placeholder: 'Anything worth noting about this part of the documentation', hint: `Added under ${esc(name)}’s Notes in the PDF.` })}
      </div>
    </div>`;
}

function entryReview(audit, name, e) {
  const flagged = entryFlagged(e);
  const rows = QUESTIONS.map((q) => {
    const c = e.checks[q.key];
    const picked = q.reasons.filter((r) => c.reasons.includes(r.key)).map((r) => r.label);
    if (c.otherOn && c.other.trim()) picked.push(`Other: ${c.other.trim()}`);
    const answer = c.answer
      ? `<span class="Label ${isFlagged(q, c) ? 'Label--danger' : 'Label--success'}">${icon(isFlagged(q, c) ? 'x' : 'check')}${c.answer === 'yes' ? 'Yes' : 'No'}</span>`
      : '<span class="Label">Not answered</span>';
    return `<div class="Box-row ReviewRow">
        <a class="ReviewRow-q" href="${href('a', audit.id, 'i', name, 'e', e.id, q.key)}">${q.title}</a>
        ${answer}
        ${isFlagged(q, c) && picked.length ? `<span class="ReviewRow-detail">${picked.map(esc).join(' · ')}</span>` : ''}
        ${c.notes.trim() ? `<span class="ReviewRow-detail">${icon('note', 12)} ${esc(c.notes.trim())}</span>` : ''}
      </div>`;
  }).join('');
  const overridden = e.reasonOverride != null && e.reasonOverride.trim() !== generatedReason(e);
  return `
    <div><h1 class="PageHeader-title">Review this shift</h1></div>
    <div class="Box">
      <div class="Box-body">
        <dl class="Summary">
          <div><dt>Submission date</dt><dd>${esc(e.allShifts ? 'All shifts documented' : fmtDate(e.date) || '—')}</dd></div>
          <div><dt>Author</dt><dd>${esc(e.author || '—')}</dd></div>
          <div><dt>Shift</dt><dd>${esc(shiftLabel(e) || '—')}</dd></div>
        </dl>
      </div>
      ${rows}
    </div>
    ${flagged
      ? `<div class="Box">
          <div class="Box-header">
            <h2 class="Box-title">Reason in the audit log</h2>
            ${overridden ? `<div class="Box-headerActions"><button class="btn btn-sm" data-action="resetReason">${icon('undo')}Reset to generated</button></div>` : ''}
          </div>
          <div class="Box-body">
            <div class="FormField">
              <textarea class="form-control" rows="4" data-bind="entry:reasonOverride" aria-label="Reason in the audit log" aria-describedby="reason-caption">${esc(entryReason(e))}</textarea>
              <p class="FormField-caption" id="reason-caption">Written from your answers. Edit it freely; your wording is kept.</p>
            </div>
          </div>
        </div>`
      : `<div class="flash flash-success">${icon('check-circle')}<span><strong>No issues found.</strong> This shift won’t appear in the audit log table, but any notes you wrote are still added to ${esc(name)}’s notes.</span></div>`}`;
}

function viewGeneral(audit) {
  const g = audit.general;
  binds = { general: g };
  const authors = flaggedAuthors(audit);
  const chosen = repeatStaff(audit);
  const names = [...new Set([...authors.map((a) => a.name), ...chosen])];
  const staffRows = names.length
    ? names.map((n) => {
        const count = authors.find((a) => a.name === n)?.count;
        return `<label class="Box-row ReasonRow ${chosen.includes(n) ? 'is-checked' : ''}">
            <input type="checkbox" data-action="toggleStaff" data-name="${esc(n)}" ${chosen.includes(n) ? 'checked' : ''}>
            <span class="ReasonRow-label">${esc(n)}</span>
            ${count ? `<span class="Label ${count >= 2 ? 'Label--danger' : ''}">${count >= 2 ? 'Repeated' : '1 flag'}</span>` : ''}
          </label>`;
      }).join('')
    : '<div class="blankslate blankslate--narrow"><p>No flagged staff yet. Names appear here as you flag shifts.</p></div>';

  return auditTabView(audit, 'general', `${audit.site.name} · General notes`, `
      <div>
        <h2 class="SectionHeading">General notes</h2>
        <p class="PageHeader-description">Your text goes on the General Notes page of the PDF. Gray examples are hints and won’t be included.</p>
      </div>
      <div class="Box">
        <div class="Box-header">
          <h2 class="Box-title">Staff with repetitive infractions</h2>
          <span class="f6 color-fg-muted">Staff flagged on 2 or more shifts are selected for you.</span>
        </div>
        ${staffRows}
        <div class="Box-footer">
          <form class="InlineAdd" data-action="addStaff">
            <input class="form-control" type="text" name="name" placeholder="Add a staff name" aria-label="Staff name">
            <button class="btn" type="submit">${icon('plus')}Add</button>
          </form>
        </div>
      </div>
      <div class="Box">
        <div class="Box-header"><h2 class="Box-title">Notes</h2></div>
        <div class="Box-body">
          ${field({ label: 'General notes for this audit', bind: 'general:notes', type: 'textarea', value: g.notes, placeholder: 'Anything that applies to the whole home or audit', hint: 'Each line becomes a bullet.' })}
        </div>
      </div>
      <div class="Box">
        <div class="Box-header">
          <h2 class="Box-title">Recommendations</h2>
          <div class="Box-headerActions"><button class="btn btn-sm" data-action="addRec">${icon('plus')}Add</button></div>
        </div>
        ${g.recommendations.map((r, i) => `<div class="Box-body RecRow">
            <div class="RecRow-head">
              ${field({ label: 'Title', bind: `general:recommendations.${i}.title`, value: r.title, placeholder: GENERAL_EXAMPLES.recommendations[r.exampleIndex]?.title || 'e.g. Recommendation for documentation' })}
              <button class="btn btn-danger" data-action="removeRec" data-i="${i}" aria-label="Remove recommendation" title="Remove">${icon('trash')}</button>
            </div>
            ${field({ label: 'Recommendation', bind: `general:recommendations.${i}.text`, type: 'textarea', value: r.text, placeholder: GENERAL_EXAMPLES.recommendations[r.exampleIndex]?.text || 'Describe what staff should do differently.' })}
          </div>`).join('')}
        <div class="Box-body">
          ${field({ label: 'Closing line', bind: 'general:closing', value: g.closing, placeholder: GENERAL_EXAMPLES.closing, hint: 'Printed in bold at the end of the page when you enter your own text.' })}
        </div>
      </div>
      <div class="NavBar">
        <a class="btn" href="${href('a', audit.id)}">${icon('chevron-left')}Individuals</a>
        <div class="NavBar-end"><a class="btn btn-primary" href="${href('a', audit.id, 'pdf')}">Create PDF${icon('chevron-right')}</a></div>
      </div>`);
}

function viewPdf(audit) {
  binds = {};
  const warnings = [];
  if (!audit.auditor.trim()) warnings.push(['Add your name so the header reads “Audit By …”.', href('a', audit.id, 'setup')]);
  for (const name of sortNames(audit.site.residents)) {
    const entries = audit.individuals[name]?.entries || [];
    if (!entries.length) warnings.push([`${name} has no documentation reviewed.`, href('a', audit.id, 'i', name)]);
    else if (entries.some((e) => !entryComplete(e))) warnings.push([`${name} has an unfinished shift.`, href('a', audit.id, 'i', name)]);
  }
  queueMicrotask(() => renderPdfPreview(audit));
  return auditTabView(audit, 'pdf', `${audit.site.name} · PDF`, `
      ${warnings.length ? `<div class="flash flash-warn">${icon('alert')}<ul>${warnings.map(([t, l]) => `<li><a href="${l}">${esc(t)}</a></li>`).join('')}</ul></div>` : ''}
      <div class="Box">
        <div class="Box-header">
          <h2 class="Box-title">${icon('file')} ${esc(pdfFileName(audit))}</h2>
          <div class="Box-headerActions">
            <button class="btn btn-sm" data-action="openPdf">${icon('link-external')}Open</button>
            <button class="btn btn-sm" data-action="printPdf">Print</button>
            <button class="btn btn-sm btn-primary" data-action="downloadPdf">${icon('download')}Download</button>
          </div>
        </div>
        <div class="PdfFrame" id="pdf-frame"><div class="blankslate"><span class="blankslate-icon">${icon('sync', 24)}</span><p>Building your PDF…</p></div></div>
      </div>`);
}

async function renderPdfPreview(audit) {
  const state = ui;
  const profile = session.profile;
  const frame = document.getElementById('pdf-frame');
  if (!frame) return;
  try {
    const doc = await buildPdf(audit);
    if (state !== ui || profile !== session.profile || frame !== document.getElementById('pdf-frame') || currentAudit()?.id !== audit.id) return;
    if (ui.pdfUrl) URL.revokeObjectURL(ui.pdfUrl);
    ui.pdfUrl = URL.createObjectURL(doc.output('blob'));
    frame.innerHTML = `<iframe src="${ui.pdfUrl}#view=FitH" title="Audit PDF preview"></iframe>`;
  } catch (err) {
    if (state !== ui || profile !== session.profile) return;
    console.error(err);
    frame.innerHTML = `<div class="flash flash-error m-3">${icon('alert')}<span>The PDF couldn’t be built: ${esc(err.message)}</span></div>`;
  }
}

function viewMissing() {
  binds = {};
  return {
    title: 'Not found',
    html: `<div class="Box"><div class="blankslate">
        <span class="blankslate-icon">${icon('alert', 24)}</span>
        <h2 class="blankslate-heading">That page wasn’t found</h2>
        <a class="btn blankslate-action" href="#/">Back to all audits</a>
      </div></div>`,
  };
}

// ---------- sign-in ----------

function viewNotConfigured() {
  binds = {};
  return {
    title: 'Setup needed',
    html: `<div class="LoginWrap"><div class="Box LoginCard"><div class="blankslate">
        <span class="blankslate-icon">${icon('alert', 24)}</span>
        <h1 class="blankslate-heading">This site isn’t connected yet</h1>
        <p>Add your Supabase project settings to <code>js/supabase-config.js</code>. See SETUP.md.</p>
      </div></div></div>`,
  };
}

function viewLogin() {
  const l = ui.login;
  binds = { login: l };
  return {
    title: 'Sign in',
    html: `<div class="LoginWrap">
        <span class="LoginCard-logo">${logoSvg('login')}</span>
        <div class="Box LoginCard">
          <div class="LoginCard-head">
            <h1 class="LoginCard-title">Sign in</h1>
            <p class="LoginCard-subtitle">Internal DSP Audit Builder</p>
          </div>
          <form class="Box-body LoginCard-form" data-action="login" novalidate>
            ${field({ label: 'Username', bind: 'login:username', value: l.username, attrs: `autocomplete="username" autocapitalize="none" spellcheck="false" ${l.busy ? 'disabled' : ''} autofocus` })}
            ${field({ label: 'Password', bind: 'login:password', type: 'password', value: l.password, attrs: `autocomplete="current-password" ${l.busy ? 'disabled' : ''}` })}
            ${l.error ? `<div class="flash flash-error" role="alert">${icon('alert')}<span>${esc(l.error)}</span></div>` : ''}
            <button class="btn btn-primary btn-block" type="submit" ${l.busy ? 'disabled' : ''}>${l.busy ? `${icon('sync')}Signing in…` : 'Sign in'}</button>
          </form>
          <div class="Box-footer LoginCard-foot">${icon('shield-lock')}<span>Accounts are created by your administrator.</span></div>
        </div>
      </div>`,
  };
}

const USER_MENU = document.getElementById('user-menu');

function renderUserMenu() {
  const p = session.profile;
  if (!p) {
    USER_MENU.innerHTML = '';
    return;
  }
  USER_MENU.innerHTML = `<details class="details-reset details-overlay ThemeMenu" id="user-details">
      <summary class="UserMenu-button" aria-haspopup="menu" aria-label="Account menu for ${esc(p.username)}">
        <span class="InitialsAvatar UserMenu-avatar">${esc(initials(p.display_name || p.username))}</span>
      </summary>
      <div class="SelectMenu right-0">
        <div class="SelectMenu-modal ThemeMenu-modal">
          <div class="SelectMenu-header UserMenu-head">
            <span class="SelectMenu-title">${esc(p.display_name || p.username)}</span>
            <span class="f6 color-fg-muted">${esc(p.username)}${p.is_admin ? ' · Admin' : ''}</span>
          </div>
          <div class="SelectMenu-list" role="menu">
            ${p.is_admin ? `<a class="SelectMenu-item" role="menuitem" href="#/admin">${icon('shield-lock')}<span>Admin dashboard</span></a>` : ''}
            <button class="SelectMenu-item" role="menuitem" data-signout>${icon('arrow-left')}<span>Sign out</span></button>
          </div>
        </div>
      </div>
    </details>`;
}

USER_MENU.addEventListener('click', async (ev) => {
  if (ev.target.closest('[data-signout]')) {
    ev.preventDefault();
    endSession(); // Hide cached private data before any sign-out network request.
    await api.signOut();
  } else if (ev.target.closest('a.SelectMenu-item')) {
    document.getElementById('user-details')?.removeAttribute('open');
  }
});

// ---------- admin dashboard ----------

function viewAdmin(section, id) {
  const ad = ui.admin;
  binds = {};
  if (section === 'home') return viewAdminHome(id);
  ad.tab = section === 'users' ? 'users' : 'homes';
  if (ad.tab === 'users' && ad.users === null && !ad.busy) loadUsers();
  const homes = allSites();
  const tabs = [
    ['homes', 'Homes', 'home', '#/admin', homes.length],
    ['users', 'Users', 'people', '#/admin/users', ad.users ? ad.users.length : null],
  ];
  const body = ad.tab === 'users' ? adminUsersBody() : adminHomesBody(homes);
  return {
    title: 'Admin dashboard',
    html: `
      ${breadcrumbs([['Audits', '#/'], ['Admin dashboard']])}
      <div class="PageHeader" style="view-transition-name: page-heading">
        <div>
          <h1 class="PageHeader-title">Admin dashboard</h1>
          <p class="PageHeader-description">Manage the homes, individuals and user accounts everyone signs in to. Changes apply to all users right away.</p>
        </div>
      </div>
      <nav class="UnderlineNav" aria-label="Admin sections">${tabs
        .map(([key, label, ic, link, count]) => `<a class="UnderlineNav-item" href="${link}" ${key === ad.tab ? 'aria-current="page"' : ''}>
            ${icon(ic)}<span>${label}</span>${count != null ? `<span class="Counter">${count}</span>` : ''}</a>`)
        .join('')}</nav>
      ${adminFlash()}
      ${body}`,
  };
}

function adminFlash() {
  const ad = ui.admin;
  if (ad.error) return `<div class="flash flash-error" role="alert">${icon('alert')}<span>${esc(ad.error)}</span></div>`;
  if (ad.notice) return `<div class="flash flash-success" role="status">${icon('check-circle')}<span>${esc(ad.notice)}</span></div>`;
  return '';
}

function adminHomesBody(homes) {
  if (ui.homes === null) {
    refreshHomes().then(() => parseRoute()[0] === 'admin' && render());
    return `<div class="Box"><div class="blankslate"><span class="blankslate-icon">${icon('sync', 24)}</span><p>Loading homes…</p></div></div>`;
  }
  const rows = homes
    .map((h) => `<a class="Box-row Box-row--link" href="${href('admin', 'home', h.id)}">
        <span class="AuditRow-icon">${icon('home')}</span>
        <span class="PersonRow-main">
          <span class="PersonRow-name d-block">${esc(h.name)}</span>
          <span class="PersonRow-meta">${esc(h.address || 'No address')}${h.manager ? ` · ${esc(h.managerTitle)}: ${esc(h.manager)}` : ''}</span>
        </span>
        <span class="Label">${icon('people')}${plural(h.residents.length, 'individual')}</span>
        <span class="PersonRow-chevron">${icon('chevron-right')}</span>
      </a>`)
    .join('');
  return `<div class="Box">
      <div class="Box-header">
        <h2 class="Box-title">Homes</h2>
        <div class="Box-headerActions">
          <label class="btn btn-sm btn-file" title="Add homes from an AGHS homes.json file">${icon('upload')}Import file
            <input type="file" accept="application/json,.json" data-action="adminImportHomes">
          </label>
          <a class="btn btn-sm btn-primary" href="${href('admin', 'home', 'new')}">${icon('plus')}Add home</a>
        </div>
      </div>
      ${rows || `<div class="blankslate blankslate--narrow"><p>No homes yet. Add one, or import your AGHS homes.json.</p></div>`}
    </div>`;
}

function viewAdminHome(id) {
  const ad = ui.admin;
  if (ui.homes === null) {
    refreshHomes().then(() => parseRoute()[0] === 'admin' && render());
    return { title: 'Home', html: `<div class="Box"><div class="blankslate"><p>Loading…</p></div></div>` };
  }
  const isNew = id === 'new';
  const home = isNew ? null : allSites().find((h) => h.id === id);
  if (!isNew && !home) return viewMissing();
  if (ad.draftFor !== id) {
    ad.draftFor = id;
    ad.draft = {
      name: home?.name || '', address: home?.address || '', phone: home?.phone || '',
      managerTitle: home?.managerTitle || 'Lead', manager: home?.manager || '',
      cell: home?.cell || '', email: home?.email || '', supervisor: home?.supervisor || '',
    };
  }
  binds = { draft: ad.draft };
  const d = ad.draft;
  const residents = home?.residentRows || [];
  return {
    title: isNew ? 'Add home' : home.name,
    html: `
      ${breadcrumbs([['Audits', '#/'], ['Admin dashboard', '#/admin'], [isNew ? 'Add home' : home.name]])}
      <div class="PageHeader" style="view-transition-name: page-heading">
        <div class="PageHeader-lead">
          <span class="UnlockHero-icon AdminHomeIcon">${icon('home', 20)}</span>
          <div>
            <h1 class="PageHeader-title">${isNew ? 'Add a home' : esc(home.name)}</h1>
            <p class="PageHeader-description">${isNew ? 'Save the home first, then add its individuals.' : 'Changes are shared with every signed-in user.'}</p>
          </div>
        </div>
      </div>
      ${adminFlash()}
      <div class="Box">
        <div class="Box-header"><h2 class="Box-title">Home details</h2></div>
        <div class="Box-body">
          <div class="FormGrid">
            ${field({ label: 'Home name', bind: 'draft:name', value: d.name, placeholder: 'e.g. Example Home', attrs: isNew ? 'autofocus' : '' })}
            ${field({ label: 'Phone', bind: 'draft:phone', value: d.phone, type: 'tel' })}
            ${field({ label: 'Address', bind: 'draft:address', value: d.address, placeholder: 'Street, City ST 00000', wide: true })}
            <div class="FormField">
              <label class="FormField-label" for="f-draft-managerTitle">Title</label>
              <select class="form-select" id="f-draft-managerTitle" data-bind="draft:managerTitle">
                ${['Lead', 'Manager'].map((t) => `<option ${d.managerTitle === t ? 'selected' : ''}>${t}</option>`).join('')}
              </select>
            </div>
            ${field({ label: 'Lead / Manager name', bind: 'draft:manager', value: d.manager })}
            ${field({ label: 'Cell phone', bind: 'draft:cell', value: d.cell, type: 'tel' })}
            ${field({ label: 'Email', bind: 'draft:email', value: d.email, type: 'email' })}
            ${field({ label: 'Supervisor', bind: 'draft:supervisor', value: d.supervisor })}
          </div>
        </div>
        <div class="Box-footer">
          ${isNew ? '' : `<button class="btn btn-danger" data-action="adminDeleteHome" data-id="${esc(id)}">${icon('trash')}Delete home</button>`}
          <div class="NavBar-end"><button class="btn btn-primary" data-action="adminSaveHome" data-id="${esc(id)}" ${ad.busy ? 'disabled' : ''}>${icon('check')}${isNew ? 'Create home' : 'Save changes'}</button></div>
        </div>
      </div>
      ${isNew ? '' : `<div class="Box">
        <div class="Box-header"><h2 class="Box-title">Individuals</h2><span class="Counter">${residents.length}</span></div>
        ${residents.map((r) => `<div class="Box-row">
            <span class="InitialsAvatar">${esc(initials(r.name))}</span>
            <form class="InlineAdd ResidentEdit" data-action="adminRenameResident" data-id="${esc(r.id)}">
              <input class="form-control" type="text" name="name" value="${esc(r.name)}" aria-label="Name of ${esc(r.name)}">
              <button class="btn btn-sm" type="submit">Rename</button>
            </form>
            <button class="btn-octicon btn-octicon-danger" data-action="adminRemoveResident" data-id="${esc(r.id)}" data-name="${esc(r.name)}" aria-label="Remove ${esc(r.name)}" title="Remove">${icon('trash')}</button>
          </div>`).join('') || '<div class="blankslate blankslate--narrow"><p>No individuals yet.</p></div>'}
        <div class="Box-footer">
          <form class="InlineAdd" data-action="adminAddResident" data-id="${esc(id)}">
            <input class="form-control" type="text" name="name" placeholder="Full name" aria-label="New individual’s name">
            <button class="btn" type="submit">${icon('plus')}Add individual</button>
          </form>
        </div>
      </div>`}
      <div class="NavBar"><a class="btn" href="#/admin">${icon('chevron-left')}All homes</a></div>`,
  };
}

async function loadUsers() {
  const ad = ui.admin;
  ad.busy = true;
  try {
    ad.users = await api.listUsers();
  } catch (err) {
    ad.error = err.message;
    ad.users = [];
  }
  ad.busy = false;
  if (parseRoute()[0] === 'admin') render();
}

function adminUsersBody() {
  const ad = ui.admin;
  if (ad.users === null) return `<div class="Box"><div class="blankslate"><span class="blankslate-icon">${icon('sync', 24)}</span><p>Loading users…</p></div></div>`;
  binds = { newUser: ad.newUser, reset: ad };
  const me = session.profile.id;
  const rows = ad.users
    .map((u) => {
      const self = u.id === me;
      return `<div class="Box-row UserRow">
          <span class="InitialsAvatar">${esc(initials(u.display_name || u.username))}</span>
          <div class="PersonRow-main">
            <span class="PersonRow-name">${esc(u.username)}</span>
            ${u.display_name ? `<span class="PersonRow-meta"> · ${esc(u.display_name)}</span>` : ''}
            <div class="UserRow-labels">
              ${u.is_admin ? `<span class="Label Label--accent">${icon('shield-lock')}Admin</span>` : '<span class="Label">User</span>'}
              ${u.active ? '' : '<span class="Label Label--danger">Disabled</span>'}
              ${self ? '<span class="Label Label--success">You</span>' : ''}
            </div>
            ${ad.resetFor === u.id ? `<form class="InlineAdd mt-2" data-action="adminSetPassword" data-id="${esc(u.id)}">
                <input class="form-control" type="password" data-bind="reset:resetPassword" value="${esc(ad.resetPassword)}" placeholder="New password" autocomplete="new-password" aria-label="New password for ${esc(u.username)}" autofocus>
                <button class="btn btn-sm btn-primary" type="submit">Set password</button>
                <button class="btn btn-sm" type="button" data-action="adminCancelReset">Cancel</button>
              </form>` : ''}
          </div>
          <div class="UserRow-actions">
            <button class="btn btn-sm" data-action="adminResetPassword" data-id="${esc(u.id)}">${icon('key')}Password</button>
            ${self ? '' : `
              <button class="btn btn-sm" data-action="adminToggleAdmin" data-id="${esc(u.id)}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button>
              <button class="btn btn-sm" data-action="adminToggleActive" data-id="${esc(u.id)}">${u.active ? 'Disable' : 'Enable'}</button>
              <button class="btn-octicon btn-octicon-danger" data-action="adminDeleteUser" data-id="${esc(u.id)}" aria-label="Delete ${esc(u.username)}" title="Delete user">${icon('trash')}</button>`}
          </div>
        </div>`;
    })
    .join('');
  const n = ad.newUser;
  const form = n
    ? `<div class="Box">
        <div class="Box-header"><h2 class="Box-title">Add a user</h2></div>
        <div class="Box-body">
          <div class="FormGrid">
            ${field({ label: 'Username', bind: 'newUser:username', value: n.username, hint: '3–32 letters, numbers, dots, dashes or underscores. Not case-sensitive.', attrs: 'autocomplete="off" autocapitalize="none" spellcheck="false" autofocus' })}
            ${field({ label: 'Full name', bind: 'newUser:displayName', value: n.displayName, hint: 'Fills “Audit by” on their audits.' })}
            ${field({ label: 'Password', bind: 'newUser:password', type: 'password', value: n.password, hint: 'At least 6 characters. Share it with them privately.', attrs: 'autocomplete="new-password"' })}
            <div class="FormField">
              <span class="FormField-label">Permissions</span>
              <label class="CheckRow">
                <input type="checkbox" data-bind="newUser:isAdmin" ${n.isAdmin ? 'checked' : ''}>
                <span class="CheckRow-text"><span class="CheckRow-label">Admin</span><span class="CheckRow-caption">Can manage homes, individuals and users.</span></span>
              </label>
            </div>
          </div>
        </div>
        <div class="Box-footer Box-footer--end">
          <button class="btn" data-action="adminCancelUser">Cancel</button>
          <button class="btn btn-primary" data-action="adminCreateUser" ${ad.busy ? 'disabled' : ''}>${icon('plus')}Create user</button>
        </div>
      </div>`
    : '';
  return `${form}
    <div class="Box">
      <div class="Box-header">
        <h2 class="Box-title">Users</h2>
        <div class="Box-headerActions">${n ? '' : `<button class="btn btn-sm btn-primary" data-action="adminAddUser">${icon('plus')}Add user</button>`}</div>
      </div>
      ${rows}
    </div>`;
}

// ---------- router ----------

function parseRoute() {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

function resolve() {
  // The sign-in gate: nothing else renders until someone is signed in with an active account.
  if (!api.configured) return viewNotConfigured();
  if (!session.checked) return { title: 'Loading', html: '' };
  if (!session.profile) return viewLogin();

  const [a, id, kind, name, e, entryId, step] = parseRoute();
  if (!a) return viewHome();
  if (a === 'admin') return isAdmin() ? viewAdmin(id, kind) : viewMissing();
  if (a === 'new') return viewNew();
  const audit = a === 'a' && findAudit(id);
  if (!audit) return viewMissing();
  if (auditWatcher && (ui.homes === null || (needsReservation(audit) && !auditWatcher.owns(audit.siteId, audit.id)))) {
    const activity = auditWatcher.snapshot();
    const checking = ui.homes === null || activity.status === 'checking';
    return { title: audit.site.name, html: `${breadcrumbs([['Audits', '#/'], [audit.site.name]])}
      <div class="flash flash-warn" role="status">${icon('alert-circle')}<span>${checking ? 'Checking site availability…' : activity.status === 'blocked' ? SITE_BUSY_MESSAGE : 'Couldn’t verify site availability. Please try again.'}</span></div>
      <div class="NavBar"><a class="btn" href="#/new">Choose a home</a>${checking ? '' : '<button class="btn btn-primary" data-action="retryActivity">Retry</button>'}</div>` };
  }
  if (!kind) return viewHub(audit);
  if (kind === 'setup') return viewSetup(audit);
  if (kind === 'general') return viewGeneral(audit);
  if (kind === 'pdf') return viewPdf(audit);
  if (kind === 'i' && name) {
    if (!audit.site.residents.includes(name)) return viewMissing();
    if (e === 'e') {
      const entry = individual(audit, name).entries.find((x) => x.id === entryId);
      if (entry) return viewEntry(audit, name, entry, ENTRY_STEPS.some((s) => s[0] === step) ? step : 'details');
    }
    return viewIndividual(audit, name);
  }
  return viewMissing();
}

function motionRoute() {
  if (!session.checked) return { area: 'loading', depth: -2, order: 0 };
  if (!session.profile) return { area: 'auth', depth: -1, order: 0 };
  const [area, id, kind, name, entryKind, entryId, step] = parseRoute();
  if (!area) return { area: 'home', depth: 0, order: 0 };
  if (area === 'new') return { area: 'new', depth: 1, order: 0 };
  if (area === 'admin') {
    if (id === 'home') return { area: `admin-home:${kind || 'new'}`, depth: 2, order: 0 };
    return { area: 'admin-tabs', scope: 'admin-tabs', depth: 1, order: id === 'users' ? 1 : 0 };
  }
  if (area !== 'a') return { area: 'other', depth: 1, order: 0 };

  const auditScope = `audit:${id}`;
  if (!kind || ['setup', 'general', 'pdf'].includes(kind)) {
    const order = kind === 'setup' ? 0 : !kind ? 1 : kind === 'general' ? 2 : 3;
    return { area: `${auditScope}:tab`, scope: `${auditScope}:tabs`, depth: 2, order };
  }
  if (kind === 'i' && entryKind === 'e') {
    const order = Math.max(0, ENTRY_STEPS.findIndex(([key]) => key === step));
    return { area: `${auditScope}:entry:${entryId}`, scope: `${auditScope}:entry:${entryId}`, depth: 4, order };
  }
  if (kind === 'i') return { area: `${auditScope}:person:${name}`, depth: 3, order: 0 };
  return { area: auditScope, depth: 2, order: 0 };
}

function motionDirection(previous, next) {
  if (!previous || previous.area === 'loading') return 'none';
  if (previous.area === 'auth' || next.area === 'auth') return 'fade';
  if (previous.scope && previous.scope === next.scope && previous.order !== next.order) {
    return next.order > previous.order ? 'forward' : 'back';
  }
  if (next.depth !== previous.depth) return next.depth > previous.depth ? 'forward' : 'back';
  if (next.area === 'home') return 'back';
  if (previous.area === 'home') return 'forward';
  return 'replace';
}

function updateProgressMarkup(markup, preserve) {
  const current = app.querySelector(':scope > .ProgressDisclosure, :scope > .ProgressNotice');
  if (preserve && current?.classList.contains('ProgressDisclosure') && markup.includes('ProgressDisclosure')) {
    current.classList.toggle('is-open', ui.progressOpen);
    current.querySelector('[data-action="toggleProgress"]')?.setAttribute('aria-expanded', String(ui.progressOpen));
    const details = current.querySelector('#progress-details');
    details?.setAttribute('aria-hidden', String(!ui.progressOpen));
    if (details) details.toggleAttribute('inert', !ui.progressOpen);
    return;
  }
  if (!markup) {
    current?.remove();
    return;
  }
  if (current) current.outerHTML = markup;
  else app.insertAdjacentHTML('afterbegin', markup);
}

function syncAuditShell(page, view) {
  page.querySelectorAll('[data-audit-tab]').forEach((link) => {
    if (link.dataset.auditTab === view.shellTab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  // Values in the shared header can change while editing Details. Patch only
  // those small text regions; the shell itself remains mounted.
  const template = document.createElement('template');
  template.innerHTML = view.shellHtml;
  ['[data-audit-summary]', '[data-audit-stats]'].forEach((selector) => {
    const current = page.querySelector(selector);
    const next = template.content.querySelector(selector);
    if (current && next && current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
  });
  const currentCrumb = page.querySelector('.AuditBreadcrumbs [aria-current="page"]');
  const nextCrumb = template.content.querySelector('.AuditBreadcrumbs [aria-current="page"]');
  if (currentCrumb && nextCrumb && currentCrumb.textContent !== nextCrumb.textContent) {
    currentCrumb.textContent = nextCrumb.textContent;
  }
}

function renderContents(routeChanged) {
  if (routeChanged) {
    ui.error = '';
    ui.completeMsg = null;
    ui.progressOpen = false;
  }
  const scroll = window.scrollY;
  const view = resolve();
  const progress = session.profile ? progressDisclosure() : '';
  const pageClass = session.profile
    ? `PageView${view.shellKey ? ' PageView--audit' : ''}`
    : 'PageView PageView--auth';
  const currentPage = app.querySelector(':scope > .PageView');
  const sameAuditShell = Boolean(view.shellKey && currentPage?.dataset.shellKey === view.shellKey);

  // The compact progress strip is global UI. Keep the same element mounted while
  // navigating so it does not blink or restart its animation on every route.
  updateProgressMarkup(progress, routeChanged && Boolean(session.profile));

  if (sameAuditShell) {
    const outlet = currentPage.querySelector(':scope > .RouteOutlet');
    if (outlet) outlet.innerHTML = view.html;
    syncAuditShell(currentPage, view);
  } else {
    const shellAttribute = view.shellKey ? ` data-shell-key="${esc(view.shellKey)}"` : '';
    const contents = view.shellKey
      ? `${view.shellHtml}<div class="RouteOutlet">${view.html}</div>`
      : view.html;
    const nextPage = `<div class="${pageClass}"${shellAttribute}>${contents}</div>`;
    if (currentPage) currentPage.outerHTML = nextPage;
    else app.insertAdjacentHTML('beforeend', nextPage);
  }
  document.title = `${view.title} · Internal DSP Audit Builder`;
  renderUserMenu();
  if (routeChanged) {
    window.scrollTo(0, 0);
    lastHash = location.hash;
    const auto = app.querySelector('[autofocus]');
    (auto || app).focus({ preventScroll: true });
  } else {
    window.scrollTo(0, scroll);
  }
}

function render() {
  syncAuditWatcher();
  const routeChanged = location.hash !== lastHash;
  const viewKey = !session.checked ? 'loading' : session.profile ? `app:${location.hash || '#/'}` : 'login';
  const viewChanged = lastViewKey !== null && lastViewKey !== 'loading' && viewKey !== lastViewKey;
  const nextMotionRoute = motionRoute();
  const direction = motionDirection(lastMotionRoute, nextMotionRoute);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [routeArea, routeAuditId, routeKind] = parseRoute();
  const hasAuditShell = !routeKind || ['setup', 'general', 'pdf'].includes(routeKind);
  const sameShell = hasAuditShell && routeArea === 'a' && app.querySelector(':scope > .PageView')?.dataset.shellKey === `audit:${routeAuditId}`;
  document.documentElement.dataset.transitionScope = sameShell ? 'outlet' : 'page';
  const revision = ++renderRevision;
  const update = () => {
    // A view-transition callback can run after a newer navigation or refresh.
    // Only the latest render may commit its route and focus state.
    if (revision !== renderRevision) return;
    renderContents(routeChanged);
    lastViewKey = viewKey;
    lastMotionRoute = nextMotionRoute;
  };

  if (viewChanged && !reduceMotion && document.startViewTransition) {
    pageTransition?.skipTransition?.();
    clearTimeout(routeAnimationTimer);
    app.querySelector('.is-route-entering')?.classList.remove('is-route-entering');
    document.documentElement.dataset.transitionDirection = direction;
    const transition = document.startViewTransition(update);
    pageTransition = transition;
    const clearTransition = () => {
      if (pageTransition === transition) pageTransition = null;
    };
    transition.finished.then(clearTransition, clearTransition);
    return;
  }

  // Data refreshes and reduced-motion changes must not leave a stale snapshot
  // covering the live controls. This also cancels a pending older callback.
  pageTransition?.skipTransition?.();
  pageTransition = null;
  update();
  if (viewChanged && !reduceMotion) {
    document.documentElement.dataset.transitionDirection = direction;
    const page = app.querySelector('.PageView');
    const transitionTarget = sameShell ? page?.querySelector(':scope > .RouteOutlet') : page;
    transitionTarget?.classList.remove('is-route-entering');
    // Restart the fallback animation when the View Transitions API is unavailable.
    if (transitionTarget) void transitionTarget.offsetWidth;
    transitionTarget?.classList.add('is-route-entering');
    clearTimeout(routeAnimationTimer);
    routeAnimationTimer = setTimeout(() => transitionTarget?.classList.remove('is-route-entering'), 400);
  }
}

function currentAudit() {
  const [a, id] = parseRoute();
  return a === 'a' ? findAudit(id) : null;
}

function auditHasWork(audit) {
  if (!audit || audit.completionId || audit.completedAt) return Boolean(audit);
  const individualWork = Object.values(audit.individuals || {}).some((person) =>
    Boolean(person?.adequate || person?.notes?.trim() || person?.entries?.length));
  const general = audit.general || {};
  const generalWork = Boolean(
    general.notes?.trim() || general.closing?.trim() || Array.isArray(general.repeatStaff)
    || (general.recommendations || []).some((item) => item.title?.trim() || item.text?.trim())
  );
  return individualWork || generalWork;
}

function auditFromHash(hash) {
  const [area, id] = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return area === 'a' ? findAudit(id) : null;
}

function discardEmptyAudit(audit) {
  const previous = db.audits;
  db.audits = db.audits.filter((item) => item.id !== audit.id);
  if (!save(db, session.profile.id)) {
    db.audits = previous;
    alert('The empty audit couldn’t be deleted from this browser. Please try again.');
    return false;
  }
  auditWatcher?.close();
  return true;
}

function confirmDiscardEmptyAudit(audit) {
  if (!audit || auditHasWork(audit)) return true;
  if (!confirm(`Leave the ${audit.site.name} audit? No shifts or individual results have been added, so this empty audit will be deleted.`)) return false;
  return discardEmptyAudit(audit);
}

function handleHashChange() {
  const goingHome = !location.hash || location.hash === '#/' || location.hash === '#';
  const previousAudit = auditFromHash(lastHash);
  if (goingHome && previousAudit && !auditHasWork(previousAudit)) {
    if (!confirmDiscardEmptyAudit(previousAudit)) {
      history.replaceState(null, '', lastHash || '#/');
      return render();
    }
  }
  render();
}

function fail(msg) {
  ui.error = msg;
  render();
  app.querySelector('.flash-error')?.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

// ---------- theme (Primer color modes) ----------

function renderFooter() {
  const link = document.getElementById('app-version');
  link.textContent = `v${APP_VERSION}`;
  link.href = GITHUB_URL || '#';
  link.title = GITHUB_URL ? 'View project on GitHub' : 'GitHub repository coming soon';
  link.setAttribute('aria-disabled', String(!GITHUB_URL));
}

document.getElementById('app-version').addEventListener('click', (ev) => {
  if (!GITHUB_URL) ev.preventDefault();
});

const THEMES = [
  ['auto', 'System', 'device-desktop'],
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon'],
];

function currentTheme() {
  return document.documentElement.getAttribute('data-color-mode') || 'auto';
}

function renderThemeMenu() {
  const mode = currentTheme();
  document.getElementById('theme-icon').innerHTML = icon(THEMES.find((t) => t[0] === mode)[2]);
  document.getElementById('theme-options').innerHTML = THEMES
    .map(([value, label, ic]) => `<button class="SelectMenu-item" role="menuitemradio" aria-checked="${value === mode}" data-theme="${value}">
        ${icon(ic)}<span>${label}</span><span class="ThemeMenu-check">${icon('check')}</span></button>`)
    .join('');
}

document.getElementById('theme-options').addEventListener('click', (ev) => {
  const item = ev.target.closest('[data-theme]');
  if (!item) return;
  const mode = item.dataset.theme;
  document.documentElement.classList.add('is-theme-transition');
  clearTimeout(themeTransitionTimer);
  document.documentElement.setAttribute('data-color-mode', mode);
  try {
    if (mode === 'auto') localStorage.removeItem('aghs-theme');
    else localStorage.setItem('aghs-theme', mode);
  } catch {
    // Theme still applies for this visit.
  }
  document.getElementById('theme-menu').removeAttribute('open');
  renderThemeMenu();
  themeTransitionTimer = setTimeout(() => document.documentElement.classList.remove('is-theme-transition'), 280);
});

document.addEventListener('keydown', (ev) => {
  const menu = document.getElementById('theme-menu');
  if (ev.key === 'Escape' && menu.open) {
    menu.removeAttribute('open');
    menu.querySelector('summary').focus();
  }
  if (ev.key === 'Escape' && ui.progressOpen) {
    ui.progressOpen = false;
    const disclosure = document.querySelector('.ProgressDisclosure');
    disclosure?.classList.remove('is-open');
    const button = disclosure?.querySelector('[data-action="toggleProgress"]');
    button?.setAttribute('aria-expanded', 'false');
    const details = disclosure?.querySelector('.ProgressDropShell');
    details?.setAttribute('aria-hidden', 'true');
    details?.setAttribute('inert', '');
    button?.focus();
  }
});

// ---------- session & admin helpers ----------

async function startSession(profile) {
  sessionGuard?.stop();
  idleSession?.stop();
  if (auditWatcher) await auditWatcher.stop();
  session = { checked: true, profile };
  tabCoordinator?.setUser(profile.id);
  db = load(profile.id);
  ui = freshUi();
  const state = ui;
  const userId = profile.id;
  const activity = activityStorage(userId);
  idleSession = createIdleSession({
    readActivity: activity.read,
    writeActivity: activity.write,
    onWarning: showSessionWarning,
    onActive: hideSessionWarning,
    onTick: renderSessionTimer,
    onExpire() {
      if (state !== ui || session.profile?.id !== userId) return;
      endSession('You were signed out after 3 minutes of inactivity.');
      api.signOut();
    },
  });
  sessionGuard = createSessionGuard({ check: api.loadProfile,
    onValid(next) {
      if (state !== ui) return;
      if (next.id !== userId) throw new Error('Account changed');
      const changed = Boolean(next.is_admin) !== Boolean(session.profile.is_admin);
      Object.assign(session.profile, next);
      if (!next.is_admin) ui.admin.users = null;
      if (changed) render();
    },
    onInvalid() {
      if (state !== ui) return;
      endSession();
      ui.login.error = 'Your session could not be verified. Please sign in again.';
      render();
    },
  });
  let previousStatus = 'idle';
  const watcher = createAuditWatcher({ api,
    onChange() {
      if (auditWatcher !== watcher) return;
      const status = watcher.snapshot().status;
      const changed = status !== previousStatus;
      previousStatus = status;
      if (parseRoute()[0] === 'new' || changed) render();
    },
    onLost() { showToast(SITE_BUSY_MESSAGE); go('new'); },
  });
  auditWatcher = watcher;
  saveStateEl.textContent = '';
  render();
  await refreshHomes();
  render();
}

function endSession(message = '') {
  sessionGuard?.stop();
  sessionGuard = null;
  idleSession?.stop();
  idleSession = null;
  hideSessionWarning();
  tabCoordinator?.setUser(null);
  clearTimeout(saveTimer);
  const previousMessage = session.profile ? '' : ui.login.error;
  if (session.profile) save(db, session.profile.id);
  const watcher = auditWatcher;
  auditWatcher = null;
  watcher?.stop();
  session = { checked: true, profile: null };
  renderSessionTimer(0);
  db = { audits: [], auditor: '' };
  if (ui.pdfUrl) URL.revokeObjectURL(ui.pdfUrl);
  ui = freshUi();
  ui.login.error = message || previousMessage;
  saveStateEl.textContent = '';
  if (location.hash && location.hash !== '#/') history.replaceState(null, '', location.pathname + location.search);
  lastHash = null;
  render();
}

function clearAdminMessages() {
  ui.admin.notice = '';
  ui.admin.error = '';
}

function adminFail(msg) {
  ui.admin.notice = '';
  ui.admin.error = msg;
  render();
  app.querySelector('.flash-error')?.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

// Runs an admin change, showing its result (or the server's error) at the top of the page.
async function adminRun(task) {
  const ad = ui.admin;
  clearAdminMessages();
  ad.busy = true;
  render();
  try {
    ad.notice = (await task()) || '';
  } catch (err) {
    ad.error = err.message;
  }
  ad.busy = false;
  render();
  app.querySelector('.flash')?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

async function boot() {
  if (window.self !== window.top) return;
  renderFooter();
  renderThemeMenu();
  window.addEventListener('hashchange', handleHashChange);
  if (!api.configured) return render();
  tabCoordinator = createTabCoordinator();
  render(); // blank until we know who's signed in
  api.onSignedOut(endSession);
  try {
    const canResume = await tabCoordinator.mayResume();
    // Only clear the shared browser token when there truly are no other tab
    // candidates. A temporarily suspended background tab must not be signed out.
    if (!canResume && !tabCoordinator.hasResumeCandidate()) await api.clearBrowserSession();
    const existing = canResume ? await api.currentSession() : null;
    if (existing) {
      const profile = await api.loadProfile();
      if (profile) {
        await startSession(profile);
        return;
      }
    }
  } catch (err) {
    ui.login.error = err.message;
  }
  session.checked = true;
  render();
}

// ---------- actions ----------

const actions = {
  async login() {
    const l = ui.login;
    if (!l.username.trim() || !l.password) {
      l.error = 'Enter your username and password.';
      return render();
    }
    l.busy = true;
    l.error = '';
    render();
    try {
      await startSession(await api.signIn(l.username, l.password));
    } catch (err) {
      Object.assign(l, { busy: false, password: '', error: err.message });
      render();
      document.getElementById('f-login-password')?.focus();
    }
  },

  // ----- admin: homes -----
  async adminSaveHome({ id }) {
    const d = ui.admin.draft;
    if (!d.name.trim()) return adminFail('Give the home a name.');
    await adminRun(async () => {
      if (id === 'new') {
        const newId = await api.createHome(d);
        await refreshHomes();
        ui.admin.draftFor = null;
        go('admin', 'home', newId);
        return `${d.name.trim()} was created. Now add its individuals.`;
      }
      await api.updateHome(id, d);
      await refreshHomes();
      return 'Home saved.';
    });
  },
  async adminDeleteHome({ id }) {
    const home = allSites().find((h) => h.id === id);
    if (!confirm(`Delete ${home.name} and all ${plural(home.residents.length, 'individual')} in it? Everyone will stop seeing it. Audits already started keep their copy.`)) return;
    await adminRun(async () => {
      await api.deleteHome(id);
      await refreshHomes();
      go('admin');
      return `${home.name} was deleted.`;
    });
  },
  async adminAddResident({ id }, form) {
    const name = form.elements.name.value.trim();
    if (!name) return;
    await adminRun(async () => {
      await api.addResident(id, name);
      await refreshHomes();
      return `${name} was added.`;
    });
  },
  async adminRenameResident({ id }, form) {
    const name = form.elements.name.value.trim();
    if (!name) return adminFail('Names can’t be empty.');
    await adminRun(async () => {
      await api.renameResident(id, name);
      await refreshHomes();
      return `Renamed to ${name}.`;
    });
  },
  async adminRemoveResident({ id, name }) {
    if (!confirm(`Remove ${name} from this home? Audits already started keep their copy.`)) return;
    await adminRun(async () => {
      await api.deleteResident(id);
      await refreshHomes();
      return `${name} was removed.`;
    });
  },
  async adminImportHomes(_, input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    let list;
    try {
      const data = JSON.parse(await file.text());
      list = (Array.isArray(data) ? data : data.sites || []).filter((s) => s && s.name);
      if (!list.length) throw new Error();
    } catch {
      return adminFail('That file isn’t a homes file. It should look like AGHS homes.json.');
    }
    await adminRun(async () => {
      const added = await api.importHomes(list, allSites().map((h) => h.name));
      await refreshHomes();
      const skipped = list.length - added;
      return `Imported ${plural(added, 'home')}${skipped ? ` (${skipped} already existed and ${skipped === 1 ? 'was' : 'were'} skipped)` : ''}.`;
    });
  },

  // ----- admin: users -----
  adminAddUser() {
    ui.admin.newUser = { username: '', displayName: '', password: '', isAdmin: false };
    clearAdminMessages();
    render();
  },
  adminCancelUser() {
    ui.admin.newUser = null;
    clearAdminMessages();
    render();
  },
  async adminCreateUser() {
    const n = ui.admin.newUser;
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(n.username.trim())) return adminFail('Usernames are 3–32 letters, numbers, dots, dashes or underscores.');
    if (n.password.length < 6) return adminFail('Passwords need at least 6 characters.');
    await adminRun(async () => {
      await api.createUser({ username: n.username.trim(), displayName: n.displayName.trim(), password: n.password, isAdmin: n.isAdmin });
      ui.admin.newUser = null;
      ui.admin.users = await api.listUsers();
      return `${n.username.trim()} can now sign in.`;
    });
  },
  adminResetPassword({ id }) {
    Object.assign(ui.admin, { resetFor: id, resetPassword: '' });
    clearAdminMessages();
    render();
  },
  adminCancelReset() {
    Object.assign(ui.admin, { resetFor: null, resetPassword: '' });
    render();
  },
  async adminSetPassword({ id }) {
    const password = ui.admin.resetPassword;
    if (password.length < 6) return adminFail('Passwords need at least 6 characters.');
    const user = ui.admin.users.find((u) => u.id === id);
    await adminRun(async () => {
      await api.updateUser(id, { password });
      Object.assign(ui.admin, { resetFor: null, resetPassword: '' });
      return `${user.username}’s password was changed.`;
    });
  },
  async adminToggleAdmin({ id }) {
    const user = ui.admin.users.find((u) => u.id === id);
    if (!confirm(user.is_admin ? `Remove admin access from ${user.username}?` : `Give ${user.username} admin access? They’ll be able to manage homes and users.`)) return;
    await adminRun(async () => {
      await api.updateUser(id, { isAdmin: !user.is_admin });
      ui.admin.users = await api.listUsers();
      return user.is_admin ? `${user.username} is no longer an admin.` : `${user.username} is now an admin.`;
    });
  },
  async adminToggleActive({ id }) {
    const user = ui.admin.users.find((u) => u.id === id);
    if (user.active && !confirm(`Disable ${user.username}? They’ll be signed out and can’t sign in until you enable them again.`)) return;
    await adminRun(async () => {
      await api.updateUser(id, { active: !user.active });
      ui.admin.users = await api.listUsers();
      return user.active ? `${user.username} was disabled.` : `${user.username} was enabled.`;
    });
  },
  async adminDeleteUser({ id }) {
    const user = ui.admin.users.find((u) => u.id === id);
    if (!confirm(`Delete ${user.username}’s account? This can’t be undone. Audits saved on their devices aren’t affected.`)) return;
    await adminRun(async () => {
      await api.deleteUser(id);
      ui.admin.users = await api.listUsers();
      return `${user.username} was deleted.`;
    });
  },

  async pickSite({ id }) {
    if (ui.pickingSite || !auditWatcher) return;
    const site = allSites().find((s) => s.id === id);
    if (!site) return;
    const occupied = auditWatcher.snapshot().list.find((r) => r.home_id === id);
    if (occupied && occupied.user_id !== session.profile.id) return showToast(SITE_BUSY_MESSAGE);
    const period = lastPayPeriod().start;
    const watcher = auditWatcher;
    const state = ui;
    const profile = session.profile;
    const origin = location.hash;
    ui.pickingSite = true;
    render();
    await loadCompletions(period);
    if (watcher !== auditWatcher || state !== ui || session.profile !== profile || location.hash !== origin) {
      if (state === ui) ui.pickingSite = false;
      return;
    }
    const completionState = ui.completions[period];
    if (completionState?.error || !completionState?.list) {
      ui.pickingSite = false;
      showToast('Couldn’t verify whether this home is complete. Please try again.');
      return render();
    }
    const completed = completionState.list.find((r) => r.home_id === id);
    if (completed) {
      ui.pickingSite = false;
      showToast(isAdmin() ? 'Undo this completed audit before starting it again.' : 'This home’s audit is already complete.');
      return render();
    }
    const existing = db.audits.find((a) => a.siteId === id && a.payStart === period && !completionOf(a));
    const audit = existing || newAudit(site, db.auditor || session.profile.display_name);
    try {
      const claimed = await watcher.open({ homeId: site.id, auditId: audit.id });
      if (watcher !== auditWatcher || state !== ui || session.profile !== profile || location.hash !== origin) {
        await watcher.close();
        return;
      }
      if (!claimed) {
        showToast(watcher.snapshot().status === 'blocked' ? SITE_BUSY_MESSAGE : 'Couldn’t check site availability. Please try again.');
        return;
      }
      if (!existing) db.audits.unshift(audit);
      if (!save(db, session.profile.id)) {
        if (!existing) db.audits = db.audits.filter((a) => a.id !== audit.id);
        await watcher.close();
        showToast('Couldn’t save this audit in this browser. Please try again.');
        return;
      }
      persist(audit);
      go('a', audit.id, 'setup');
    } finally {
      if (state === ui) {
        ui.pickingSite = false;
        render();
      }
    }
  },
  refreshActivity() {
    return auditWatcher?.refresh();
  },
  retryActivity() {
    const audit = currentAudit();
    if (audit) return auditWatcher?.open({ homeId: audit.siteId, auditId: audit.id });
  },
  dateToday() {
    currentAudit().auditDate = todayISO();
    persist(currentAudit());
    render();
  },
  setupNext() {
    const audit = currentAudit();
    if (!audit.auditor.trim()) return fail('Add your name for the “Audit By” line.');
    if (!audit.payStart || !audit.payEnd) return fail('Set the pay period start and end dates.');
    if (!audit.site.residents.length) return fail('This home has no individuals. Add them to your homes file and import it again.');
    go('a', audit.id);
  },
  addEntry() {
    const audit = currentAudit();
    const name = parseRoute()[3];
    const entry = newEntry();
    individual(audit, name).entries.push(entry);
    persist(audit);
    go('a', audit.id, 'i', name, 'e', entry.id, 'details');
  },
  deleteEntry({ id }) {
    if (!confirm('Delete this shift from the audit?')) return;
    const audit = currentAudit();
    const ind = individual(audit, parseRoute()[3]);
    ind.entries = ind.entries.filter((e) => e.id !== id);
    persist(audit);
    render();
  },
  entryNext({ step }) {
    const [, id, , name, , entryId] = parseRoute();
    const entry = binds.entry;
    if (step === 'details') {
      if (!entry.author.trim()) return fail('Enter the author of this documentation.');
      if (!entry.allShifts && !entry.date) return fail('Enter the submission date, or mark it as all shifts.');
      if (!entry.allShifts && (!entry.shiftStart || !entry.shiftEnd)) return fail('Enter the shift start and end times.');
    } else {
      const q = QUESTIONS.find((x) => x.key === step);
      const c = entry.checks[q.key];
      if (!c.answer) return fail('Choose yes or no.');
      if (isFlagged(q, c) && !c.reasons.length && !(c.otherOn && c.other.trim())) return fail('Pick at least one reason, or choose Other and describe it.');
    }
    const next = ENTRY_STEPS[ENTRY_STEPS.findIndex((s) => s[0] === step) + 1][0];
    go('a', id, 'i', name, 'e', entryId, next);
  },
  markAdequate() {
    const audit = currentAudit();
    individual(audit, parseRoute()[3]).adequate = true;
    persist(audit);
    render();
  },
  undoAdequate() {
    const audit = currentAudit();
    individual(audit, parseRoute()[3]).adequate = false;
    persist(audit);
    render();
  },
  async markAuditComplete() {
    if (ui.completing || ui.deleting) return;
    const audit = currentAudit();
    if (!allSites().some((h) => h.id === audit.siteId)) {
      ui.completeMsg = { ok: false, text: 'This audit was started before homes moved to the database, so it can’t count toward progress. Start a new audit for this home.' };
      return render();
    }
    const left = remainingIndividuals(audit);
    if (left.length && !confirm(`${left[0]} has no flagged shift and isn’t marked as having adequate documentation. Mark the audit complete anyway?`)) return;
    ui.completing = true;
    ui.completeMsg = null;
    render();
    try {
      // Save the link before publishing progress. A later storage failure must
      // never require a non-admin to delete a shared completion as a rollback.
      audit.completionId ||= crypto.randomUUID();
      if (!save(db, session.profile.id)) throw new Error('Couldn’t save this audit in this browser. Progress was not changed.');
      const rec = await api.markAuditComplete(audit.payStart, audit.siteId, audit.completionId);
      cacheCompletion(audit.payStart, rec);
      audit.completedAt = rec.completed_at;
      audit.completionId = rec.id;
      persist(audit);
      ui.completeMsg = { ok: true, text: `${audit.site.name} is marked complete. Everyone’s progress bar now includes it.` };
    } catch (err) {
      ui.completeMsg = { ok: false, text: err.message };
      loadCompletions(audit.payStart);
    }
    ui.completing = false;
    render();
  },
  refreshProgress() {
    return loadCompletions(lastPayPeriod().start);
  },
  toggleProgress(_, button) {
    const disclosure = button.closest('.ProgressDisclosure');
    if (!disclosure) return;
    ui.progressOpen = !ui.progressOpen;
    disclosure.classList.toggle('is-open', ui.progressOpen);
    button.setAttribute('aria-expanded', String(ui.progressOpen));
    const details = disclosure.querySelector('.ProgressDropShell');
    details?.setAttribute('aria-hidden', String(!ui.progressOpen));
    details?.toggleAttribute('inert', !ui.progressOpen);
  },
  async reopenHome({ id, period }) {
    if (ui.completing || ui.deleting) return;
    const record = ui.completions[period]?.list?.find((r) => r.id === id);
    if (!canReopenCompletion(record, session.profile)) return;
    const home = allSites().find((h) => h.id === record.home_id);
    if (!confirm(`Reopen the ${home?.name || 'home'} audit? It will stop counting toward this pay period’s progress until it’s marked complete again.`)) return;
    ui.completing = true;
    ui.completeMsg = null;
    render();
    try {
      await removeCompletion(record);
      ui.completeMsg = { ok: true, text: 'Audit reopened.' };
    } catch (err) {
      ui.completeMsg = { ok: false, text: err.message };
    }
    ui.completing = false;
    render();
    loadCompletions(period);
  },
  pickShiftDate({ date }) {
    binds.entry.date = date;
    ui.error = '';
    persist(currentAudit());
    render();
  },
  answer({ q, v }) {
    binds.entry.checks[q].answer = v;
    ui.error = '';
    persist(currentAudit());
    render();
  },
  toggleReason({ q, r }) {
    const c = binds.entry.checks[q];
    c.reasons = c.reasons.includes(r) ? c.reasons.filter((x) => x !== r) : [...c.reasons, r];
    ui.error = '';
    persist(currentAudit());
    render();
  },
  resetReason() {
    binds.entry.reasonOverride = null;
    persist(currentAudit());
    render();
  },
  toggleStaff({ name }) {
    const audit = currentAudit();
    const list = repeatStaff(audit);
    audit.general.repeatStaff = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
    persist(audit);
    render();
  },
  addStaff(_, form) {
    const audit = currentAudit();
    const name = form.elements.name.value.trim();
    if (!name) return;
    const list = repeatStaff(audit);
    if (!list.includes(name)) audit.general.repeatStaff = [...list, name];
    persist(audit);
    render();
  },
  addRec() {
    const audit = currentAudit();
    audit.general.recommendations.push({ title: '', text: '' });
    persist(audit);
    render();
  },
  removeRec({ i }) {
    const audit = currentAudit();
    audit.general.recommendations.splice(Number(i), 1);
    persist(audit);
    render();
  },
  async downloadPdf() {
    const audit = currentAudit();
    (await buildPdf(audit)).save(pdfFileName(audit));
  },
  async printPdf() {
    const doc = await buildPdf(currentAudit(), { autoPrint: true });
    window.open(URL.createObjectURL(doc.output('blob')), '_blank');
  },
  openPdf() {
    if (ui.pdfUrl) window.open(ui.pdfUrl, '_blank');
  },
  async deleteAudit({ id }) {
    if (ui.deleting || ui.completing) return;
    const a = findAudit(id);
    if (!a) return;
    ui.deleting = true;
    try {
      // Always verify against the server. An empty, stale or failed cache cannot
      // establish whether deleting this audit must also remove shared progress.
      const records = await api.listCompletions(a.payStart);
      const record = records.find((r) => completionMatchesAudit(r, a, session.profile.id));
      if (record && !canReopenCompletion(record, session.profile)) {
        throw new Error('Ask an admin to undo this audit’s completion before deleting it. Only admins can undo audit progress.');
      }
      if (!confirm(`Delete the ${a.site.name} audit (${payPeriod(a)})?${record ? ' It will also be removed from the pay period progress.' : ''} This can’t be undone.`)) return;
      if (record) await removeCompletion(record);
      // Remove stale local completion markers too, if it was already reopened elsewhere.
      delete a.completedAt;
      delete a.completionId;
      const previous = db.audits;
      db.audits = db.audits.filter((x) => x.id !== id);
      // Commit deletion immediately, so closing the tab cannot resurrect the audit.
      if (!save(db, session.profile.id)) {
        db.audits = previous;
        throw new Error('Couldn’t save the deletion in this browser.');
      }
      persist();
      await loadCompletions(a.payStart);
    } catch (err) {
      alert(`The audit wasn’t deleted. Please try again.\n\n${err.message}`);
    } finally {
      ui.deleting = false;
      render();
    }
  },
  exportAudit({ id }) {
    const a = findAudit(id);
    download(new Blob([JSON.stringify(a, null, 2)], { type: 'application/json' }), pdfFileName(a).replace(/\.pdf$/, ' backup.json'));
  },
};

// ---------- events ----------

document.addEventListener('click', (ev) => {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const link = ev.target.closest('a[href]');
  if (!link || !['#/', '#'].includes(link.getAttribute('href'))) return;
  const audit = currentAudit();
  if (!audit || auditHasWork(audit)) return;
  ev.preventDefault();
  if (confirmDiscardEmptyAudit(audit)) go();
}, true);

app.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM' || el.type === 'file' || el.type === 'checkbox') return;
  ev.preventDefault();
  const state = ui;
  if (sessionGuard && !await sessionGuard.verify()) return;
  if (state !== ui || !Object.hasOwn(actions, el.dataset.action)) return;
  if (!['retryActivity', 'refreshActivity', 'toggleProgress'].includes(el.dataset.action) && auditEditingBlocked()) return;
  actions[el.dataset.action]?.(el.dataset, el);
});

let lastActivitySignal = 0;
function noteSessionActivity() {
  if (!idleSession || Date.now() - lastActivitySignal < 1000) return;
  lastActivitySignal = Date.now();
  idleSession.activity();
}

for (const eventName of ['pointerdown', 'pointermove', 'keydown', 'input', 'scroll', 'touchstart']) {
  window.addEventListener(eventName, noteSessionActivity, { passive: true });
}

document.getElementById('session-toast').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-stay-signed-in]')) noteSessionActivity();
});

window.addEventListener('storage', (ev) => {
  if (ev.key?.startsWith('aghs-session-activity:v1:')) idleSession?.check();
});

window.addEventListener('beforeunload', (ev) => {
  if (!session.profile || !tabCoordinator?.isLastTab() || !needsReservation(currentAudit())) return;
  ev.preventDefault();
  ev.returnValue = 'Are you sure you want to close this tab? You’re still auditing a site.';
});

window.addEventListener('pagehide', () => {
  tabCoordinator?.close();
  auditWatcher?.stop();
});
window.addEventListener('pageshow', (ev) => {
  // A page restored from the back/forward cache needs a fresh watcher and claim.
  if (ev.persisted && session.profile) {
    tabCoordinator?.reopen();
    startSession(session.profile);
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    idleSession?.check();
    sessionGuard?.verify(true);
    auditWatcher?.refresh();
  }
});
window.addEventListener('focus', () => {
  idleSession?.check();
  sessionGuard?.verify(true);
});

app.addEventListener('change', async (ev) => {
  const el = ev.target;
  const state = ui;
  if (el.dataset.action && sessionGuard && !await sessionGuard.verify()) return;
  if (state !== ui || (el.dataset.action && !Object.hasOwn(actions, el.dataset.action))) return;
  if (el.dataset.action && auditEditingBlocked()) return;
  if (el.dataset.action && (el.type === 'checkbox' || el.type === 'file')) actions[el.dataset.action]?.(el.dataset, el);
});

app.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-action]');
  if (!form) return;
  ev.preventDefault();
  const state = ui;
  if (sessionGuard && !await sessionGuard.verify()) return;
  if (state !== ui || !Object.hasOwn(actions, form.dataset.action)) return;
  if (auditEditingBlocked()) return;
  actions[form.dataset.action]?.(form.dataset, form);
});

// Time boxes start blank when clicked, so you never type around leftover text. Leaving without
// typing puts the previous time back; otherwise what you typed is read and tidied ("730p" → "07:30 PM").
app.addEventListener('focusin', (ev) => {
  const el = ev.target.closest('[data-time]');
  if (!el) return;
  el.dataset.previous = el.value;
  el.value = '';
});

app.addEventListener('focusout', (ev) => {
  const el = ev.target.closest('[data-time]');
  if (!el) return;
  if (auditEditingBlocked()) return;
  if (!el.value.trim()) {
    el.value = el.dataset.previous || '';
    return;
  }
  const [root, path] = el.dataset.time.split(':');
  const caption = document.getElementById(`${el.id}-caption`);
  const time = parseTime(el.value);
  if (time === null) {
    el.setAttribute('aria-invalid', 'true');
    caption.textContent = 'That isn’t a time. Try 7a, 7 pm or 15:00.';
    caption.classList.add('is-error');
    return;
  }
  if (!setPath(binds[root], path, time)) return;
  el.value = fmtTime(time);
  el.removeAttribute('aria-invalid');
  caption.textContent = TIME_HINT;
  caption.classList.remove('is-error');
  if (ui.error) {
    ui.error = '';
    app.querySelector('.flash-error')?.remove();
  }
  persist(currentAudit());
});

// 'change' too: some mobile date/time pickers only fire change.
const onBind = (ev) => {
  const el = ev.target.closest('[data-bind]');
  if (!el) return;
  if (ev.type === 'change' && (el.type === 'checkbox' || el.tagName === 'TEXTAREA' || el.type === 'text')) return;
  const [root, path] = el.dataset.bind.split(':');
  const target = binds[root];
  if (!target) return;
  if (!['login', 'draft', 'newUser', 'reset'].includes(root) && auditEditingBlocked()) return;
  const audit = currentAudit();
  const status = audit && ui.completions[audit.payStart];
  if (root === 'audit' && path === 'payStart' && (completionOf(audit) || ((status?.loading || status?.error) && (audit.completionId || audit.completedAt)))) {
    el.value = audit.payStart;
    return;
  }
  let val = el.type === 'checkbox' ? el.checked : el.value;
  if (!setPath(target, path, val)) return;

  if (root === 'audit' && path === 'auditor') db.auditor = val.trim();
  if (root === 'audit' && path === 'payStart' && val) audit.payEnd = addDays(val, 13);
  if (ui.error && getPath(target, path)) {
    ui.error = '';
    app.querySelector('.flash-error')?.remove();
  }
  if (!['login', 'draft', 'newUser', 'reset'].includes(root)) persist(audit); // forms that aren't audit data don't save locally
  if ('rerender' in el.dataset) render();
};
app.addEventListener('input', onBind);
app.addEventListener('change', onBind);

boot();
