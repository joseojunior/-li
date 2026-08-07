# Deploy no Portainer / Docker Swarm

Esta é a variante para a VPS que já usa Traefik e a rede externa
`LilibagNet`. Não suba o Caddy da variante `docker-compose.production.yml`
neste mesmo ambiente: o Traefik já é o responsável pelo HTTPS.

## Hosts

| Host | Serviço | Regra |
| --- | --- | --- |
| `app.lilibag.online` | painel | Traefik → frontend interno porta 80 |
| `api.lilibag.online` | API | Traefik → API interna porta 3000 |
| `webhooks.lilibag.online` | webhooks | Traefik → mesma API, somente `/v1/webhooks/*` |

Crie os três registros `A` no Cloudflare para o IP da VPS. Não crie DNS para
worker, agente, Redis, Postgres, traces ou Supabase Storage.

## Imagens

`docker stack deploy` ignora `build`; publique imagens versionadas em um
registry antes de criar a Stack. Exemplo, usando um registry já autenticado:

```bash
export VERSION=0.1.0
export REGISTRY=ghcr.io/sua-organizacao

docker build --target api -t $REGISTRY/lilibag-api:$VERSION .
docker build --target web-swarm \
  --build-arg VITE_API_BASE_URL=https://api.lilibag.online \
  -t $REGISTRY/lilibag-web:$VERSION .
docker push $REGISTRY/lilibag-api:$VERSION
docker push $REGISTRY/lilibag-web:$VERSION
```

O frontend precisa ser recompilado se a URL da API mudar.

### Fluxo recomendado: GitHub Container Registry

A GitHub Action publica automaticamente as imagens em GHCR. Veja
[Imagens para o Portainer](github-container-registry.md). Para producao, use
sempre uma tag imutavel `sha-...` emitida pela Action, nunca `latest`.

## Docker Secrets

Crie estes secrets no manager. Os valores nunca devem estar no YAML, no Git,
nos labels ou nas variáveis do Portainer:

- `lilibag_database_url` — URL de um banco e usuário exclusivos da Lilibag.
- `lilibag_redis_url` — URL de um Redis exclusivo/autenticado.
- `lilibag_inbound_webhook_secret`.
- `lilibag_admin_api_key`.
- `lilibag_data_encryption_key` — Base64 de 32 bytes; mantenha estável.

Os serviços leem apenas arquivos em `/run/secrets`. Antes da primeira subida,
crie uma base e usuário `lilibag` separados do n8n e use Redis separado ou uma
instância autenticada. Não reutilize as credenciais compartilhadas no exemplo
do n8n.

## Portainer

1. Crie uma nova Stack a partir de Git usando
   `deploy/docker-compose.swarm.yml`.
2. Informe as variáveis não sigilosas de `deploy/.env.swarm.example`, trocando
   `LILIBAG_API_IMAGE` e `LILIBAG_WEB_IMAGE` pelas tags publicadas.
3. Crie os Docker Secrets pelo manager antes do deploy.
4. Faça o primeiro deploy com **pull latest image desativado**: a tag é fixa.
5. Confira o serviço `migrate` até concluir; ele não é reiniciado. API e worker
   podem iniciar em paralelo, por isso não conecte o ChatAI até a migração ter
   concluído.

Para atualizar, publique uma nova tag imutável, altere somente as variáveis de
imagem e faça redeploy. As credenciais de canal, Bling e OpenAI são inseridas
depois pelo painel e permanecem cifradas no banco.
