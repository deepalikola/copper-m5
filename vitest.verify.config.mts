import { defineConfig } from "vitest/config";

// The live check (`npm run verify:live`): the refund flow, restart survival and
// Langfuse traces, against the real services. Kept out of `npm test`, which
// must run with no keys.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["verify/**/*.verify.ts"],
    testTimeout: 5 * 60 * 1000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
