/**
 * Mastra Studio entry point — placeholder. Enable the `mastra` feature to
 * populate this file. Until then `mastra:*` scripts are effectively no-ops.
 */
// @clint:begin mastra-index
// @clint:end mastra-index

import fs from 'node:fs';
import path from 'node:path';
import {
  resolveWorkdir,
  resolveConfig,
  createWorkdirStore,
  installSkills,
  readSkills,
  type AgentSetupContext,
} from '@powerhousedao/ph-clint';
import {
  createMastraHelpers,
  getMastraPaths,
} from '@powerhousedao/ph-clint/mastra';
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { CLI_NAME, CLI_ROOT, CLI_VERSION } from '../config.js';
import { configSchema, secretsSchema, type Config } from '../framework.js';
import { cli } from '../cli.js';
import { createReviewerAgent } from '../agents/agent.js';

const workdir = resolveWorkdir({ fallback: CLI_ROOT });
const config = resolveConfig({
  configSchema: configSchema.extend(secretsSchema.shape),
  cliName: CLI_NAME,
  workdir,
}) as Config;
const store = createWorkdirStore(workdir, CLI_NAME);
const paths = getMastraPaths(store);

if (config.apiKey && !process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = config.apiKey;
}

fs.mkdirSync(paths.dbFolder, { recursive: true });

const actualRoot =
  path.basename(CLI_ROOT) === '.mastra' ? path.dirname(CLI_ROOT) : CLI_ROOT;
const skillArtifacts = [
  path.join(actualRoot, 'gen', 'skills'),
  path.join(actualRoot, 'dist', 'gen', 'skills'),
];

installSkills({ store, skillArtifacts });
const skills = readSkills(skillArtifacts);

const commands = cli.listCommands();
const studioContext = {
  workdir,
  workspace: store,
  config,
  stdout: console.log,
};

const agentCtx: AgentSetupContext<Config> = {
  workdir,
  config,
  cliName: CLI_NAME,
  cliVersion: CLI_VERSION,
  context: studioContext as never,
  commands,
  skills,
  prompts: {
    artifacts: skillArtifacts,
    agents: {
      'lelantos-reviewer': {
        name: 'LelantosReviewer',
        sections: ['AgentBase.md', 'ReviewerAgent.md'],
        skills: [],
      },
    },
  },
};

const m = createMastraHelpers(agentCtx);

const lelantosReviewer = createReviewerAgent({
  instructions: m.getAgentInstructions('lelantos-reviewer'),
  model: config.model,
  apiKey: config.apiKey,
  workspace: await m.createWorkspace(),
  memory: await m.createMemory(),
});

export const mastra = new Mastra({
  agents: { lelantosReviewer },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    url: `file:${paths.dbPath}`,
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
