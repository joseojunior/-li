# Catálogo e mídias

O catálogo interno é a fonte usada pelo painel e pelas ferramentas do agente. Ele não depende do Bling para operar; a futura sincronização será apenas uma fonte adicional de atualização.

## Gestão no painel

Usuários com função `owner` ou `admin` podem:

- criar e editar produto, SKU, categoria, preço, disponibilidade e tags;
- vincular fotos públicas por HTTPS;
- consultar os itens que estão disponíveis para atendimento.

As rotas do painel isolam todo acesso pela organização da sessão. Um usuário nunca altera produto de outra loja.

## Mídias por URL

Cada registro de mídia contém a URL pública, tipo MIME, descrição e posição. O painel permite vinculá-la por URL para que o catálogo e o ChatAI possam usá-la no envio ao cliente.

O próximo incremento de mídia substituirá esse vínculo manual por upload assinado para MinIO/S3, mantendo o mesmo modelo `product_media` e as mesmas ferramentas do agente.

## Upload assinado

O upload nativo já está preparado e permanece inativo enquanto as variáveis `MEDIA_S3_*` não forem definidas.

1. O painel solicita `POST /v1/panel/products/{productId}/media/upload-intents` com nome, tipo e tamanho do arquivo.
2. A API cria um `media_asset` pendente e retorna uma URL assinada de curta duração.
3. O navegador envia JPEG, PNG ou WebP diretamente para MinIO/S3. O limite atual é 10 MB.
4. O painel confirma em `POST /v1/panel/products/{productId}/media/uploads/{assetId}/complete`.
5. A API verifica o objeto no storage e o liga ao produto.

Para leitura, a API gera URL temporária. Assim, o bucket não precisa ser público e o ChatAI recebe uma URL válida apenas pelo tempo necessário para enviar a mídia.

### Configuração futura

Em MinIO local, configure `MEDIA_S3_BUCKET`, `MEDIA_S3_ENDPOINT`, `MEDIA_S3_ACCESS_KEY_ID` e `MEDIA_S3_SECRET_ACCESS_KEY`. Em S3/R2, informe o bucket, região e as credenciais do provedor. O bucket também precisa permitir `PUT` do domínio do painel via CORS.

## Uso pelo agente

1. `search_products` encontra itens por texto, categoria, tags e teto de preço, sempre limitado a produtos disponíveis e em estoque quando essa informação existir.
2. `get_product_media` recupera somente as fotos daquele produto e organização.
3. O provedor de IA decide se deve enviar a mídia; a outbox salva o `assetId`, e o worker cria uma URL de leitura temporária apenas no momento de entregar pelo ChatAI. Uma tentativa posterior gera uma URL nova, sem depender de uma URL expirada.

## Busca híbrida

A pesquisa do catálogo combina ranking de texto em português, aproximação de termos (`trigram`) e filtros determinísticos de disponibilidade, estoque, categoria, tags e preço. Assim, a IA não recomenda um produto indisponível só porque o nome é semanticamente parecido.

Cada produto também possui um estado de indexação em `product_embeddings`. Criar ou editar um item o marca como `pending`. O schema guarda modelo, vetor, hash do conteúdo e data de indexação, mas nenhum vetor é gerado nem transmitido enquanto o provedor de embeddings não for configurado. Quando ativado, o worker poderá fornecer o vetor da busca e a consulta combinará os três sinais de relevância.
