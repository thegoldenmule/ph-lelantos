import path from 'node:path';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { AgentProvider, AgentSetupContext, CommandContext } from '@powerhousedao/ph-clint';
import { createWorkdirStore, readSkills } from '@powerhousedao/ph-clint';
import { createMastraHelpers } from '@powerhousedao/ph-clint/mastra';
import { CLI_NAME, CLI_ROOT, CLI_VERSION } from '../config.js';
import type { Config } from '../framework.js';
import type { Finding } from '../analysis/types.js';
import {
  FINDINGS_KEY,
  PROJECT_ROOT_KEY,
  getFindingsTool,
  readSourceTool,
} from './tools.js';

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

export interface CommandReviewerAgentArgs {
  findings: Finding[];
  projectRoot: string;
}

export interface CommandReviewerAgent {
  agent: Agent;
  requestContext: RequestContext;
}

const REVIEWER_AGENT_PROFILE = {
  name: 'LelantosReviewer',
  sections: ['AgentBase.md', 'ReviewerAgent.md'],
  skills: [] as string[],
};

/**
 * Build the reviewer agent for one-shot command invocation. Returns the raw
 * Mastra `Agent` plus a `RequestContext` pre-seeded with `findings` and
 * `projectRoot`, so callers can `agent.stream(prompt, { requestContext })`.
 */
export async function createCommandReviewerAgent(
  ctx: CommandContext<Config>,
  args: CommandReviewerAgentArgs,
): Promise<CommandReviewerAgent> {
  const skillArtifacts = [
    path.join(CLI_ROOT, 'gen', 'skills'),
    path.join(CLI_ROOT, 'dist', 'gen', 'skills'),
  ];
  const skills = readSkills(skillArtifacts);

  const setupCtx: AgentSetupContext<Config> = {
    workdir: ctx.workdir,
    config: ctx.config,
    cliName: CLI_NAME,
    cliVersion: CLI_VERSION,
    context: ctx,
    commands: [],
    skills,
    prompts: {
      artifacts: skillArtifacts,
      agents: {
        'lelantos-reviewer': REVIEWER_AGENT_PROFILE,
      },
    },
  };

  const m = createMastraHelpers(setupCtx);
  if (ctx.config.apiKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = ctx.config.apiKey;
  }

  const agent = createReviewerAgent({
    instructions: m.getAgentInstructions('lelantos-reviewer'),
    model: ctx.config.model,
    apiKey: ctx.config.apiKey,
  });

  const requestContext = new RequestContext();
  requestContext.set(FINDINGS_KEY, args.findings);
  requestContext.set(PROJECT_ROOT_KEY, args.projectRoot);

  return { agent, requestContext };
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
