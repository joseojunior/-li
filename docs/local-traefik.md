# Validacao local com Traefik

Esta composicao reproduz a topologia da VPS sem usar a rede ou os secrets de
producao. Ela cria PostgreSQL e Redis locais, processa as migrations, inicia a
API e o worker e entrega o painel atraves do Traefik.

Ela usa Traefik `v3.6.16`, compativel com o Docker Engine 29 do Docker Desktop.

## Preparar e iniciar

1. Crie o `.env` local, se ainda nao existir:

   ```bash
   npm run env:local
   ```

2. Inicie a composicao:

   ```bash
   docker compose -f deploy/docker-compose.local-traefik.yml up --build -d
   ```

3. Abra:

   - Painel: `http://app.lilibag.localhost`
   - API: `http://api.lilibag.localhost/health`
   - Dashboard Traefik: `http://localhost:8080/dashboard/`

Os dominios `.localhost` resolvem para `127.0.0.1` sem alterar o arquivo hosts.
Nao exponha a porta `8080` ou use esta composicao fora da maquina local.

## Receber eventos reais com Cloudflare Tunnel

Use um tunnel de desenvolvimento separado, nunca o tunnel ou hostname da VPS.
No painel Cloudflare, em **Networking > Tunnels**, crie um tunnel remotely
managed chamado, por exemplo, `lilibag-local-dev`. Em **Published application**,
adicione:

| Campo | Valor |
| --- | --- |
| Hostname | `webhooks-dev.lilibag.online` |
| Service type | HTTP |
| URL | `http://traefik:80` |

Copie o token Docker fornecido pelo Cloudflare para um arquivo local:

```bash
cp deploy/.env.local-tunnel.example deploy/.env.local-tunnel
```

No PowerShell:

```powershell
Copy-Item deploy/.env.local-tunnel.example deploy/.env.local-tunnel
```

Preencha apenas `CLOUDFLARE_TUNNEL_TOKEN` e inicie o perfil adicional:

```bash
docker compose --env-file .env --env-file deploy/.env.local-tunnel \
  -f deploy/docker-compose.local-traefik.yml --profile tunnel up --build -d
```

Gere uma nova URL de webhook no painel depois de iniciar o tunnel. Ela usara
`https://webhooks-dev.lilibag.online/...` e podera receber eventos reais na sua
maquina. O Traefik aceita nesse hostname somente `POST /v1/webhooks/*`; o
painel, a API administrativa e o dashboard continuam locais.

## Parar

```bash
docker compose -f deploy/docker-compose.local-traefik.yml down
```

Para remover tambem os dados locais de PostgreSQL e Redis:

```bash
docker compose -f deploy/docker-compose.local-traefik.yml down -v
```
