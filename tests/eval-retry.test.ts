// @vitest-environment node
// The live evaluation's patient retries (evals/lib/retry.ts): a rate-limited
// chat or judge call is tried again after a wait, and a real failure still
// fails once the waits run out. The waits are faked, so this runs instantly.
import { describe, expect, it, vi } from "vitest";
import { RETRY_DELAYS_MS, retryPatiently } from "@/evals/lib/retry";

const noWait = () => Promise.resolve();

describe("retryPatiently", () => {
  it("waits 20, 40 and 60 seconds between tries by default", () => {
    expect(RETRY_DELAYS_MS).toEqual([20_000, 40_000, 60_000]);
  });

  it("returns at once when the first try works", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    const wait = vi.fn(noWait);
    await expect(retryPatiently(run, { wait })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("tries again after an error, waiting the given delays", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("You exceeded your current quota"))
      .mockRejectedValueOnce(new Error("You exceeded your current quota"))
      .mockResolvedValue("ok");
    const wait = vi.fn(noWait);
    const onRetry = vi.fn();
    await expect(
      retryPatiently(run, { wait, onRetry, delaysMs: [5, 10, 15] }),
    ).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[5], [10]]);
    expect(onRetry.mock.calls).toEqual([
      [1, 5],
      [2, 10],
    ]);
  });

  it("tries again when the result counts as failed", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ errored: true })
      .mockResolvedValue({ errored: false });
    const result = await retryPatiently(run, {
      wait: noWait,
      failed: (r: { errored: boolean }) => r.errored,
    });
    expect(result).toEqual({ errored: false });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns the last failed result once the waits run out", async () => {
    const run = vi.fn().mockResolvedValue({ errored: true });
    const result = await retryPatiently(run, {
      wait: noWait,
      failed: (r: { errored: boolean }) => r.errored,
      delaysMs: [1, 1],
    });
    expect(result).toEqual({ errored: true });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("throws the last error once the waits run out", async () => {
    const run = vi.fn().mockRejectedValue(new Error("API key not valid"));
    await expect(
      retryPatiently(run, { wait: noWait, delaysMs: [1] }),
    ).rejects.toThrow("API key not valid");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
