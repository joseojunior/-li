import { z } from 'zod';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/client.js';
import { encryptSecret } from '../security/encryption.js';

export const agentKeySchema = z.enum(['attendant', 'support', 'product']);
export const agentModelSchema = z.enum(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
export const agentConfigurationInputSchema = z.object({
  model: agentModelSchema,
  enabled: z.boolean().default(true)
});
export const openAiKeyInputSchema = z.object({ apiKey: z.string().min(20).max(1_000) });
export const promptTestInputSchema = z.object({
  agentKey: agentKeySchema,
  message: z.string().min(1).max(4_000)
});

type AgentKey = z.infer<typeof agentKeySchema>;

const defaults: Record<AgentKey, { model: z.infer<typeof agentModelSchema>; enabled: boolean; label: string; responsibility: string }> = {
  attendant: { model: 'gpt-5.6-luna', enabled: true, label: 'Atendimento', responsibility: 'Conduz a conversa e decide quando consultar especialistas ou transferir para humano.' },
  support: { model: 'gpt-5.6-luna', enabled: true, label: 'Suporte', responsibility: 'Responde dúvidas aprovadas para o agente de atendimento; não fala diretamente com a cliente.' },
  product: { model: 'gpt-5.6-luna', enabled: true, label: 'Produtos', responsibility: 'Pesquisa catálogo, disponibilidade e mídias; devolve fatos estruturados.' }
};

export async function getAiConfiguration(organizationId: string) {
  const [provider, agents] = await Promise.all([
    pool.query<{ configured_at: Date | null }>(
      `SELECT configured_at FROM ai_provider_connections WHERE organization_id = $1 AND api_key_ciphertext IS NOT NULL`,
      [organizationId]
    ),
    pool.query<{ agent_key: AgentKey; model: z.infer<typeof agentModelSchema>; enabled: boolean; updated_at: Date }>(
      `SELECT agent_key, model, enabled, updated_at FROM agent_configurations WHERE organization_id = $1`,
      [organizationId]
    )
  ]);
  const configured = Boolean(provider.rowCount) || Boolean(config.OPENAI_API_KEY);
  const stored = new Map(agents.rows.map((row) => [row.agent_key, row]));
  return {
    provider: {
      name: 'openai' as const,
      configured,
      source: provider.rowCount ? 'organization' : config.OPENAI_API_KEY ? 'environment' : 'none',
      configuredAt: provider.rows[0]?.configured_at?.toISOString() ?? null
    },
    agents: (Object.keys(defaults) as AgentKey[]).map((key) => ({
      key,
      ...defaults[key],
      model: stored.get(key)?.model ?? defaults[key].model,
      enabled: stored.get(key)?.enabled ?? defaults[key].enabled,
      updatedAt: stored.get(key)?.updated_at.toISOString() ?? null
    }))
  };
}

export async function saveOpenAiKey(organizationId: string, input: z.infer<typeof openAiKeyInputSchema>) {
  const encrypted = encryptSecret(input.apiKey.trim());
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO ai_provider_connections (organization_id, api_key_ciphertext, api_key_iv, api_key_auth_tag, configured_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (organization_id) DO UPDATE
         SET api_key_ciphertext = EXCLUDED.api_key_ciphertext, api_key_iv = EXCLUDED.api_key_iv,
             api_key_auth_tag = EXCLUDED.api_key_auth_tag, configured_at = now(), updated_at = now()`,
      [organizationId, encrypted.ciphertext, encrypted.iv, encrypted.authTag]
    );
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id)
       VALUES ($1, 'user', 'ai.openai_key_saved', 'ai_provider_connection', $1)`,
      [organizationId]
    );
  });
  return { configured: true };
}

export async function updateAgentConfiguration(organizationId: string, agentKey: AgentKey, input: z.infer<typeof agentConfigurationInputSchema>) {
  const result = await pool.query(
    `INSERT INTO agent_configurations (organization_id, agent_key, model, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, agent_key) DO UPDATE
       SET model = EXCLUDED.model, enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING agent_key AS key, model, enabled, updated_at AS "updatedAt"`,
    [organizationId, agentKey, input.model, input.enabled]
  );
  await pool.query(
    `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id, detail)
     VALUES ($1, 'user', 'ai.agent_configuration_updated', 'agent_configuration', $2, $3)`,
    [organizationId, agentKey, JSON.stringify({ model: input.model, enabled: input.enabled })]
  );
  return result.rows[0];
}

/** Temporary, explicit test gate. It never calls a provider until the Agents SDK runtime is enabled. */
export async function testAgentPrompt(organizationId: string, input: z.infer<typeof promptTestInputSchema>) {
  const configuration = await getAiConfiguration(organizationId);
  const agent = configuration.agents.find((item) => item.key === input.agentKey)!;
  if (!configuration.provider.configured) {
    return { status: 'waiting_configuration' as const, agentKey: input.agentKey, model: agent.model, reason: 'openai_api_key_not_configured' };
  }
  if (!agent.enabled) {
    return { status: 'waiting_configuration' as const, agentKey: input.agentKey, model: agent.model, reason: 'agent_disabled' };
  }
  return { status: 'waiting_configuration' as const, agentKey: input.agentKey, model: agent.model, reason: 'agents_sdk_runtime_not_enabled' };
}
