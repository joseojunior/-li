# Ativacao local

## Servicos

1. Instale e abra o Docker Desktop.
2. Na raiz do projeto, execute `npm run env:local`. O comando cria `.env` somente se ele ainda nao existir, com segredos aleatorios de desenvolvimento que nao aparecem no terminal.
3. Execute `npm run infra:up`. Ele inicia PostgreSQL e Redis. O MinIO fica opcional para quando os uploads forem ativados.
4. Execute `npm install` e `npm run db:migrate`.
5. Crie o primeiro acesso local. No PowerShell:

   ```powershell
   $env:BOOTSTRAP_ADMIN_EMAIL = 'admin@lilibag.local'
   $env:BOOTSTRAP_ADMIN_PASSWORD = 'uma-senha-local-com-12-ou-mais-caracteres'
   npm run db:bootstrap
   ```

   Opcionalmente, defina `BOOTSTRAP_ORGANIZATION_NAME`, `BOOTSTRAP_ORGANIZATION_SLUG` e `BOOTSTRAP_ADMIN_NAME`. O comando pode ser executado novamente sem duplicar organizacao ou usuario e nunca troca a senha de uma conta ja criada.

6. Em terminais separados, execute `npm run dev:api`, `npm run dev:worker` e `npm run dev:web`.

O painel estara em `http://localhost:5173` e a API em `http://localhost:3000`.

## Primeiro acesso

O bootstrap cria a organizacao e o usuario `owner`. Entre no painel com o slug informado (por padrao, `lilibag-local`), o e-mail e a senha escolhidos. A chave administrativa nunca deve ser inserida no navegador; ela serve somente para rotas internas autenticadas.

## Upload de fotos (quando ativar)

O `docker-compose.yml` ja contem MinIO, mas ele usa o perfil `media` e nao inicia junto com a infraestrutura basica. Para ativar depois, execute `docker compose --profile media up -d minio` e configure `MEDIA_S3_*` no `.env`. Use um bucket proprio da aplicacao e credenciais exclusivas de desenvolvimento.

## Antes de producao

- Coloque API, worker e painel atras de HTTPS.
- Use PostgreSQL e Redis gerenciados, backup testado e armazenamento S3 privado.
- Troque os segredos locais por um cofre/KMS e configure rotacao.
- Defina `WEB_APP_ORIGIN` como a URL publica exata do painel.
- Aplique rate limiting no proxy de borda tambem; o limite de login no Redis e uma segunda camada.
