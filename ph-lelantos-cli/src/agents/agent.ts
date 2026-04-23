import { Agent } from '@mastra/core/agent';
import type { AgentProvider, AgentSetupContext } from '@powerhousedao/ph-clint';
import { createWorkdirStore } from '@powerhousedao/ph-clint';
import { createMastraHelpers } from '@powerhousedao/ph-clint/mastra';
import { CLI_NAME } from '../config.js';
import type { Config } from '../framework.js';
import { getFindingsTool, readSourceTool } from './tools.js';

export interface CreateReviewerAgentArgs {
  instructions: string;
  model: string;
  apiKey?: string;
  workspace?: unknown;
  memory?: unknown;
}

/**
 * Construct the raw Mastra reviewer agent. Exposed so callers (CLI command,
 * Mastra Studio entry) can invoke `.stream(prompt, { runtimeContext })`
 * directly and inject findings via the request context.
 */
export function createReviewerAgent(args: CreateReviewerAgentArgs): Agent {
  const model = args.apiKey
    ? { id: args.model, apiKey: args.apiKey }
    : args.model;
  return new Agent({
    id: 'lelantos-reviewer',
    name: 'Lelantos Reviewer',
    instructions: args.instructions,
    model: model as never,
    tools: {
      getFindings: getFindingsTool,
      readSource: readSourceTool,
    },
    workspace: args.workspace as never,
    memory: args.memory as never,
  });
}

/**
 * Agent factory invoked by `cli.configureAgent`. Wraps the Mastra agent as a
 * ph-clint `AgentProvider`.
 */
export async function createAgent(
  ctx: AgentSetupContext<Config>,
): Promise<AgentProvider> {
  const m = createMastraHelpers(ctx);
  const agent = createReviewerAgent({
    instructions: m.getAgentInstructions('lelantos-reviewer'),
    model: ctx.config.model,
    apiKey: ctx.config.apiKey,
    workspace: await m.createWorkspace(),
    memory: await m.createMemory(),
  });
  const store = createWorkdirStore(ctx.workdir, CLI_NAME);
  return m.wrapAgent(agent, {
    maxSteps: 40,
    enableLogging: ctx.config.agentLogging,
    logDirectory: store.getStoreFolder('logs'),
    cacheControl: true,
  });
}
