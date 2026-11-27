// @vitest-environment node
// Supervisor sign-in (Module 4): the session is a signed HttpOnly cookie, it
// can't be forged, extended or guessed, and without the server's variables
// nobody can sign in at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  options: new Map<string, Record<string, unknown>>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.values.set(name, value);
      jar.options.set(name, options);
    },
    delete: (name: string) => void jar.values.delete(name),
  }),
}));

import {
  isSupervisor,
  isSupervisorAuthConfigured,
  NotAuthorizedError,
  requireSupervisor,
  SESSION_COOKIE,
  SESSION_SECONDS,
  sessionToken,
  signInSupervisor,
  signOutSupervisor,
  verifyToken,
} from "@/lib/copper/supervisor-auth";

const PASSCODE = "correct-horse-battery";
const SECRET = "s".repeat(40);
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  jar.values.clear();
  jar.options.clear();
  vi.stubEnv("SUPERVISOR_PASSCODE", PASSCODE);
  vi.stubEnv("SUPERVISOR_SESSION_SECRET", SECRET);
  (globalThis as { __copperSignInFailures?: unknown }).__copperSignInFailures =
    undefined;
});
afterEach(() => vi.unstubAllEnvs());

describe("configuration fails closed", () => {
  it.each([
    ["no passcode", "", SECRET],
    ["no secret", PASSCODE, ""],
    ["a short passcode", "short", SECRET],
    ["a short secret", PASSCODE, "too-short"],
  ])("nobody can sign in with %s", async (_name, passcode, secret) => {
    vi.stubEnv("SUPERVISOR_PASSCODE", passcode);
    vi.stubEnv("SUPERVISOR_SESSION_SECRET", secret);
    expect(isSupervisorAuthConfigured()).toBe(false);
    const result = await signInSupervisor(passcode);
    expect(result.ok).toBe(false);
    expect(jar.values.size).toBe(0);
    expect(await isSupervisor()).toBe(false);
    // Not even a token signed with the (weak) secret counts.
    expect(verifyToken(sessionToken(secret, now() + 100))).toBe(false);
  });
});

describe("signing in", () => {
  it("a right passcode sets an HttpOnly, SameSite cookie that lasts eight hours", async () => {
    expect(await isSupervisor()).toBe(false);
    expect(await signInSupervisor(PASSCODE)).toEqual({ ok: true });
    expect(await isSupervisor()).toBe(true);
    expect(jar.options.get(SESSION_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    expect(SESSION_SECONDS).toBe(8 * 60 * 60);
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await signInSupervisor(PASSCODE);
    expect(jar.options.get(SESSION_COOKIE)).toMatchObject({ secure: true });
  });

  it("never puts the passcode or the secret in the cookie", async () => {
    await signInSupervisor(PASSCODE);
    const cookie = jar.values.get(SESSION_COOKIE)!;
    expect(cookie).not.toContain(PASSCODE);
    expect(cookie).not.toContain(SECRET);
  });

  it.each(["wrong-passcode", "", " ", PASSCODE + " ", PASSCODE.toUpperCase()])(
    "a wrong passcode (%j) gives no session",
    async (passcode) => {
      const result = await signInSupervisor(passcode);
      expect(result).toEqual({
        ok: false,
        error: "That passcode isn't right.",
      });
      expect(jar.values.size).toBe(0);
      expect(await isSupervisor()).toBe(false);
    },
  );

  it.each([undefined, null, 12345678, {}, [PASSCODE]])(
    "a passcode that isn't text (%j) gives no session",
    async (passcode) => {
      expect((await signInSupervisor(passcode)).ok).toBe(false);
      expect(await isSupervisor()).toBe(false);
    },
  );

  it("locks sign-in for a minute after five wrong passcodes, even for the right one", async () => {
    for (let i = 0; i < 5; i++) await signInSupervisor("wrong-passcode");
    const locked = await signInSupervisor(PASSCODE);
    expect(locked).toEqual({
      ok: false,
      error: "Too many attempts. Try again in a minute.",
    });
    expect(await isSupervisor()).toBe(false);
  });

  it("signs out", async () => {
    await signInSupervisor(PASSCODE);
    await signOutSupervisor();
    expect(await isSupervisor()).toBe(false);
  });
});

describe("a session can't be forged", () => {
  const good = () => sessionToken(SECRET, now() + 3600);

  it("accepts a token this server signed", () => {
    expect(verifyToken(good())).toBe(true);
  });

  it("rejects an expired token", () => {
    expect(verifyToken(sessionToken(SECRET, now() - 1))).toBe(false);
  });

  it("rejects a token signed with another secret", () => {
    expect(verifyToken(sessionToken("x".repeat(40), now() + 3600))).toBe(false);
  });

  it("rejects a token whose expiry was extended", () => {
    const [, signature] = good().split(".");
    expect(verifyToken(`${now() + 10 ** 9}.${signature}`)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const [expires, signature] = good().split(".");
    const flipped = signature.replace(
      /.$/,
      signature.endsWith("0") ? "1" : "0",
    );
    expect(verifyToken(`${expires}.${flipped}`)).toBe(false);
  });

  it.each([
    undefined,
    "",
    "supervisor",
    "true",
    "1",
    ".",
    "12345.",
    ".abc",
    "abc.def",
    "99999999999999.abc",
    `${now() + 100}.${"0".repeat(64)}`,
    `${good()}.extra`,
  ])("rejects %j", (token) => {
    expect(verifyToken(token)).toBe(false);
  });

  it("a forged cookie in the request doesn't make a supervisor", async () => {
    jar.values.set(SESSION_COOKIE, "supervisor");
    expect(await isSupervisor()).toBe(false);
    jar.values.set(SESSION_COOKIE, `${now() + 3600}.${"a".repeat(64)}`);
    expect(await isSupervisor()).toBe(false);
  });

  it("requireSupervisor throws for everyone but a signed-in supervisor", async () => {
    await expect(requireSupervisor()).rejects.toBeInstanceOf(
      NotAuthorizedError,
    );
    await signInSupervisor(PASSCODE);
    await expect(requireSupervisor()).resolves.toBeUndefined();
  });
});
