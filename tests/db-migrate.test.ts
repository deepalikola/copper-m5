// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";

const script = join(process.cwd(), "scripts/db-migrate.mjs");

const windows = process.platform === "win32";

function run(env: Record<string, string>) {
  // A fake `npx` on PATH records the command instead of touching a database.
  // On Windows npx is a .cmd file, so the fake is a batch file there.
  const bin = tempDir("fake-npx-");
  if (windows) {
    writeFileSync(join(bin, "npx.cmd"), "@echo off\r\necho npx %*\r\n");
  } else {
    writeFileSync(join(bin, "npx"), '#!/bin/sh\necho "npx $*"\n');
    chmodSync(join(bin, "npx"), 0o755);
  }
  return spawnSync(process.execPath, [script], {
    env: {
      NODE_ENV: "test",
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      // cmd.exe needs these to start on Windows.
      ...(windows && {
        SystemRoot: process.env.SystemRoot ?? "",
        ComSpec: process.env.ComSpec ?? "",
      }),
      ...env,
    },
    encoding: "utf8",
  });
}

describe("npm run db:migrate", () => {
  it("explains how to set up Supabase when SUPABASE_DB_URL is missing", () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set up Supabase");
  });

  it("pushes migrations and the seed to SUPABASE_DB_URL", () => {
    const result = run({ SUPABASE_DB_URL: "postgresql://example" });
    // The message makes a failure on another OS readable in the CI log.
    expect(
      result.status,
      `stderr: ${result.stderr}\nstdout: ${result.stdout}\nerror: ${result.error}`,
    ).toBe(0);
    // The fake prints its arguments; Windows' echo may add quotes or spaces.
    expect(result.stdout.trim().replace(/\r/g, "")).toBe(
      "npx supabase db push --db-url postgresql://example --include-seed --yes",
    );
  });
});
