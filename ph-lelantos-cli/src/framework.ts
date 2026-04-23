/**
 * Per-CLI typed framework binding.
 *
 * This file is USER-OWNED. ph-clint-cli emits it once at project
 * creation and never overwrites it afterwards — edit `configSchema`
 * and `secretsSchema` freely.
 */
import { z } from 'zod';
import { createTypes } from '@powerhousedao/ph-clint';

export const configSchema = z.object({
  model: z
    .string()
    .default('anthropic/claude-opus-4-7')
    .describe('LLM model (provider-prefixed id)'),
  agentLogging: z
    .boolean()
    .default(false)
    .describe('Write agent conversation logs to disk'),
  connectPort: z.number().default(3000).describe('Connect Studio port'),
  switchboardPort: z.number().default(4001).describe('Switchboard port'),
});

export const secretsSchema = z.object({
  apiKey: z
    .string()
    .optional()
    .describe('Anthropic API key; falls back to ANTHROPIC_API_KEY'),
});

export type Config = z.infer<typeof configSchema> &
  z.infer<typeof secretsSchema>;

const fullConfigSchema = configSchema.merge(secretsSchema);

/**
 * No reactor package — bind `createTypes` directly so
 * `defineCommand` / `defineTrigger` / `defineService` still pick up
 * the typed config. Enable `features.powerhouse` in the project spec
 * and codegen will switch these exports to a registry-backed
 * `framework.gen.ts`.
 */
export const {
  defineCommand,
  defineTrigger,
  defineService,
  createDocumentChangeTrigger,
} = createTypes({ configSchema: fullConfigSchema });
