# @powerhousedao/ph-lelantos

Performs security audits on document-models.

## Getting started

```sh
pnpm install
pnpm dev
```

## Enabled features

- **Powerhouse**: on (Connect)
  - Switchboard: on
  - Connect: on
- **Mastra agent**: on
- **Routine loop**: on

## Regenerate

Toggle features or update metadata in `.ph/ph-clint-cli/project-spec.json`,
then re-run `ph-clint clint-project-regen` to regenerate.

## Split layout

This project is split into `ph-lelantos-cli/` (the CLI) and `ph-lelantos-app/` (the Powerhouse reactor package).

Run `ph init` inside `ph-lelantos-app/` to scaffold the reactor package layout (document-models, editors, manifest, etc.).
