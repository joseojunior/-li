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

## Parar

```bash
docker compose -f deploy/docker-compose.local-traefik.yml down
```

Para remover tambem os dados locais de PostgreSQL e Redis:

```bash
docker compose -f deploy/docker-compose.local-traefik.yml down -v
```
