// Your Supabase project's public connection settings (Supabase → Project Settings → API).
// These are safe to publish: they only let the browser *ask* for data, and the database's
// row-level security refuses everything unless the person is signed in with an active account.
// Never put the service_role / secret key here.

export const SUPABASE_URL = 'https://nwfudnsabfriczruumeq.supabase.co'; // just the base address, no /rest/v1
export const SUPABASE_KEY = 'sb_publishable_4QnfweXOXcCn6aNDnqwwog_Pf8rzyte'; // public anon key, not the service_role key

// Usernames sign in as <username>@USERNAME_DOMAIN behind the scenes.
// Must match USERNAME_DOMAIN in supabase/functions/admin-users/index.ts.
export const USERNAME_DOMAIN = 'users.aghs-audit.local';
