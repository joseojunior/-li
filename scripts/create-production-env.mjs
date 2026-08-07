import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'deploy/.env.production');
const template = resolve(root, 'deploy/.env.production.example');
const domain = process.env.APP_DOMAIN?.trim();
const email = process.env.ACME_EMAIL?.trim();

if (!domain || !email) {
  console.error('Defina APP_DOMAIN e ACME_EMAIL antes de gerar o ambiente de produção.');
  process.exit(1);
}
if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(domain) || domain.includes('..')) {
  console.error('APP_DOMAIN deve ser apenas um domínio válido, sem protocolo, porta ou espaços.');
  process.exit(1);
}
if (/\r|\n/.test(email)) {
  console.error('ACME_EMAIL não pode conter quebras de linha.');
  process.exit(1);
}
if (existsSync(target)) {
  console.error('deploy/.env.production já existe. Ele não foi alterado.');
  process.exit(1);
}

const secret = () => randomBytes(32).toString('base64url');
const postgresPassword = secret();
const redisPassword = secret();
const encryptionKey = randomBytes(32).toString('base64');
const content = readFileSync(template, 'utf8')
  .replaceAll('app.seudominio.com', domain)
  .replace('infra@seudominio.com', email)
  .replace('POSTGRES_PASSWORD=GENERATE_A_LONG_RANDOM_PASSWORD', `POSTGRES_PASSWORD=${postgresPassword}`)
  .replace('postgresql://lilibag:GENERATE_A_LONG_RANDOM_PASSWORD@postgres:5432/lilibag', `postgresql://lilibag:${postgresPassword}@postgres:5432/lilibag`)
  .replace('REDIS_PASSWORD=GENERATE_A_LONG_RANDOM_PASSWORD', `REDIS_PASSWORD=${redisPassword}`)
  .replace('redis://:GENERATE_A_LONG_RANDOM_PASSWORD@redis:6379', `redis://:${redisPassword}@redis:6379`)
  .replace('INBOUND_WEBHOOK_SECRET=GENERATE_32_OR_MORE_RANDOM_BYTES', `INBOUND_WEBHOOK_SECRET=${secret()}`)
  .replace('ADMIN_API_KEY=GENERATE_32_OR_MORE_RANDOM_BYTES', `ADMIN_API_KEY=${secret()}`)
  .replace('DATA_ENCRYPTION_KEY=GENERATE_BASE64_32_BYTE_KEY', `DATA_ENCRYPTION_KEY=${encryptionKey}`);

writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
console.log('deploy/.env.production criado com segredos aleatórios. Nenhum segredo foi exibido.');
