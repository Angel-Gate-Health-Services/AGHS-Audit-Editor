// The integrity-checked, local browser bundle loads before app.js.
export const createClient = (...args) => globalThis.supabase.createClient(...args);
