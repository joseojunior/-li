import { z } from 'zod';
import { pool } from '../db/client.js';
import { publishTrace } from '../queue.js';
import { handoffConversation } from '../services/handoff.js';
import { getProductMedia } from '../services/catalog.js';
import { searchCatalog } from '../services/catalog-search.js';
import { getSalesContext, salesContextUpdateSchema, updateSalesContext } from '../services/sales-context.js';
import type { AgentTool, AgentToolContext, ToolDefinition } from './types.js';

const productSearchSchema = z.object({
  query: z.string().min(2).max(200),
  limit: z.number().int().min(1).max(10).default(5),
  category: z.string().min(1).max(255).optional(),
  tags: z.array(z.string().min(1).max(64)).max(10).optional(),
  maxPriceCents: z.number().int().nonnegative().optional()
});

const productMediaSchema = z.object({ productId: z.string().uuid() });

const handoffSchema = z.object({ reason: z.string().min(3).max(1_000) });

const orderStatusSchema = z.object({
  query: z.string().min(3).max(255).describe('Telefone, CPF, e-mail ou número do pedido informado pelo cliente.')
});

const salesContextSchema = z.object({});

// Fonte única dos contratos das ferramentas. A camada do Agents SDK reutiliza
// estes mesmos schemas; assim o agente nunca ganha uma ferramenta diferente da
// que já é validada, auditada e limitada pelo backend.
export const lilibagToolSchemas = {
  search_products: productSearchSchema,
  get_product_media: productMediaSchema,
  get_sales_context: salesContextSchema,
  update_sales_context: salesContextUpdateSchema,
  handoff_to_human: handoffSchema,
  get_bling_order_status: orderStatusSchema
} as const;

export const lilibagToolDescriptions = {
  search_products: 'Busca produtos disponíveis no catálogo interno da organização, com preço, descrição e mídias.',
  get_product_media: 'Obtém as mídias de um produto específico depois que ele for localizado no catálogo.',
  get_sales_context: 'Obtém a etapa comercial e fatos não sensíveis já confirmados nesta conversa.',
  update_sales_context: 'Registra etapa comercial e fatos não sensíveis confirmados pela cliente.',
  handoff_to_human: 'Transfere a conversa para atendimento humano quando houver compra, CEP, pagamento, situação sensível ou solicitação explícita.',
  get_bling_order_status: 'Consulta status de pedido no Bling usando o identificador fornecido pela cliente.'
} as const;

export type LilibagToolName = keyof typeof lilibagToolSchemas;

class ProductSearchTool implements AgentTool<typeof productSearchSchema> {
  readonly name = 'search_products';
  readonly description = 'Busca produtos disponíveis no catálogo interno da organização, com preço, descrição e mídias.';
  readonly schema = productSearchSchema;
  async execute(context: AgentToolContext, input: z.infer<typeof productSearchSchema>) {
    const products = await searchCatalog({
      organizationId: context.organizationId,
      query: input.query,
      limit: input.limit,
      category: input.category,
      tags: input.tags,
      maxPriceCents: input.maxPriceCents,
      available: true,
      inStock: true
    });
    return { products };
  }
}

class ProductMediaTool implements AgentTool<typeof productMediaSchema> {
  readonly name = 'get_product_media';
  readonly description = 'Obtém as mídias de um produto específico depois que ele for localizado no catálogo.';
  readonly schema = productMediaSchema;
  async execute(context: AgentToolContext, input: z.infer<typeof productMediaSchema>) {
    return { product: await getProductMedia(context.organizationId, input.productId) };
  }
}

class HandoffTool implements AgentTool<typeof handoffSchema> {
  readonly name = 'handoff_to_human';
  readonly description = 'Transfere a conversa para atendimento humano quando houver compra, CEP, pagamento, situação sensível ou solicitação explícita.';
  readonly schema = handoffSchema;
  async execute(context: AgentToolContext, input: z.infer<typeof handoffSchema>) {
    const conversation = await handoffConversation(context.conversationId, { reason: input.reason });
    return { conversationId: conversation.id, status: conversation.status };
  }
}

class BlingOrderStatusTool implements AgentTool<typeof orderStatusSchema> {
  readonly name = 'get_bling_order_status';
  readonly description = 'Consulta status de pedido no Bling usando identificador fornecido pelo cliente.';
  readonly schema = orderStatusSchema;
  async execute(_context: AgentToolContext, input: z.infer<typeof orderStatusSchema>) {
    // Deliberately returns a typed state until OAuth and the direct Bling adapter are enabled.
    return { query: input.query, status: 'integration_not_configured' };
  }
}

