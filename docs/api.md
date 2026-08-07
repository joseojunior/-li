# Contrato inicial da API

Todas as rotas retornam JSON. O endpoint de entrada aceita reentregas: o mesmo `idempotencyKey` retorna `202` e não cria outra mensagem.

## Administração interna

Envie `x-admin-api-key` nas chamadas abaixo.

| Método | Rota | Finalidade |
| --- | --- | --- |
| `POST` | `/v1/admin/organizations` | cria um tenant/loja |
| `POST` | `/v1/admin/organizations/{id}/bling/connection` | cadastra client ID e segredo Bling cifrados |
| `POST` | `/v1/admin/channels` | cadastra um canal de atendimento |
| `GET` | `/v1/admin/conversations?organizationId={uuid}` | lista conversas recentes |
| `POST` | `/v1/admin/conversations/{id}/handoff` | pausa o agente e entrega a um humano |
| `POST` | `/v1/admin/conversations/{id}/resume` | devolve a conversa à automação |
| `POST` | `/v1/admin/conversations/{id}/messages` | coloca uma mensagem manual na outbox |
| `POST` | `/v1/admin/products` | cadastra produto no catálogo interno |
| `GET` | `/v1/admin/products?organizationId={uuid}&q=...` | pesquisa catálogo e mídias |
| `POST` | `/v1/admin/bling/sync-catalog` | solicita sincronização futura do Bling |
| `POST` | `/v1/admin/outbox/{id}/retry` | reenvia evento que falhou ou espera configuração |
| `GET` | `/v1/admin/queues` | mostra a pressão da fila de conversa |

Exemplo para criar a organização:

```json
{
  "name": "Lilibag",
  "slug": "lilibag"
}
```

Em seguida, cadastre o canal:

```json
{
  "organizationId": "uuid-da-organizacao",
  "provider": "whatsapp",
  "externalId": "numero-ou-id-do-canal",
  "displayName": "WhatsApp principal"
}
```

## Canais do painel

Para `owner` e `admin` autenticados:

- `GET /v1/panel/channels` lista os canais da organização e o estado de conexão.
- `POST /v1/panel/channels` cria um canal ChatAI com `displayName` e `externalId` opcional.
- `GET /v1/panel/traces` e `GET /v1/panel/traces/summary` expõem o trace operacional para `owner` e `admin`, sem conteúdo de mensagens, tokens ou credenciais.
- `POST /v1/panel/channels/{channelId}/chatai` cifra o token, ativa a conexão e devolve a URL do webhook uma única vez.

O webhook direto do ChatAI é `POST /v1/webhooks/chatai/{channelId}/{callbackToken}`. O callback token é aleatório por configuração, nunca é persistido em texto e deve ser copiado na resposta de criação.

## Tags e roteamento

Rotas administrativas com `x-admin-api-key`:

- `POST /v1/admin/tags` cria uma tag com `organizationId`, `scope`, `slug`, `name` e `color` opcional.
- `GET /v1/admin/tags?organizationId=...&scope=conversation` lista as tags.
- `POST /v1/admin/conversations/{conversationId}/tags` atribui uma tag de conversa.
- `POST /v1/admin/routing-policies` cria uma política determinística de roteamento.

O painel possui as equivalentes autenticadas em `/v1/panel/tags`, `/v1/panel/conversations/{conversationId}/tags` e `/v1/panel/routing-policies`. Apenas `owner` e `admin` criam tags e políticas; `agent` pode atribuir ou remover tags de conversas.

Uma política possui `conditions` (canal, tipo de mensagem, todas ou qualquer tag de conversa) e uma `action`: `continue`, `handoff` ou `pause_automation`. A primeira política ativa por prioridade vence.

## Playbook comercial do agente

`GET /v1/panel/agent/playbook` mostra a versão ativa do playbook Lilibag para `owner` e `admin`. Para organizações existentes antes desta funcionalidade, `POST /v1/panel/agent/playbook/bootstrap` cria a primeira versão. O contexto comercial de uma conversa pode ser consultado por `GET /v1/panel/conversations/{conversationId}/sales-context`.

## Entrada de mensagens

`POST /v1/webhooks/channels/{channelId}/inbound`

O adaptador direto do provedor valida a assinatura original do webhook, normaliza o evento e chama este contrato interno. Nenhum workflow externo participa do fluxo.

```json
{
  "idempotencyKey": "whatsapp:message-id-unico",
  "externalMessageId": "message-id-unico",
  "externalContactId": "5511999999999",
  "contact": {
    "name": "Cliente",
    "phoneE164": "+5511999999999"
  },
  "type": "text",
  "body": "Quero ver bolsas pretas",
  "media": [],
  "metadata": {
    "source": "whatsapp-provider"
  }
}
```

O backend registra o evento e a mensagem na mesma transação e só então agenda a conversa. A resposta normal é `202 Accepted`.

## ChatAI direto

O ChatAI deve chamar `POST /v1/webhooks/chatai/{channelId}/{callbackToken}`. O token de callback é gerado quando a conexão é cadastrada e a rota aceita o envelope do ChatAI e o payload oficial da Meta já encaminhado por ele; o formato é normalizado internamente.

Para cadastrar a conexão de saída, use `POST /v1/admin/channels/{channelId}/chatai` com `x-admin-api-key`. O corpo contém `backendUrl`, `apiToken` e `queueId`; o token é cifrado no backend e não retorna na resposta.

## Bling OAuth

O callback público é `GET /v1/oauth/bling/callback`; ele não exige sessão de painel porque valida um `state` de uso único armazenado pelo backend. O proprietário inicia o fluxo em `POST /v1/panel/integrations/bling/authorization`, que retorna uma `authorizationUrl` e a validade. `GET /v1/panel/integrations/bling` mostra apenas estado e metadados seguros da conexão.
