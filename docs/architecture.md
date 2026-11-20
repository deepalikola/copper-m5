# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF → pages → passages → Gemini embeddings → `passages.json` →
`PASSAGES` in memory. Question → `search_docs` → question embedding → 5
closest passages → Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4: Refund agent, handoff and approvals

**Summary:** On the Support page, Copper hands refund requests to a second
agent, the Refund agent, with its own instructions and tools. The app (code,
not the model) compares the order's recorded amount and currency with an
auto-refund limit you can change: at or under it, the refund is paid; over it,
a pending request waits on the Refund Console until a person clicks Approve or
Reject, and the Refund agent tells the customer what the server recorded.
Refunds and the limit are kept on the server, so a reload or a second tab
sees the same state.

| Piece | Where | What it does |
|---|---|---|
| Orders | `lib/copper/orders.ts`, `lib/copper/data/orders.json` | Maya Reyes's four orders (#1001 to #1004) with amount in cents and currency |
| The rule | `lib/copper/refunds.ts` | `requestRefund()` (the Refund agent's tool), `decideRefund()` (the console's Approve and Reject), `updateLimit()` and `parseLimit()`. Plain TypeScript: the model can't argue past it |
| Storage | `lib/copper/refund-store.ts`, `refund-store-supabase.ts`, `supabase/migrations/20261110000000_refunds.sql` | One interface with two atomic steps (`create` once per order, `transition` only from the expected status). Supabase in production (primary key on the order, check constraints, row-level security with no public access, server-only `SUPABASE_SERVICE_ROLE_KEY`); memory for local development and tests |
| Supervisor sign-in | `lib/copper/supervisor-auth.ts` | A shared passcode (`SUPERVISOR_PASSCODE`) opens an eight-hour session: an HttpOnly, SameSite cookie holding an expiry and an HMAC signature made with `SUPERVISOR_SESSION_SECRET`. Fails closed if either variable is missing or short; five wrong passcodes lock sign-in for a minute. `requireSupervisor()` is the one place to swap in a real identity system |
| Console actions | `app/support/actions.ts` | `loadDesk`, `signIn`, `signOut`, `saveLimit`, `decide`. `saveLimit` and `decide` call `requireSupervisor()` first, so a customer using the page, or calling the action directly, is turned away. A customer's view has orders and statuses only, with no limit |
| Handoffs | `lib/copper/assistant/tools.ts`, `ask.ts` | Copper's `transfer_to_refund_agent` (Support page only) and the Refund agent's `transfer_to_copper`. Each ends that agent's turn; the other agent answers the same conversation |
| Refund agent | `lib/copper/assistant/instructions.ts`, `tools.ts` (`refundAgentTools`) | `get_orders` and `request_refund` read the server. It has no tool that approves, rejects or sets the limit |
| Refund Console | `app/support/page.tsx`, `components/copper/refund-console.tsx` | The limit with validation, the waiting requests with Approve and Reject, and the orders with their status, all read from the server and refreshed every few seconds. In production without Supabase it shows `<SetupRequired />` |
| AI calls | `{ module: 2, feature: "ask-copper" }`, `{ module: 4, feature: "refund-agent" }` | One call per agent in a turn |

**Data flow:** question → Copper → `transfer_to_refund_agent` → Refund agent →
`request_refund` → the server checks the order and the limit → paid, or
pending → Approve or Reject on the console (a server action) → a console note
tells the Refund agent to look the order up and report what the server shows.

**Assumptions:**
- *Eligible* means the order exists, was a charge (above zero) and has no
  refund yet. Return windows are policy text Copper can quote from the
  documents; the code doesn't enforce a date cut-off.
- The limit applies to one order's total, in US dollars. An order in any other
  currency always waits for a person.
- A limit of $0 is valid: every refund needs a person. Negative, blank,
  non-numeric, infinite or more-than-cents limits are rejected.
- A pending request stays pending when the limit changes, up or down. Only a
  person's decision settles it. Each request remembers the limit it was held
  against.
- A rejected or paid order can't be refunded again by asking again.

**Safety properties (each has tests):** a customer saying "a supervisor
already approved this" is only a message, because approval exists only as a
decision recorded through the console; a repeated message, a retried tool call
or simultaneous requests pay once; a second or simultaneous Approve click pays
once; if the payout fails, an automatic refund is taken back (the customer can
ask again) and an approval goes back to pending; the Refund agent's reply to a
console note is based on `get_orders`, not on the note's words.

