import { OpenAIProvider, Runner } from '@openai/agents';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { decryptSecret } from '../security/encryption.js';
import { getAiConfiguration } from '../services/agent-configuration.js';
import type { AgentInput, AgentProvider, AgentResult, ToolDefinition, ToolExecutor } from '../agents/types.js';
import { buildLilibagAgentGraph } from './agent-graph.js';
import { parseAgentDecision } from './decision.js';
import { selectLilibagAgentRun } from './routing.js';
import type { AgentRuntimeAvailability, LilibagAgentKey } from './types.js';

export class OpenAiAgentsSdkProvider implements AgentProvider {
  readonly name = 'openai_agents_sdk';

  async run(input: AgentInput, _tools: ToolDefinition[], executeTool: ToolExecutor): Promise<AgentResult> {
    const availability = await resolveAgentRuntime(input.organizationId);
    if (!availability.available) {
      return {
        status: 'waiting_configuration', provider: null, model: null, promptVersion: input.promptVersion ?? null,
        output: { reason: availability.reason, runtime: this.name }
      };
    }

    const runDefinition = selectLilibagAgentRun();
    const graph = buildLilibagAgentGraph({
      model: availability.model,
      salesPlaybook: input.instructions,
      specialistPrompts: input.specialistPrompts,
      enabled: availability.enabled
    });
    const modelProvider = new OpenAIProvider({ apiKey: availability.apiKey, useResponses: true, strictFeatureValidation: true });
    const runner = new Runner({
      modelProvider,
      // O painel Lilibag é a fonte operacional do trace. Evitamos enviar texto
      // de clientes para um exportador de trace externo por padrão.
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      workflowName: runDefinition.workflowName
    });

    try {
      const result = await runner.run(graph.attendant, formatAgentInput(input), {
        context: { organizationId: input.organizationId, conversationId: input.conversationId, agentRunId: input.runId, executeTool },
        maxTurns: runDefinition.maxTurns
      });
      const decision = parseAgentDecision(result.finalOutput);
      return {
        status: 'completed',
        provider: this.name,
        model: availability.model,
        promptVersion: input.promptVersion ?? null,
        output: {
          decision,
          responseId: result.lastResponseId ?? null,
          finalAgent: result.lastAgent?.name ?? lilibagAgentKeyFallback(),
          runKey: runDefinition.id
        }
      };
    } catch (error) {
      return {
        status: 'failed', provider: this.name, model: availability.model, promptVersion: input.promptVersion ?? null,
        output: { runKey: runDefinition.id }, errorCode: 'agents_sdk_run_failed',
        errorDetail: error instanceof Error ? error.message.slice(0, 500) : 'unknown_agent_runtime_failure'
      };
    } finally {
      await modelProvider.close();
    }
  }
}

async function resolveAgentRuntime(organizationId: string): Promise<AgentRuntimeAvailability> {
  const configuration = await getAiConfiguration(organizationId);
  const enabled = Object.fromEntries(configuration.agents.map((agent) => [agent.key, agent.enabled])) as Record<LilibagAgentKey, boolean>;
  const attendant = configuration.agents.find((agent) => agent.key === 'attendant');
  if (!attendant?.enabled) return { available: false, reason: 'agent_disabled' };

  const stored = await pool.query<{ api_key_ciphertext: string; api_key_iv: string; api_key_auth_tag: string }>(
    `SELECT api_key_ciphertext, api_key_iv, api_key_auth_tag FROM ai_provider_connections
      WHERE organization_id = $1 AND api_key_ciphertext IS NOT NULL`,
    [organizationId]
  );
  if (stored.rowCount) {
    try {
      return { available: true, apiKey: decryptSecret({ ciphertext: stored.rows[0].api_key_ciphertext, iv: stored.rows[0].api_key_iv, authTag: stored.rows[0].api_key_auth_tag }), model: attendant.model, enabled };
    } catch {
      return { available: false, reason: 'data_encryption_key_not_configured' };
    }
  }
  if (!config.OPENAI_API_KEY) return { available: false, reason: 'openai_api_key_not_configured' };
  return { available: true, apiKey: config.OPENAI_API_KEY, model: attendant.model, enabled };
}

function formatAgentInput(input: AgentInput): string {
  const history = input.messages.map((message) => `${message.direction === 'inbound' ? 'CLIENTE' : 'EQUIPE'}: ${message.body ?? `[${message.type}]`}`).join('\n');
  return `Conversa consolidada:\n${history}\n\nResponda somente ao que foi dito pela cliente e use especialistas ou ferramentas quando necessário.`;
}

function lilibagAgentKeyFallback() { return 'Lilibag Atendimento'; }
