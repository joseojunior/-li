import { z } from 'zod';
import { pool, withTransaction } from '../db/client.js';
import { handoffConversation } from './handoff.js';

export const salesStageSchema = z.enum(['discovery', 'context', 'pain', 'consequence', 'ideal', 'recommendation', 'choice', 'pricing', 'freight', 'checkout', 'after_sales', 'human', 'sensitive']);
export const salesIntentSchema = z.enum(['unknown', 'product_discovery', 'price', 'discount', 'freight', 'checkout', 'payment', 'order_status', 'after_sales', 'partnership', 'wholesale', 'sensitive_loss']);

export const salesContextUpdateSchema = z.object({
  stage: salesStageSchema.optional(),
  intent: salesIntentSchema.optional(),
  facts: z.record(z.string(), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(20)])).default({}),
  lastAgentQuestion: z.string().max(1_000).optional()
}).refine((value) => value.stage !== undefined || value.intent !== undefined || Object.keys(value.facts).length > 0 || value.lastAgentQuestion !== undefined, 'Informe uma atualização de contexto.');

type SalesIntent = z.infer<typeof salesIntentSchema>;

export async function getSalesContext(organizationId: string, conversationId: string) {
  const result = await pool.query(
    `SELECT conversation_id, stage, intent, facts, last_agent_question, updated_at
       FROM conversation_sales_contexts
      WHERE organization_id = $1 AND conversation_id = $2`,
    [organizationId, conversationId]
  );
  return result.rows[0] ?? { conversation_id: conversationId, stage: 'discovery', intent: 'unknown', facts: {}, last_agent_question: null };
}

export async function updateSalesContext(organizationId: string, conversationId: string, input: z.infer<typeof salesContextUpdateSchema>) {
  const parsedFacts = rejectSensitiveFacts(input.facts);
  const result = await pool.query(
    `INSERT INTO conversation_sales_contexts (conversation_id, organization_id, stage, intent, facts, last_agent_question)
     VALUES ($1, $2, COALESCE($3, 'discovery'), COALESCE($4, 'unknown'), $5, $6)
     ON CONFLICT (conversation_id) DO UPDATE
       SET stage = COALESCE($3, conversation_sales_contexts.stage),
           intent = COALESCE($4, conversation_sales_contexts.intent),
           facts = conversation_sales_contexts.facts || EXCLUDED.facts,
           last_agent_question = COALESCE($6, conversation_sales_contexts.last_agent_question),
           updated_at = now()
     RETURNING conversation_id, stage, intent, facts, last_agent_question, updated_at`,
    [conversationId, organizationId, input.stage ?? null, input.intent ?? null, JSON.stringify(parsedFacts), input.lastAgentQuestion ?? null]
  );
  return result.rows[0];
}

export async function applyLilibagSafetyPolicy(input: { organizationId: string; conversationId: string; messageId: string; body: string | null }): Promise<{ handoff: boolean; reason?: string; intent: SalesIntent }> {
  const intent = detectIntent(input.body);
  if (intent === 'sensitive_loss') {
    await updateSalesContext(input.organizationId, input.conversationId, { stage: 'sensitive', intent, facts: {} });
    await attachSystemTag(input.organizationId, input.conversationId, 'sensitive-loss', 'Situação delicada');
    await handoffConversation(input.conversationId, { reason: 'Situação delicada identificada pelo guia de atendimento' });
    return { handoff: true, reason: 'sensitive_loss', intent };
  }
  if (containsSensitiveCheckoutData(input.body)) {
    await updateSalesContext(input.organizationId, input.conversationId, { stage: 'human', intent: 'checkout', facts: {} });
    await attachSystemTag(input.organizationId, input.conversationId, 'human-checkout', 'Dados de pedido');
    await handoffConversation(input.conversationId, { reason: 'Dados sensíveis ou formalização de pedido exigem atendimento humano' });
    return { handoff: true, reason: 'sensitive_checkout_data', intent: 'checkout' };
  }
  if (['partnership', 'wholesale', 'after_sales', 'order_status', 'payment'].includes(intent)) {
    await updateSalesContext(input.organizationId, input.conversationId, { stage: 'human', intent, facts: {} });
    await attachSystemTag(input.organizationId, input.conversationId, 'human-operations', 'Atendimento operacional');
    await handoffConversation(input.conversationId, { reason: `Assunto ${intent} direcionado para a equipe responsável` });
    return { handoff: true, reason: intent, intent };
  }
  const current = await getSalesContext(input.organizationId, input.conversationId);
  if (current.intent === 'unknown' && intent !== 'unknown') {
    await updateSalesContext(input.organizationId, input.conversationId, { intent, stage: initialStageForIntent(intent), facts: {} });
  }
  return { handoff: false, intent };
}

function detectIntent(body: string | null): SalesIntent {
  const value = normalize(body);
  if (!value) return 'unknown';
  if (/perdi (meu )?bebe|perda gestacional|aborto|luto|meu bebe faleceu|falecimento/.test(value)) return 'sensitive_loss';
  if (/parceria|influenciadora|criadora de conteudo|creator/.test(value)) return 'partnership';
  if (/atacado|revenda|revender|quantidade de unidades/.test(value)) return 'wholesale';
  if (/devolucao|devolver|troca|defeito|descascou|pos venda/.test(value)) return 'after_sales';
  if (/rastreio|status.*pedido|meu pedido|pedido.*atras/.test(value)) return 'order_status';
  if (/pix|cartao|cartao|pagamento|link de pagamento/.test(value)) return 'payment';
  if (/cep|frete|entrega|prazo/.test(value)) return 'freight';
  if (/desconto|caro|promocao|promocao/.test(value)) return 'discount';
  if (/quanto|preco|valor|custa/.test(value)) return 'price';
  return 'product_discovery';
}

function initialStageForIntent(intent: SalesIntent): z.infer<typeof salesStageSchema> {
  if (intent === 'price' || intent === 'discount') return 'context';
  if (intent === 'freight') return 'freight';
  if (intent === 'payment' || intent === 'checkout') return 'checkout';
  if (intent === 'after_sales' || intent === 'order_status') return 'after_sales';
  return 'discovery';
}

function containsSensitiveCheckoutData(body: string | null): boolean {
  const value = normalize(body);
  return /\bcpf\b|\bnumero do cartao\b|\bchave pix\b|\bendereco completo\b|\bru[a\.]?\s+[^\n]{8,}/.test(value);
}

function rejectSensitiveFacts(facts: Record<string, unknown>): Record<string, unknown> {
  const blocked = /(cpf|endereco|address|cartao|card|email|telefone|phone|pix|pagamento)/i;
  if (Object.keys(facts).some((key) => blocked.test(key))) throw new Error('sales_context_sensitive_fact_not_allowed');
  return facts;
}

function normalize(value: string | null): string {
  return (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

async function attachSystemTag(organizationId: string, conversationId: string, slug: string, name: string): Promise<void> {
  await withTransaction(async (client) => {
    const tag = await client.query<{ id: string }>(
      `INSERT INTO tags (organization_id, scope, slug, name)
       VALUES ($1, 'conversation', $2, $3)
       ON CONFLICT (organization_id, scope, slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [organizationId, slug, name]
    );
    await client.query(
      `INSERT INTO tag_assignments (organization_id, tag_id, subject_type, subject_id, source)
       VALUES ($1, $2, 'conversation', $3, 'rule')
       ON CONFLICT (tag_id, subject_type, subject_id) DO UPDATE SET source = 'rule'`,
      [organizationId, tag.rows[0].id, conversationId]
    );
  });
}