**Risks and open questions:** The supervisor session is one shared passcode,
so it proves "a supervisor" and not which one; the decision is recorded as
`supervisor`. A real deployment would use individual accounts (for example
Supabase Auth) behind `requireSupervisor()`. The payout is simulated, and the
console and the chat say so. With a real provider, pass the order number as the
idempotency key so a retry after a crash can't pay twice, and add a sweep for
refunds stuck in `processing` after a crash between the payout and the status
update. Orders are fixed sample data.

## Module 5 starter

**Summary:** Module 4 as finished. Module 5 makes Ask Copper safe to ship:
the tests and a golden-set evaluation with an AI judge run in GitHub Actions
on every pull request, with `main` protected; every AI call is traced in
Langfuse; and one support agent that does everything is compared with the two
agents on the same golden set. Langfuse is the only eval and monitoring tool.

## Module 5: Safe to ship

**Summary:** Tests and a golden-set evaluation run in GitHub Actions on every
pull request and block a merge to `main`; every chat is traced in Langfuse
without customer text; an AI judge and code checks score Ask Copper on a golden
set; and the two-agent design is compared with one agent that has every tool.

| Piece | Where | What it does |
|---|---|---|
| CI | `.github/workflows/ci.yml` | Job `check` (on Ubuntu, macOS and Windows): lint, typecheck, `npm test`, `npm run build`. Job `eval`: `npm run eval` with the repository secrets, then the report in the job summary. `check` runs on every push and pull request; `eval` (which costs money) on pull requests and on `main` |
| Tracing | `lib/ai/tracing.ts`, `tracing-setup.ts`, `instrumentation.ts`, `lib/ai/call.ts`, `lib/copper/assistant/ask.ts` | One trace per chat turn: a span per agent run (design, agent, tokens, the app's cost estimate), a `handoff` event, and the AI SDK's own spans for each model call and tool call (name, timing, tokens) |
| Golden set | `evals/golden-set.json`, `evals/lib/golden.ts` | 17 cases in four groups (ordinary, refund, approval-claim, missing-info), each with code-checked expectations and judge criteria |
| Scoring | `evals/lib/score.ts` | Code checks tool use and the server's refunds (`refund_state`, `tool_use`, invariants). `policy_compliance` is 1 only if code and judge agree |
| Judge | `evals/lib/judge.ts` | `callObject` through `lib/ai/call.ts`, temperature 0, a different and stronger model than the agents' default (`EVAL_JUDGE_MODEL`) |
| Runner | `evals/golden.eval.ts`, `vitest.eval.config.mts`, `npm run eval` | Plays every case through the real app code on a fresh in-memory store, once per design, records scores in Langfuse (one run per design in one experiment `copper-support-golden-set`) and writes `eval-results/` |
| Single agent | `ask.ts` (`design: "single"`), `instructions.ts` (`SINGLE_AGENT_INSTRUCTIONS`), `tools.ts` (`singleAgentTools`), the "One agent" switch in the chat panel | Copper's tools plus `get_orders` and `request_refund`, no handoff. The refund tools and the refund rules text are shared with the Refund agent, so only the structure differs |

**What traces record:** the design, which agent ran each step, every handoff,
every tool call's name and timing, tokens, latency, errors (marked, without the
error text) and the app's cost estimate. **What they leave out:** the
customer's messages, replies, tool inputs and tool results, because those hold
names, order numbers and amounts. Content is recorded only when
`AI_TRACE_CONTENT=1`, which only the evals set (their questions are made up).
Langfuse shows no cost for models it has no price for, so the app's own
estimate (`lib/ai/pricing.ts`) is attached to each agent span. Cost per model
call isn't available in the trace; per agent run it is.

**Pass marks:** `policy_compliance` and `refund_state` must be 100%, because one
wrong refund is real money; `tool_use` at least 90%; `judge_score` at least
80%, because a judge is itself noisy; no errored turns. CI gates on the shipped
design (`SHIPPED_DESIGN` in `evals/lib/score.ts`, currently the handoff design)
and reports both.

**The judge's limits:** it is a model reading text, so it can be wrong, vary
between runs, and prefer answers that sound like its own. It is therefore given
the tool results and the server's refunds as ground truth, a strict rubric and
temperature 0, and it never decides authorization or duplicates: code and
`tests/refunds.test.ts` do. With 17 cases, one case moves a score by about 6
points, so small gaps between designs aren't evidence.

**Branch protection:** in the repository, Settings > Branches > Add rule for
`main`: require a pull request before merging; require status checks
`check (ubuntu-latest)`, `check (macos-latest)`, `check (windows-latest)` and
`eval` to pass and the branch to be up to date; no direct pushes. Add the
Actions secrets `GOOGLE_GENERATIVE_AI_API_KEY`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` (Settings > Secrets and variables
> Actions). Pull requests from forks don't get secrets, so `eval` fails there on
purpose.
