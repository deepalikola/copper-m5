import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    // specs/ holds the archived Module 0 acceptance tests; the course
    // grader ran them with `npm run check`, which this branch no longer has.
    exclude: ["node_modules/**", ".next/**", "specs/**"],
  },
});
