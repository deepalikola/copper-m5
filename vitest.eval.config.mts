import { defineConfig } from "vitest/config";

// The golden-set evaluation (`npm run eval`). It calls real models, so it is
// kept out of `npm test`, which must run with no keys.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 60 * 60 * 1000,
    fileParallelism: false,
  },
});