class GetSalesContextTool implements AgentTool<typeof salesContextSchema> {
  readonly name = 'get_sales_context';
  readonly description = 'Obtém a etapa comercial e os fatos não sensíveis já confirmados nesta conversa.';
  readonly schema = salesContextSchema;
  async execute(context: AgentToolContext) {
    return { salesContext: await getSalesContext(context.organizationId, context.conversationId) };
  }
}

class UpdateSalesContextTool implements AgentTool<typeof salesContextUpdateSchema> {
  readonly name = 'update_sales_context';
  readonly description = 'Registra apenas etapa comercial e fatos não sensíveis confirmados pela cliente. Nunca inclua CPF, endereço, telefone, e-mail, pagamento ou cartão.';
  readonly schema = salesContextUpdateSchema;
  async execute(context: AgentToolContext, input: z.infer<typeof salesContextUpdateSchema>) {
    return { salesContext: await updateSalesContext(context.organizationId, context.conversationId, input) };
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>([
    ['search_products', new ProductSearchTool()],
    ['get_product_media', new ProductMediaTool()],
    ['get_sales_context', new GetSalesContextTool()],
    ['update_sales_context', new UpdateSalesContextTool()],
    ['handoff_to_human', new HandoffTool()],
    ['get_bling_order_status', new BlingOrderStatusTool()]
  ]);

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodSchemaToJsonSchema(tool.schema)
    }));
  }

  async execute(context: AgentToolContext, name: string, rawInput: unknown): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool) return this.reject(context, name, rawInput, 'tool_not_allowed');
    const input = tool.schema.safeParse(rawInput);
    if (!input.success) return this.reject(context, name, rawInput, 'invalid_tool_input');

    const created = await pool.query<{ id: string }>(
      `INSERT INTO agent_tool_runs (agent_run_id, organization_id, tool_name, input, status)
       VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
      [context.agentRunId, context.organizationId, name, JSON.stringify(input.data)]
    );
    publishTrace({ organizationId: context.organizationId, conversationId: context.conversationId, agentRunId: context.agentRunId, eventType: 'agent.tool_started', status: 'running', detail: { tool: name } });
    try {
      const output = await tool.execute(context, input.data);
      await pool.query(
        `UPDATE agent_tool_runs SET status = 'completed', output = $2, completed_at = now() WHERE id = $1`,
        [created.rows[0].id, JSON.stringify(output)]
      );
      publishTrace({ organizationId: context.organizationId, conversationId: context.conversationId, agentRunId: context.agentRunId, eventType: 'agent.tool_finished', status: 'completed', detail: { tool: name } });
      return output;
    } catch (error) {
      await pool.query(
        `UPDATE agent_tool_runs SET status = 'failed', error_code = $2, completed_at = now() WHERE id = $1`,
        [created.rows[0].id, error instanceof Error ? 'tool_execution_failed' : 'tool_unknown_failure']
      );
      publishTrace({ organizationId: context.organizationId, conversationId: context.conversationId, agentRunId: context.agentRunId, eventType: 'agent.tool_finished', status: 'failed', detail: { tool: name, errorCode: 'tool_execution_failed' } });
      return { error: 'tool_execution_failed' };
    }
  }

  private async reject(context: AgentToolContext, name: string, input: unknown, errorCode: string): Promise<Record<string, unknown>> {
    await pool.query(
      `INSERT INTO agent_tool_runs (agent_run_id, organization_id, tool_name, input, status, error_code, completed_at)
       VALUES ($1, $2, $3, $4, 'rejected', $5, now())`,
      [context.agentRunId, context.organizationId, name, JSON.stringify(input ?? {}), errorCode]
    );
    publishTrace({ organizationId: context.organizationId, conversationId: context.conversationId, agentRunId: context.agentRunId, eventType: 'agent.tool_rejected', status: 'skipped', detail: { tool: name, errorCode } });
    return { error: errorCode };
  }
}

function zodSchemaToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // The provider adapter will translate this portable shape to its native tool schema.
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([name, property]) => [name, { type: zodType(property) }])),
      required: Object.entries(shape).filter(([, property]) => !property.isOptional() && !(property instanceof z.ZodDefault)).map(([name]) => name),
      additionalProperties: false
    };
  }
  return { type: 'object', additionalProperties: false };
}

function zodType(schema: z.ZodType): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  return 'string';
}
