# Plataforma de mensageria Lilibag

Núcleo escalável para receber mensagens, agrupar conversas, processar agentes e enviar respostas por canais externos. O próprio app controla webhooks, OAuth, estado de atendimento, filas e auditoria — sem dependência do n8n.

## Componentes

- **API Fastify**: webhooks de entrada e rotas administrativas internas.
- **PostgreSQL**: fonte de verdade de contatos, conversas, mensagens, execuções e eventos.
- **Redis + BullMQ**: cache, locks distribuídos, debounce por conversa e filas.
- **MinIO/S3**: upload assinado preparado para fotos; pode permanecer desativado até a configuração do storage.
- **Worker**: processa uma conversa por vez. A ponte do provedor de IA será ativada quando a credencial for criada.

## Início local

1. Execute `npm run env:local` para criar os segredos locais, sem exibi-los.
2. Suba PostgreSQL e Redis com `npm run infra:up`.
3. Execute `npm install`, `npm run db:migrate` e `npm run db:bootstrap` (com `BOOTSTRAP_ADMIN_EMAIL` e `BOOTSTRAP_ADMIN_PASSWORD` definidos apenas no terminal).
4. Em terminais separados, execute `npm run dev:api`, `npm run dev:worker` e `npm run dev:web`.

O Docker Desktop ainda não está disponível nesta máquina. O `docker-compose.yml` fica pronto para uso assim que ele for instalado ou em uma VM de desenvolvimento.

Consulte [a arquitetura](docs/architecture.md), [o contrato da API](docs/api.md), [o catálogo](docs/catalog.md), [as integrações diretas](docs/direct-integrations.md), [o núcleo de agentes](docs/agents.md), [a ativação local](docs/local-setup.md) e o [deploy no Portainer/Swarm](docs/swarm-portainer-deployment.md).
