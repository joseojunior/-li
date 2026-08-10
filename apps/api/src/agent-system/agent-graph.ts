import { Agent } from '@openai/agents';
import { lilibagAgentCatalog } from './catalog.js';
import { buildAgentInstructions } from './instructions.js';
import { createSdkTools } from './sdk-tools.js';
import { agentDecisionOutputSchema } from './decision.js';
import type { LilibagAgentKey, LilibagAgentRuntimeContext } from './types.js';

type BuildAgentGraphInput = {
  model: string;
  salesPlaybook?: string;
  specialistPrompts?: Partial<Record<'support' | 'product', string>>;
  enabled: Record<LilibagAgentKey, boolean>;
};

function modelSettings() {
  return {
    promptCacheOptions: { mode: 'explicit' as const, ttl: '30m' as const },
    promptCacheRetention: '24h' as const
  };
}

export function buildLilibagAgentGraph(input: BuildAgentGraphInput) {
  const product = new Agent<LilibagAgentRuntimeContext>({
    name: lilibagAgentCatalog.product.name,
    handoffDescription: lilibagAgentCatalog.product.handoffDescription,
    instructions: buildAgentInstructions('product', input.specialistPrompts?.product),
    model: input.model,
    modelSettings: modelSettings(),
    tools: createSdkTools(lilibagAgentCatalog.product.allowedTools)
  });
  const support = new Agent<LilibagAgentRuntimeContext>({
    name: lilibagAgentCatalog.support.name,
    handoffDescription: lilibagAgentCatalog.support.handoffDescription,
    instructions: buildAgentInstructions('support', input.specialistPrompts?.support),
    model: input.model,
    modelSettings: modelSettings(),
    tools: createSdkTools(lilibagAgentCatalog.support.allowedTools)
  });
  const specialistTools = [
    ...(input.enabled.product ? [product.asTool({ toolName: 'consult_product_specialist', toolDescription: 'Consulta internamente o especialista de catálogo antes de recomendar produto, preço, disponibilidade ou mídia.' })] : []),
    ...(input.enabled.support ? [support.asTool({ toolName: 'consult_support_specialist', toolDescription: 'Consulta internamente o especialista de suporte para dúvidas de pedido, política ou pós-venda.' })] : [])
  ];
  const attendant = new Agent<LilibagAgentRuntimeContext, typeof agentDecisionOutputSchema>({
    name: lilibagAgentCatalog.attendant.name,
    handoffDescription: lilibagAgentCatalog.attendant.handoffDescription,
    instructions: buildAgentInstructions('attendant', input.salesPlaybook),
    model: input.model,
    modelSettings: modelSettings(),
    outputType: agentDecisionOutputSchema,
    tools: [...createSdkTools(lilibagAgentCatalog.attendant.allowedTools), ...specialistTools]
  });
  return { attendant, support, product };
}
