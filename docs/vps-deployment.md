# VPS: configuração inicial segura

O pacote em `deploy/` sobe cinco serviços: Caddy (HTTPS e painel), API,
worker, PostgreSQL e Redis. Somente Caddy publica as portas 80 e 443. Banco,
Redis, API e worker ficam na rede Docker interna.

## Antes de subir

1. Aponte o DNS de `APP_DOMAIN` para o IP da VPS e libere somente TCP 80/443
   no firewall. Não publique 3000, 5432, 6379, 9000 ou 9001.
2. Instale Docker Engine e o plugin Docker Compose na VPS.
3. Gere o arquivo sem exibir segredos: `APP_DOMAIN=app.seudominio.com
   ACME_EMAIL=infra@seudominio.com npm run env:production`. Alternativamente,
   copie o exemplo e gere valores novos para todos os campos `GENERATE_*`.
   Aplique `chmod 600 deploy/.env.production`.
4. Mantenha `POSTGRES_PASSWORD` idêntico na `DATABASE_URL` e
   `REDIS_PASSWORD` idêntico na `REDIS_URL`.
5. Faça backup externo e testado do volume PostgreSQL antes de conectar um
   canal real.

## Primeira subida

Da raiz do repositório na VPS:

```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.production.yml up -d --build
```

A migração executa antes da API e do worker. Para criar o primeiro owner, use
uma única vez, sem deixar a senha no histórico do shell:

```bash
read -s BOOTSTRAP_ADMIN_PASSWORD
export BOOTSTRAP_ADMIN_EMAIL='admin@seudominio.com'
export BOOTSTRAP_ADMIN_PASSWORD
docker compose --env-file deploy/.env.production -f deploy/docker-compose.production.yml run --rm migrate node apps/api/dist/db/bootstrap-local.js
unset BOOTSTRAP_ADMIN_PASSWORD
```

Verifique `https://APP_DOMAIN/health` e `https://APP_DOMAIN/ready`. Só depois
gere o webhook ChatAI no painel. Configure Supabase Storage, ChatAI, Bling e
OpenAI gradualmente e valide primeiro em um canal de teste.

## Regras operacionais

- A API exige HTTPS, `TRUST_PROXY=true` e chave de cifragem válida quando
  `NODE_ENV=production`; ela não inicia sem essa base.
- O painel usa cookie `HttpOnly`, `Secure` e `SameSite=Lax`; escritas exigem a
  origem exata configurada em `WEB_APP_ORIGIN`.
- Não copie `.env.production` para o computador local, chat, Git ou ticket.
- Atualizações: faça backup, execute `docker compose ... up -d --build` e
  confira os logs de `migrate`, `api` e `worker`.
