// Patient retries for the live evaluation. Gemini's free tier allows only so
// many requests a minute; past that it answers "You exceeded your current
// quota" and the AI SDK's own quick retries (about a second apart) fail too.
// Waiting tens of seconds lets the minute roll over, so a rate limit doesn't
// show up as a failed case. A case that still fails after every wait counts as
// failed, so the gate stays closed on real problems.

/** Waits before the 2nd, 3rd and 4th tries: 20 s, 40 s, then 60 s. */
export const RETRY_DELAYS_MS = [20_000, 40_000, 60_000];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export type RetryOptions<T> = {
  /** A result that should be tried again, e.g. a chat turn that errored. */
  failed?: (result: T) => boolean;
  delaysMs?: number[];
  wait?: (ms: number) => Promise<void>;
  /** Told about each retry, so the log shows why the run took longer. */
  onRetry?: (attempt: number, delayMs: number) => void;
};

/**
 * Runs `run`, and if it throws or returns a `failed` result, waits and runs it
 * again, once per delay. Returns the last result, or throws the last error.
 */
export async function retryPatiently<T>(
  run: () => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  const {
    failed = () => false,
    delaysMs = RETRY_DELAYS_MS,
    wait = sleep,
    onRetry,
  } = options;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delaysMs.length;
    try {
      const result = await run();
      if (last || !failed(result)) return result;
    } catch (error) {
      if (last) throw error;
    }
    onRetry?.(attempt + 1, delaysMs[attempt]);
    await wait(delaysMs[attempt]);
  }
}
