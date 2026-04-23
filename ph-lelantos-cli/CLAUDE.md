# ph-lelantos-cli

A CLI-delivered agent that performs **consistency and security reviews** of
Powerhouse document models. Given a document model's state schema, action
(operation) schemas, and reducer code, the agent combines static analysis with
LLM-assisted semantic analysis to surface bugs, schema drift, and security
issues.

## What this agent reviews

In the Powerhouse ecosystem a document model is defined by three tightly
coupled artifacts. The agent reasons about all three jointly:

- **State schema** — the shape of a document's state (global/local scopes),
  authored via `powerhouse/document-model` and stored as JSON/GraphQL schema.
- **Action schemas** — the typed inputs for every operation the document
  accepts. Each module groups related operations.
- **Reducers** — pure synchronous functions (`document-models/<model>/src/reducers/<module>.ts`)
  that apply an operation to the current state. They are Mutative-wrapped, so
  they mutate `state` directly. Non-deterministic values (dates, IDs) must
  come from the action input, not be generated inside the reducer.

Review targets (non-exhaustive):

- **Consistency**: reducer mutations must match the declared state schema;
  every declared action must have a reducer; required fields must be enforced;
  state invariants must hold after every operation.
- **Determinism**: reducers must be pure and synchronous — no `Date.now()`,
  `Math.random()`, I/O, or external state. Report any violation.
- **Input validation**: reducers must treat action input as untrusted. Missing
  schema constraints (length, range, enum, regex) and missing guards in the
  reducer are findings.
- **Authorization / scope**: operations that can escalate privileges, mutate
  protected fields, or cross scope boundaries (global vs. local) need scrutiny.
- **Injection / traversal**: any string from input that flows into URLs,
  file paths, HTML, SQL, or shell-like sinks.
- **Referential integrity**: IDs, foreign keys, and parent/child relationships
  must remain consistent across operations (including undo/redo semantics).

## Architecture

Two layers, always in this order:

1. **Static analysis layer** — deterministic tools under `src/analysis/`
   produce structured `Finding[]`. See `docs/static-analysis.md` for the
   full catalog and rationale.
2. **LLM semantic layer** — the Mastra agent (`src/agents/agent.ts`)
   consumes findings and produces recommendations. It must not perform
   analysis that a static tool can do; its job is synthesis, and every
   recommendation must cite the finding(s) it rests on.

This is a `ph-clint`-generated CLI. `ph-clint` owns project scaffolding and
regenerates sections marked with `@clint:begin ... @clint:end`. **Do not edit
inside those regions by hand** — they are rewritten on spec changes. Code
outside the markers is user-owned and preserved across regens.

Key files:

- `src/main.ts` — CLI entry (`ph-lelantos` bin).
- `src/cli.ts` — `defineCli(...)` wiring: commands, services, triggers,
  prompts, reactor, Mastra agent. Most slots are currently empty stubs.
- `src/config.ts` — CLI identity pulled from `package.json`.
- `src/framework.ts` — **user-owned**. Declares `configSchema` and
  `secretsSchema` (zod). Survives regens.
- `src/framework.gen.ts` — **generated**. Typed document registry. Do not edit.
- `src/analysis/` — static analysis layer. `index.ts` is the registry,
  `types.ts` defines `Finding` / `Analyzer`, `analyzers/*.ts` is one file
  per tool. See `docs/static-analysis.md`.
- `src/agents/agent.ts` — Mastra `AgentProvider` factory. Currently a demo
  echo; replace with the real reviewer agent (model + tools).
- `src/mastra/index.ts` — Mastra Studio entry (placeholder until the
  `mastra` feature is enabled).
- `src/commands/`, `src/services/`, `src/triggers/` — empty slots for
  `defineCommand` / `defineService` / `defineTrigger` implementations.
- `prompts/agent-profiles/AgentBase.md` — base system prompt; extended by
  section files and compiled by `scripts/build-skills.ts`.
- `prompts/skills-tpl/`, `prompts/skills-ext/` — Handlebars skill templates
  compiled into `gen/` and `dist/gen/` via `pnpm build:skills`.
- `docs/static-analysis.md` — canonical description of the static analysis
  layer. Edit this whenever an analyzer is added, removed, or changes
  scope.

The CLI ships with a reactor (`buildDefaultReactor`) that loads document
models from the sibling `../ph-lelantos-app` package. That app is the source
of the models the agent reviews — see `../ph-lelantos-app/document-models/`
and its `CLAUDE.md` for document-model authoring conventions.

## Commands

```bash
pnpm dev          # run the CLI from source (tsx)
pnpm build        # build:skills then tsc
pnpm build:skills # compile Handlebars prompts to gen/ and dist/gen/
pnpm start        # run the built CLI
pnpm test         # jest (ESM)
pnpm lint         # eslint src
pnpm mastra:dev   # Mastra Studio (once the mastra feature is wired)
```

Node `>=22.13.0` is required. `pnpm` is the package manager (lockfile is
`pnpm-lock.yaml`).

## Working in this repo

- Prefer editing existing stubs (`agent.ts`, `framework.ts`) over creating
  parallel files. The `ph-clint` layout exists so regeneration stays safe.
- When adding commands/services/triggers, create them under the matching
  `src/<slot>/` directory and register them inside the corresponding
  `@clint:begin ... @clint:end` block in `src/cli.ts`.
- **All static review logic lives in `src/analysis/`**, one file per
  analyzer. The registry in `src/analysis/index.ts` is the single source of
  truth for "what static tools does this agent run". When adding a new
  deterministic check, add a file under `analyzers/`, register it in
  `index.ts`, and add a row to the catalog in `docs/static-analysis.md`.
- LLM/agent code in `src/agents/` must not reimplement what a static
  analyzer can do. The agent consumes `Finding[]` and produces
  recommendations — nothing else.
- Document models under review come from reactor packages loaded via
  `documentModels` in `src/cli.ts`. To review another package, import its
  `documentModels` export alongside the current one.
- Tests live in `tests/**/*.test.ts` (jest + ts-jest ESM).

## Review output expectations

Static analyzers emit the shared `Finding` shape (`src/analysis/types.ts`):
severity, analyzer id, rule id, scope (model/module/operation), location
(file/line), message, evidence, and optional suggestion. The LLM layer
produces recommendations that cite one or more findings by
`analyzerId`/`ruleId` plus the finding's `location`. Recommendations that
don't cite a finding are not acceptable output — if the LLM sees something
worth flagging that no static tool catches, the right move is to add a new
analyzer under `src/analysis/analyzers/`, not to emit an uncited
recommendation.
