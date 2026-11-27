# Copper State Labs course app: rules for AI coding agents

This repo is the CIS 591 class app for Copper State Labs, a fictional company.
The company's facts live in `docs/copper-state-labs/product-bible.md`.
Each module's spec, instructions, tests and evals live in `specs/module-N/`.
The company's customer documents (PDFs: user guides, terms, FAQ) go in `public/docs/`; their file names are in `lib/copper/documents.ts`.
Ask Copper, the site's chatbot, is `components/copper/ask-copper.tsx` (the panel) and `lib/copper/assistant/` (its tools, instructions and Server Action). New ways to answer customers go into Ask Copper as tools, not new pages.
The Support page (`app/support/page.tsx`, at `/support`) is the Refund Console (`components/copper/refund-console.tsx`): an auto-refund limit you can change, the refunds waiting for approval with Approve and Reject, and the customer's orders, with Ask Copper docked on the right. Module 4: Copper hands refunds to a second agent, the Refund agent (`REFUND_AGENT_INSTRUCTIONS`, `refundAgentTools`); the refund rule is code in `lib/copper/orders.ts`.
Module 5 makes Ask Copper safe to ship:
- Run the app's tests and a golden-set evaluation in GitHub Actions on every pull request, and block merges to `main` when either fails. The keys go in the repo's Actions secrets. Turn on branch protection for `main` in the student's own repo: changes go in only through a pull request, and the checks must pass. No direct pushes to `main`.
- Trace every AI call in Langfuse (observability): each agent, its tool calls, tokens, cost and time.
- Evaluate Ask Copper on a golden set of questions with an AI judge, and keep the scores in Langfuse.
- Compare one support agent that does everything with the two agents (Copper and the Refund agent): run the same golden set on both and compare them in Langfuse.
Use Langfuse for evals, tracing and monitoring. Don't add other eval or monitoring tools. The Langfuse keys are `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in `.env.local`. The AI judge uses Gemini through `lib/ai/call.ts`, like every other AI call.
How the app fits together is in `docs/architecture.md`; add a section there when a module adds pages, tables or AI calls.

You are working with MBA students who are not that technical install any dependencies needed yourself.

## How to work

- **Plan before coding.** Show the plan and wait for approval before changing files.
- **Every change comes with tests.** Run `npm test` before saying a task is done, and report the result honestly.
- Also keep `npm run lint` and `npm run typecheck` passing. `npm run eval` runs the Module 5 golden-set evaluation (it calls real models, so it needs the Google key).

## Code rules

- Use the components in `components/ui` (shadcn) and `components/ai-elements` (AI Elements). Don't add other UI libraries.
- All AI model calls go through `lib/ai/call.ts` (`callText` / `callObject` / `callStream`), so every call is logged to `ai_calls`. Never call a provider SDK or the gateway directly.
- Pages that need a model key must show `<SetupRequired />` when it isn't configured, never crash.
- `cacheComponents` is on, so pages are prerendered. Anything that depends on the request (`searchParams`, AI calls, `Math.random()`, `Date.now()`) goes in an async component wrapped in `<Suspense>`, and that component calls `await connection()` (from `next/server`) first. Otherwise the build fails with a prerender error.
- To add shadcn components, run `npx shadcn@4.21.4 add <name>`. To add AI Elements, always name them: `npx ai-elements@1.9.0 add <name>`. Running `npx ai-elements` without `add` installs the entire library.

## Never

- Never read, print or commit `.env` files (including `.env.local`). Refer to variables by name only.
  To check what's set, run `npm run env:check`: it lists each variable's name with its value masked (only the first and last 4 characters of long values).
- Never correct, remove or reconcile conflicting or outdated facts in the Product Bible (for example the old 2024 privacy policy or the Marketing FAQ error). They are intentional.
- Never change files under `specs/*/tests` or `specs/*/evals`, or a module's `rubric.md`, `grading.mjs` or `checks/`. If a test looks wrong, say so instead.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
