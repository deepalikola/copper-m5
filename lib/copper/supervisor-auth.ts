// Who may approve, reject and change the limit on the Refund Console (Module 4).
// The customer chat can't: the Refund agent has no such tool, and every
// privileged server action checks this session first (app/support/actions.ts).
// Without it, anyone who could open /support could raise the limit to a million
// dollars, or approve their own refund.
//
// How it works: a supervisor signs in with SUPERVISOR_PASSCODE. The server then
// sets an HttpOnly cookie holding an expiry time and an HMAC signature made
// with SUPERVISOR_SESSION_SECRET, so the browser can't read it with script and
// can't forge or extend it. Both variables are server-only.
//
// It fails closed: if either variable is missing or too short, nobody can sign
// in. It is a shared passcode, so it proves "a supervisor" and not which one.
// requireSupervisor() is the one place to replace with a real identity system
// (for example Supabase Auth) later.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "copper_supervisor";
export const SESSION_SECONDS = 8 * 60 * 60;
const MIN_PASSCODE = 8;
const MIN_SECRET = 32;

export class NotAuthorizedError extends Error {
  constructor() {
    super("Only a signed-in supervisor can do that.");
    this.name = "NotAuthorizedError";
  }
}

function config() {
  const passcode = process.env.SUPERVISOR_PASSCODE ?? "";
  const secret = process.env.SUPERVISOR_SESSION_SECRET ?? "";
  return passcode.length >= MIN_PASSCODE && secret.length >= MIN_SECRET
    ? { passcode, secret }
    : null;
}

/** False means nobody can sign in, because the variables aren't set (or are too short). */
export function isSupervisorAuthConfigured(): boolean {
  return config() !== null;
}

const sign = (secret: string, expires: number) =>
  createHmac("sha256", secret).update(`supervisor.${expires}`).digest("hex");

/** A session token valid until `expires` (seconds since 1970). Exported for tests. */
export function sessionToken(secret: string, expires: number): string {
  return `${expires}.${sign(secret, expires)}`;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Is this a token this server signed, and not expired? */
export function verifyToken(
  token: string | undefined,
  now = Date.now() / 1000,
): boolean {
  const settings = config();
  if (!settings || !token) return false;
  const [expiresText, signature, ...extra] = token.split(".");
  if (extra.length || !signature || !/^\d{1,12}$/.test(expiresText ?? ""))
    return false;
  const expires = Number(expiresText);
  return expires > now && sameText(signature, sign(settings.secret, expires));
}

/** Is the person making this request a signed-in supervisor? */
export async function isSupervisor(): Promise<boolean> {
  return verifyToken((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Throws NotAuthorizedError unless the request comes from a signed-in supervisor. */
export async function requireSupervisor(): Promise<void> {
  if (!(await isSupervisor())) throw new NotAuthorizedError();
}

// A few wrong passcodes in a row lock sign-in for a minute, so the passcode
// can't be guessed by trying them one after another. Kept per server process.
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;
const attempts = globalThis as {
  __copperSignInFailures?: { count: number; since: number };
};

const hash = (text: string) => createHash("sha256").update(text).digest();

export type SignInResult = { ok: true } | { ok: false; error: string };

export async function signInSupervisor(
  passcode: unknown,
): Promise<SignInResult> {
  const settings = config();
  if (!settings)
    return {
      ok: false,
      error:
        "Supervisor sign-in isn't set up. Set SUPERVISOR_PASSCODE and SUPERVISOR_SESSION_SECRET.",
    };
  const now = Date.now();
  const failures = (attempts.__copperSignInFailures ??= {
    count: 0,
    since: now,
  });
  if (now - failures.since > LOCK_MS)
    Object.assign(failures, { count: 0, since: now });
  if (failures.count >= MAX_FAILURES)
    return { ok: false, error: "Too many attempts. Try again in a minute." };
  if (
    typeof passcode !== "string" ||
    !timingSafeEqual(hash(passcode), hash(settings.passcode))
  ) {
    failures.count++;
    return { ok: false, error: "That passcode isn't right." };
  }
  failures.count = 0;
  (await cookies()).set(
    SESSION_COOKIE,
    sessionToken(settings.secret, Math.floor(now / 1000) + SESSION_SECONDS),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_SECONDS,
    },
  );
  return { ok: true };
}

export async function signOutSupervisor(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
