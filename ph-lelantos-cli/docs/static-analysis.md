# Static Analysis Layer

The reviewer agent runs two layers in sequence:

1. **Static analysis layer** (this document). Deterministic, tool-based
   passes over the document model's state schema, action schemas, and
   reducer source. Produces structured `Finding[]`.
2. **LLM semantic layer**. Consumes the findings plus the relevant
   source excerpts and produces recommendations, prioritization, and
   explanations. The LLM never performs analysis that a deterministic
   tool can perform — its job is synthesis.

Keeping the layers separate means the LLM output is auditable: every
recommendation traces back to a finding with a rule id, file, and line.

## Code organization

```
src/analysis/
├── index.ts              # registry of all analyzers + runAll/runById
├── types.ts              # Finding, Analyzer, AnalyzerContext, Severity
└── analyzers/
    ├── reducer-purity.ts
    ├── reducer-return-shape.ts
    ├── schema-alignment.ts
    ├── taint-tracking.ts
    ├── forbidden-imports.ts
    ├── schema-introspection.ts
    ├── schema-diff.ts
    ├── operation-coverage.ts
    ├── pattern-rules.ts
    └── eslint-rules.ts
```

One file per analyzer. Each default-exports an `Analyzer` with a
stable `id`, a one-line `description`, and a `run(ctx)` method. The
registry in `index.ts` is the single source of truth for "what static
tools does this agent run" — adding or removing a tool is one import
plus one array entry.

All analyzers emit the same `Finding` shape (see `src/analysis/types.ts`)
so the LLM layer and any CLI output format see a homogeneous stream.

## Analyzer catalog

Every row below corresponds to exactly one file in `src/analysis/analyzers/`.

| id | Toolchain | What it checks |
|---|---|---|
| `reducer-purity` | ts-morph | Non-deterministic/impure calls inside reducers: `Date.now`, `Math.random`, `crypto.randomUUID`, `fetch`, `setTimeout`, `async`/`await`, `node:*` imports, `process.env`. |
| `reducer-return-shape` | ts-morph | Mutative contract: reducers must mutate `state` in place, not return it or reassign it. |
| `schema-alignment` | ts-morph + schema loaders | Every `state.X` read/write in a reducer corresponds to a declared schema field, and every required field is written by at least one operation. |
| `taint-tracking` | ts-morph (hand-rolled propagation) | Traces `action.input` through assignments and returns to dangerous sinks (URLs, `path.join`, `eval`, `new RegExp`, DOM). |
| `forbidden-imports` | dependency-cruiser | Reducer import closure may not reach `node:*`, HTTP clients, DB clients, loggers, or anything outside `document-models/<model>/src/**`. |
| `schema-introspection` | ajv / graphql / Powerhouse loaders | Schema-only checks: unbounded strings/numbers, `any`/`unknown`/`JSON`, missing `format`/`pattern` on IDs, recursive types without depth bound. |
| `schema-diff` | graphql-inspector (SDL) + custom JSON Schema diff | Breaking changes versus a baseline revision: removed fields/operations, narrowed types, newly required fields. |
| `operation-coverage` | schema loader + file discovery | Every declared operation has a reducer function; every reducer function maps to a declared operation; reducer file placement matches the convention. |
| `pattern-rules` | Semgrep (fallback: ast-grep) | Fast, contributor-authored syntactic rules and upstream security rulesets. No type info. |
| `eslint-rules` | ESLint programmatic API | Lint-style, file-local checks. `@typescript-eslint`, `eslint-plugin-security`, and in-tree custom rules. |

## How the analyzers relate

These groupings explain overlap on purpose — a single issue may be
caught by more than one analyzer and that is fine. Each analyzer
tightens a different failure mode.

- **Consistency between schema and code** — `schema-alignment`,
  `operation-coverage`, `reducer-return-shape`.
- **Determinism / purity** — `reducer-purity`, `forbidden-imports`.
  Purity checks call sites; forbidden-imports checks the import
  closure so indirect I/O is caught.
- **Input validation / injection** — `schema-introspection` (structural
  weakness at the boundary), `taint-tracking` (data-flow from input to
  sinks), `pattern-rules` (syntactic sink rules).
- **Revision safety** — `schema-diff` alone.
- **General hygiene** — `eslint-rules`, `pattern-rules`.

## Why these tools

- **ts-morph** wraps the TypeScript Compiler API with an ergonomic
  surface. We get the real type-checker, so `state.X` analysis is
  semantic, not syntactic. This is the workhorse of the layer.
- **dependency-cruiser** is declarative and cheap. Rules like "reducers
  must not reach `node:fs` through any depth of imports" are one config
  entry and catch regressions that purity checks can miss.
- **Powerhouse loaders** (`@powerhousedao/reactor`, `document-model`)
  give us the same schema object graph the runtime uses, so findings
  line up with real behavior. Prefer these over raw JSON/SDL parsing.
- **ajv** / **graphql** for walking schemas when we need to go below
  what the Powerhouse loaders expose.
- **graphql-inspector** for SDL diffing is mature and well-tested; for
  JSON-Schema document models we will roll a small diff.
- **Semgrep / ast-grep** are right for patterns that don't need type
  info. They keep the type-aware analyzers focused.
- **ESLint** is already in the project toolchain and is the path of
  least resistance for rules that are file-local.
- **CodeQL** is intentionally out of scope. It is powerful but adds a
  separate query language, CI cost, and install footprint. Reconsider
  if taint-tracking proves insufficient.

## Context provided to analyzers

`AnalyzerContext` (see `src/analysis/types.ts`) is the only input an
analyzer should depend on. Concretely:

- `models: LoadedDocumentModel[]` — each with the parsed state schema,
  operation list (with input schemas), and the resolved reducer
  directory on disk.
- `projectRoot: string` — absolute path to the reactor package being
  reviewed.

Analyzers must not read ambient environment, make network calls, or
depend on process cwd. They are themselves pure functions of
`AnalyzerContext` (plus local reads of files under `projectRoot`), so
the agent can cache their output and re-run subsets selectively.

## Adding an analyzer

1. Create `src/analysis/analyzers/<id>.ts` that default-exports an
   `Analyzer` with a unique `id` and a clear one-line `description`.
2. Register it in `src/analysis/index.ts`.
3. Add a row to the catalog table above.
4. If it relies on a new third-party tool, add the dependency and a
   short rationale here under "Why these tools".

## Finding contract

Every `Finding` includes:

- `analyzerId` and `ruleId` — so a report reader knows which tool and
  which specific rule fired.
- `severity` — `error` / `warning` / `info`.
- `model`, `module`, `operation` — scope of the finding when known.
- `location` — file path, line, column, end position.
- `message` — short, human-readable.
- `evidence` — the quoted source excerpt the finding is based on.
- `suggestion` — optional concrete fix, if the rule has one.

The LLM layer will only make recommendations that cite one or more
findings by `analyzerId`/`ruleId` plus the `location`. That is the
contract that keeps the two layers auditable.
