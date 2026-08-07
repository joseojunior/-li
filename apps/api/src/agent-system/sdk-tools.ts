import { tool, type Tool } from '@openai/agents';
import { lilibagToolDescriptions, lilibagToolSchemas, type LilibagToolName } from '../agents/tools.js';
import type { LilibagAgentRuntimeContext } from './types.js';

export function createSdkTools(names: readonly LilibagToolName[]): Tool<LilibagAgentRuntimeContext>[] {
  return names.map((name) => tool({
    name,
    description: lilibagToolDescriptions[name],
    parameters: lilibagToolSchemas[name],
    strict: true,
    timeoutMs: 15_000,
    execute: async (argumentsValue, runContext) => {
      const context = runContext?.context;
      if (!context) return { error: 'agent_runtime_context_missing' };
      return context.executeTool(name, argumentsValue);
    }
  }));
}
