import { createClient } from "@supabase/supabase-js";

/**
 * Supabase client with the server-only service-role key, for the refund
 * tables. Those tables have row-level security on and no public policies, so
 * nobody can read or write refunds with the publishable key that ships to the
 * browser: every refund goes through the rules in lib/copper/refunds.ts.
 * Returns null if the keys aren't set. Never import this into client code.
 */
export function createRefundStoreClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key
    ? createClient(url, key, { auth: { persistSession: false } })
    : null;
}
