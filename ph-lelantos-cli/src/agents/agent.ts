import type { AgentProvider, AgentSetupContext, StreamChunk } from '@powerhousedao/ph-clint';
import type { Config } from '../framework.js';

/**
 * Demo agent — deterministic echo responses. Replace with a real Mastra
 * `Agent` once you've wired your model + tools.
 */
function createDemoAgent(): AgentProvider {
  return {
    id: 'ph-lelantos',
    async *stream(prompt) {
      yield {
        type: 'text-delta',
        text: `You said: ${prompt}\n(demo mode — set an API key and replace createDemoAgent with a Mastra Agent)`,
      } satisfies StreamChunk;
    },
  };
}

/**
 * Agent factory invoked by `cli.configureAgent`. Receives the resolved
 * config and workdir; return an AgentProvider.
 */
export async function createAgent(
  _ctx: AgentSetupContext<Config>,
): Promise<AgentProvider> {
  return createDemoAgent();
}
