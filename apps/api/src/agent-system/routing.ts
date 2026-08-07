import { inboundMessageRun } from './catalog.js';
import type { AgentRunDefinition } from './types.js';

// O roteamento de entrada é determinístico. Especialistas não substituem o
// atendimento: eles são chamados como agentes-ferramenta durante a execução.
// Isso mantém uma voz única para a cliente e evita handoffs internos confusos.
export function selectLilibagAgentRun(): AgentRunDefinition {
  return inboundMessageRun;
}
