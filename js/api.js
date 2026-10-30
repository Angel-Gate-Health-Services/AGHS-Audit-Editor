// Everything that talks to Supabase: sign-in, homes and residents, and user accounts.
// Access rules are enforced by the database (supabase/schema.sql), not by this file.
import { createClient } from './supabase-client.js';
import { SUPABASE_URL, SUPABASE_KEY, USERNAME_DOMAIN } from './supabase-config.js';

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Accept the project URL even if it was pasted with an API path (e.g. .../rest/v1/).
const projectUrl = SUPABASE_URL.trim().replace(/\/(rest|auth)\/v1\/?$/, '').replace(/\/+$/, '');

const supabase = configured
  ? createClient(projectUrl, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'aghs-auth' } })
  : null;

const usernameToEmail = (username) => `${username.trim().toLowerCase()}@${USERNAME_DOMAIN}`;

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// ---------- Session ----------

export async function currentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onSignedOut(callback) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') callback();
  });
}

export async function signIn(username, password) {
  const { error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(username), password });
  if (error) {
    if (/banned/i.test(error.message)) throw new Error('This account has been disabled. Contact your administrator.');
    if (/invalid login credentials/i.test(error.message)) throw new Error('Incorrect username or password.');
    // Setup problems (e.g. email sign-in turned off in Supabase) shouldn't look like a wrong password.
    throw new Error(`Sign-in isn’t available right now (${error.message}). Contact your administrator.`);
  }
  return loadProfile();
}

// The signed-in user's profile. Signs out and throws if the account isn't set up or active.
export async function loadProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const profile = check(await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle());
  if (!profile || !profile.active) {
    await supabase.auth.signOut();
    throw new Error(profile ? 'This account has been disabled. Contact your administrator.' : 'This account isn’t set up yet. Contact your administrator.');
  }
  return profile;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// A fresh browser visit must not inherit a token left behind by a closed tab.
// Local scope clears this browser without revoking unrelated server sessions.
export async function clearBrowserSession() {
  await supabase.auth.signOut({ scope: 'local' });
}

// ---------- Homes and residents ----------

const toHome = (row) => ({
  id: row.id,
  name: row.name,
  address: row.address,
  phone: row.phone,
  managerTitle: row.manager_title,
  manager: row.manager,
  cell: row.cell,
  email: row.email,
  supervisor: row.supervisor,
  residentRows: [...(row.residents || [])].sort((a, b) => a.name.localeCompare(b.name)),
  residents: (row.residents || []).map((r) => r.name),
});

const fromHome = (h) => ({
  name: h.name.trim(),
  address: (h.address || '').trim(),
  phone: (h.phone || '').trim(),
  manager_title: (h.managerTitle || 'Lead').trim(),
  manager: (h.manager || '').trim(),
  cell: (h.cell || '').trim(),
  email: (h.email || '').trim(),
  supervisor: (h.supervisor || '').trim(),
});

export async function listHomes() {
  return check(await supabase.from('homes').select('*, residents(id, name)').order('name')).map(toHome);
}

export async function createHome(home) {
  return check(await supabase.from('homes').insert(fromHome(home)).select('id').single()).id;
}

export async function updateHome(id, home) {
  check(await supabase.from('homes').update(fromHome(home)).eq('id', id));
}

export async function deleteHome(id) {
  check(await supabase.from('homes').delete().eq('id', id));
}

export async function addResident(homeId, name) {
  check(await supabase.from('residents').insert({ home_id: homeId, name: name.trim() }));
}

export async function renameResident(id, name) {
  check(await supabase.from('residents').update({ name: name.trim() }).eq('id', id));
}

export async function deleteResident(id) {
  check(await supabase.from('residents').delete().eq('id', id));
}

// One-time import of a homes file (AGHS homes.json). Skips homes whose name already exists.
export async function importHomes(sites, existingNames) {
  const have = new Set(existingNames.map((n) => n.toLowerCase()));
  let added = 0;
  for (const s of sites) {
    if (!s.name || have.has(s.name.toLowerCase())) continue;
    const id = await createHome(s);
    const residents = (s.residents || []).map((r) => String(r).trim()).filter(Boolean);
    if (residents.length) check(await supabase.from('residents').insert(residents.map((name) => ({ home_id: id, name }))));
    added++;
  }
  return added;
}

// ---------- Shared audit progress ----------

export async function listAuditActivity() {
  return check(await supabase.from('audit_activity').select('*'));
}

const activityParams = (lease) => ({ p_home_id: lease.homeId, p_session_id: lease.sessionId, p_audit_id: lease.auditId });

export async function claimAuditSite(lease) {
  return check(await supabase.rpc('claim_audit_site', activityParams(lease)))?.[0] || null;
}

export async function renewAuditSite(lease) {
  return check(await supabase.rpc('renew_audit_site', activityParams(lease)))?.[0] || null;
}

export async function releaseAuditSite(lease) {
  check(await supabase.rpc('release_audit_site', activityParams(lease)));
}

// Completed audits for one pay period: [{ home_id, completed_by, completed_by_name, completed_at }]
export async function listCompletions(payPeriodStart) {
  return check(await supabase.from('audit_completions').select('*').eq('pay_period_start', payPeriodStart));
}

// Who and when are stamped by the database from the signed-in account.
export async function markAuditComplete(payPeriodStart, homeId, completionId) {
  const { data, error } = await supabase.from('audit_completions')
    .insert({ id: completionId, pay_period_start: payPeriodStart, home_id: homeId })
    .select('*')
    .single();
  if (error) {
    // Retrying after a lost response must keep the saved audit linked to its completion.
    if (error.code === '23505' && completionId) {
      const existing = check(await supabase.from('audit_completions').select('*').eq('id', completionId).maybeSingle());
      if (existing?.pay_period_start === payPeriodStart && existing?.home_id === homeId) return existing;
    }
    throw new Error(error.code === '23505' ? 'This home is already marked complete for this pay period.' : error.message);
  }
  return data;
}

export async function reopenAudit(completionId) {
  // Delete the exact completion we checked, never a newer completion of the same home.
  const removed = check(await supabase.from('audit_completions').delete().eq('id', completionId).select('id'));
  if (removed?.length) return;
  // Another tab may already have reopened it. That is success, not a permissions error.
  const existing = check(await supabase.from('audit_completions').select('id').eq('id', completionId).maybeSingle());
  if (existing) throw new Error('Only admins can undo audit progress.');
}

// ---------- User accounts (admin only) ----------

export async function listUsers() {
  return check(await supabase.from('profiles').select('*').order('username'));
}

async function adminUsers(body) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    let message = error.message;
    try {
      message = (await error.context.json()).error || message;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return data;
}

export const createUser = (user) => adminUsers({ action: 'create', ...user });
export const updateUser = (id, changes) => adminUsers({ action: 'update', id, ...changes });
export const deleteUser = (id) => adminUsers({ action: 'delete', id });
