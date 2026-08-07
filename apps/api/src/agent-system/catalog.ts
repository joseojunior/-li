import type { AgentProfileDefinition, AgentRunDefinition, LilibagAgentKey } from './types.js';

// Este catálogo é a fonte de verdade do código para responsabilidades e
// permissões. Configurações por organização (modelo e ativação) continuam no
// banco e no painel administrativo.
export const lilibagAgentCatalog: Record<LilibagAgentKey, AgentProfileDefinition> = {
  attendant: {
    key: 'attendant',
    name: 'Lilibag Atendimento',
    handoffDescription: 'Conduz a conversa de venda, entende o contexto e pede apoio aos especialistas quando necessário.',
    responsibility: 'É o único agente que conversa diretamente com a cliente e preserva o tom comercial da Lilibag.',
    allowedTools: ['get_sales_context', 'update_sales_context', 'handoff_to_human']
  },
  support: {
    key: 'support',
    name: 'Lilibag Suporte',
    handoffDescription: 'Esclarece dúvidas de suporte, pedidos e políticas usando apenas dados e ferramentas permitidos.',
    responsibility: 'Atua internamente como especialista; devolve fatos e orientação para o agente de atendimento.',
    allowedTools: ['get_sales_context', 'get_bling_order_status']
  },
  product: {
    key: 'product',
    name: 'Lilibag Produtos',
    handoffDescription: 'Pesquisa catálogo, disponibilidade, preço e mídias para embasar uma recomendação.',
    responsibility: 'Atua internamente como especialista de catálogo; nunca inventa dados comerciais ou de estoque.',
    allowedTools: ['search_products', 'get_product_media']
  }
};

export const inboundMessageRun: AgentRunDefinition = {
  id: 'lilibag.message.inbound',
  entryAgent: 'attendant',
  workflowName: 'lilibag_attendance',
  maxTurns: 8
};
