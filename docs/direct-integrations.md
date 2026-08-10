# Integrações diretas

O app controla as integrações ponta a ponta. O provedor não chama n8n e n8n não participa de envio, recebimento, cache ou decisões do agente.

## ChatAI / atende.aí chat

O conector direto do ChatAI já está preparado. Cada canal guarda sua própria `backendUrl`, token e fila padrão. O token é cifrado com AES-256-GCM antes de entrar no PostgreSQL; ele não é guardado em JSON de configuração, logs nem frontend.

O worker envia:

- texto para `POST /api/messages/sendOfficialData`;
- imagens, áudios, vídeos e documentos por URL para `POST /api/messages/official/sendMediaByURL`.

Esses são os contratos presentes nos workflows fornecidos e compatíveis com a documentação do atende.aí chat, que exige token Bearer e telefone no formato numérico internacional. [Documentação de primeiros passos](https://docs.atendeai.chat/) e [envio de texto](https://docs.atendeai.chat/mensagem-de-texto) confirmam esse formato; a documentação também descreve o envio de imagem por URL. [Envio de imagem](https://docs.atendeai.chat/enviar-imagem-por-url)

O callback público direto é:

`POST /v1/webhooks/chatai/{channelId}/{callbackToken}`

A URL só é exibida para cópia quando `WEBHOOK_PUBLIC_URL` estiver configurada com o domínio público HTTPS de webhooks (por exemplo, `https://webhooks.seudominio.com`). Se ela não existir, o sistema usa `APP_PUBLIC_URL` por compatibilidade. `localhost` e `127.0.0.1` servem apenas para desenvolvimento local e não podem receber chamadas da plataforma externa.

O `callbackToken` é gerado pelo backend no cadastro da conexão e retornado somente nessa resposta. O banco guarda apenas seu hash. Isso permite configurar o callback no ChatAI sem depender de cabeçalho customizado. A rota normaliza tanto o envelope do ChatAI quanto o payload oficial da Meta visto nos exports e enfileira a conversa de forma idempotente.

O adaptador é responsável por:

1. receber e validar a assinatura do webhook do provedor;
2. normalizar texto, mídia, status de entrega e identificadores externos;
3. gravar o evento idempotente na API;
4. consumir a outbox para enviar respostas e mídias;
5. processar `sent`, `delivered`, `read` e falhas de entrega.

Enquanto não houver conexão ChatAI configurada, o adaptador permanece em modo seguro (`UnconfiguredChannelAdapter`): a mensagem fica registrada na outbox, mas não é enviada.

### Configuração da conexão

Depois de definir `DATA_ENCRYPTION_KEY` com 32 bytes aleatórios codificados em Base64, o `owner` ou `admin` cria o canal pelo painel e configura a conexão em:

`POST /v1/panel/channels/{channelId}/chatai`

```json
{
  "backendUrl": "https://seu-backend.atendeai.chat",
  "apiToken": "token-criado-na-conexao-do-chatai",
  "queueId": 0,
  "processingDelayMs": 5000
}
```

Não reaproveite token que estava nos exports. Gere um novo no painel ChatAI. A URL de entrada pode ser gerada antes desta conexão de saída; o token é cifrado no banco e seu hash é usado para validar cada chamada. A URL permanece visível somente para usuários owner e admin daquele canal. Para trocar a URL, regenere o webhook pela tela de Integrações.

Defina `WEBHOOK_PUBLIC_URL` como a URL pública HTTPS de entrada antes de gerar uma URL para o ChatAI. Sem ela — e sem um `APP_PUBLIC_URL` alternativo — o sistema guarda o token, mas não exibe uma URL copiável.

## Bling

O conector Bling será direto e terá:

- callback OAuth próprio da aplicação;
- `state` persistido e validado no banco;
- refresh token cifrado fora dos logs;
- fila dedicada, limitada a 3 requisições por segundo;
- sincronização de produtos para o catálogo interno;
- consultas de pedido executadas pelo worker, não pelo navegador.

O domínio público definitivo é necessário antes de cadastrar a URL de callback OAuth no Bling. As credenciais devem ser novas e não podem ser reaproveitadas de exportações históricas.

### OAuth direto

O app executa o fluxo **Authorization Code** diretamente, sem n8n:

1. Um administrador cadastra `clientId` e `clientSecret` em `POST /v1/admin/organizations/{organizationId}/bling/connection`. O segredo é cifrado antes de persistir.
2. Um `owner` ou `admin` solicita `POST /v1/panel/integrations/bling/authorization` e é redirecionado à URL devolvida.
3. O callback público é `GET /v1/oauth/bling/callback`. O `state` é aleatório, guardado somente como hash, expira em 10 minutos e pode ser usado uma única vez.
4. O backend troca o `code` diretamente com o Bling, cifra access/refresh tokens e mantém o token renovado somente no worker.

Defina `APP_PUBLIC_URL` ou `BLING_OAUTH_REDIRECT_URI` antes de iniciar a autorização e cadastre a mesma URL de callback no aplicativo Bling. O código de autorização e os tokens nunca entram no painel, logs ou respostas de API.

### Sincronização de catálogo

O endpoint administrativo `POST /v1/admin/bling/sync-catalog` aceita `organizationId` e `mode` (`incremental` ou `full`). Ele apenas cria a intenção e a fila; uma segunda solicitação da mesma organização enquanto houver execução pendente é devolvida como duplicada.

O worker limita o consumo a três requisições por segundo e registra a execução em `catalog_sync_runs`. A etapa de OAuth e o cliente HTTP ainda não estão ativados por decisão de segurança, portanto uma organização sem conexão Bling ativa recebe o estado `waiting_configuration`.

Quando a conexão for ativada, o adaptador deverá paginar todos os produtos relevantes, fazer `upsert` pelo identificador externo, atualizar preço/estoque/fotos e desativar itens ausentes ou indisponíveis. A IA consulta somente o snapshot interno, não o ERP diretamente.

## Ordem de ativação

1. Criar um token novo e apontar o callback do ChatAI para o domínio público da aplicação.
2. Validar recebimento, texto, foto e status de entrega em ambiente de teste.
3. Cadastrar callback OAuth do Bling no domínio público e conectar o catálogo.
4. Ativar o agente de IA, depois de criar a credencial OpenAI e as avaliações de resposta.
