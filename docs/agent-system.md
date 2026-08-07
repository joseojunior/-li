# Sistema de agentes Lilibag

O backend usa o OpenAI Agents SDK como runtime de agentes, mas o sistema de
mensageria continua dono de webhook, fila, conversas, permissões e envio por
outbox.

## Organização do código

```text
apps/api/src/agent-system/
  catalog.ts                    # responsabilidades e permissões dos agentes
  routing.ts                    # escolha determinística da run de entrada
  instructions.ts               # composição de instruções por especialista
  sdk-tools.ts                  # ponte segura para ToolRegistry
  agent-graph.ts                # grafo Agents SDK e agentes como ferramentas
  openai-agents-sdk-provider.ts # provider, chave por organização e execução
  types.ts                      # contratos internos
```

## Especialistas

| Agente | Papel | Ferramentas permitidas |
| --- | --- | --- |
| Atendimento | conversa diretamente com a cliente e mantém o tom Lilibag | contexto comercial, memória comercial, handoff humano |
| Produtos | especialista interno para catálogo, preço, disponibilidade e mídia | busca de produtos, mídia do produto |
| Suporte | especialista interno para pedido e dúvidas operacionais | contexto comercial, status de pedido no Bling |

Produto e Suporte são usados como `Agent.asTool()` pelo Atendimento. Isso é
intencional: eles devolvem fatos para a conversa continuar com uma só voz. A
transferência real de dono da conversa é sempre `handoff_to_human`.

## Sequência

```text
Mensagem consolidada pela fila
  -> lilibag.message.inbound
  -> Atendimento
     -> consultar especialista de Produtos, se necessário
     -> consultar especialista de Suporte, se necessário
     -> handoff humano para compra, pagamento, CEP ou caso sensível
  -> outbox do canal
```

## Segurança e observabilidade

- Todas as ferramentas passam pelo `ToolRegistry`; schemas Zod, isolamento por
  organização e auditoria em `agent_tool_runs` são reaproveitados.
- Sem chave, o provider retorna `waiting_configuration` e não faz chamada à
  OpenAI.
- O runtime usa Prompt Cache explícito com TTL de 30 minutos. O painel continua
  sendo o trace operacional e não envia conteúdo de clientes para tracing remoto
  por padrão.
- A chave salva por organização só é decifrada dentro do worker, quando houver
  `DATA_ENCRYPTION_KEY` válida.

## Próximos incrementos

1. Persistir `lastResponseId` por conversa para continuidade de sessão.
2. Converter a resposta final do agente em intenção de outbox aprovada.

## Decisão e entrega para a cliente

O agente de atendimento não pode devolver uma URL ou chamar o ChatAI. Seu
resultado final é validado como uma decisão `reply` ou `handoff`, com texto e,
opcionalmente, até dois IDs de produtos. A API busca esses IDs apenas no
catálogo da própria organização, resolve no máximo quatro imagens HTTPS
autorizadas e grava a mensagem e o evento `message.send` na mesma transação.
O worker de outbox é o único componente que envia texto e imagens ao ChatAI.

Assim, uma URL inventada pelo modelo, uma foto de outra organização ou um envio
duplicado não atravessam a fronteira do agente.
3. Expor versões de prompts e runs no painel administrativo.
4. Adicionar avaliações com cenários de produto, suporte, venda e handoff.
