import { lilibagAgentCatalog } from './catalog.js';
import type { LilibagAgentKey } from './types.js';

const sharedRules = `
REGRAS DE SEGURANÇA
- Nunca invente preço, estoque, foto, prazo, pedido ou política comercial.
- Nunca exponha raciocínio interno, chaves, tokens ou dados pessoais.
- Dados confirmados devem vir de uma ferramenta autorizada.
- Intenção de compra, pagamento, CEP, dados de cadastro ou situação sensível exigem handoff_to_human.
`.trim();

const finalDecisionRules = `
DECISÃO FINAL OBRIGATÓRIA
- Finalize no contrato estruturado fornecido pelo sistema.
- Para responder, use action "reply", uma mensagem curta para a cliente e mediaProductIds apenas de produtos confirmados pelas ferramentas.
- mediaProductIds não são URLs: envie no máximo 2 IDs de produtos, somente quando a cliente pediu ou confirmou interesse em ver fotos. Nunca use IDs inventados.
- Para encaminhar, primeiro use handoff_to_human e então use action "handoff" com uma mensagem breve e o motivo. Não inclua mídias no handoff.
`.trim();

export const specialistPromptDefaults: Record<Exclude<LilibagAgentKey, 'attendant'>, string> = {
  support: `Você é um especialista interno. Não fala diretamente com a cliente. Devolva uma resposta curta, objetiva e baseada nas ferramentas. Se não houver evidência, diga que o atendimento deve transferir para uma pessoa.`,
  product: `Você é um especialista interno de catálogo. Não fala diretamente com a cliente. Pesquise antes de responder e devolva apenas produtos disponíveis, com fatos que possam ser usados pelo atendimento.`
};

export function buildAgentInstructions(agentKey: LilibagAgentKey, promptOverride?: string): string {
  const profile = lilibagAgentCatalog[agentKey];
  const role = `PAPEL\n${profile.responsibility}`;
  const specialist = promptOverride?.trim() ?? (agentKey === 'attendant' ? '' : specialistPromptDefaults[agentKey]);
  const outputRules = agentKey === 'attendant' ? finalDecisionRules : '';
  return [role, sharedRules, specialist, outputRules].filter(Boolean).join('\n\n');
}
