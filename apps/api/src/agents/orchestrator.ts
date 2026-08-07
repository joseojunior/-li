import type { AgentInput, AgentProvider, AgentResult, ToolDefinition } from './types.js';
import { ToolRegistry } from './tools.js';

export class DisabledAgentProvider implements AgentProvider {
  readonly name = 'disabled';
  async run(input: AgentInput, _tools: ToolDefinition[], _executeTool: (name: string, input: unknown) => Promise<Record<string, unknown>>): Promise<AgentResult> {
    return {
      status: 'waiting_configuration',
      provider: null,
      model: null,
      promptVersion: input.promptVersion ?? null,
      output: { reason: 'ai_provider_not_configured', playbookLoaded: Boolean(input.instructions) }
    };
  }
}

export class AgentOrchestrator {
  constructor(private readonly provider: AgentProvider, private readonly tools: ToolRegistry) {}

  async run(input: AgentInput): Promise<AgentResult> {
    return this.provider.run(input, this.tools.definitions(), (name, argumentsValue) => this.executeTool(input, name, argumentsValue));
  }

  async executeTool(input: AgentInput, name: string, argumentsValue: unknown): Promise<Record<string, unknown>> {
    return this.tools.execute({
      agentRunId: input.runId,
      organizationId: input.organizationId,
      conversationId: input.conversationId
    }, name, argumentsValue);
  }
}
