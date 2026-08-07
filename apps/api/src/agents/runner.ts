import { AgentOrchestrator, DisabledAgentProvider } from './orchestrator.js';
import { OpenAiAgentsSdkProvider } from '../agent-system/openai-agents-sdk-provider.js';
import { ToolRegistry } from './tools.js';
import type { AgentInput, AgentResult } from './types.js';

export type { AgentInput, AgentResult } from './types.js';

/**
 * Intentional safety default: no customer response is produced until a provider
 * is configured. The same tool registry will be used after activation.
 */
export class UnconfiguredAgentRunner {
  private readonly orchestrator = new AgentOrchestrator(new DisabledAgentProvider(), new ToolRegistry());
  run(input: AgentInput): Promise<AgentResult> {
    return this.orchestrator.run(input);
  }
}

// Mantém o mesmo contrato do runner anterior, mas troca o provider quando uma
// chave estiver configurada. Sem chave, o provider retorna waiting_configuration
// e nenhuma chamada externa é feita.
export class LilibagAgentRunner {
  private readonly orchestrator = new AgentOrchestrator(new OpenAiAgentsSdkProvider(), new ToolRegistry());
  run(input: AgentInput): Promise<AgentResult> {
    return this.orchestrator.run(input);
  }
}
