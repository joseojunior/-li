import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.env');
const template = resolve(root, '.env.example');

if (existsSync(target)) {
  console.error('O arquivo .env ja existe. Ele nao foi alterado.');
  process.exit(1);
}

const inboundSecret = randomBytes(32).toString('hex');
const adminKey = randomBytes(32).toString('hex');
const encryptionKey = randomBytes(32).toString('base64');

const content = readFileSync(template, 'utf8')
  .replace('INBOUND_WEBHOOK_SECRET=replace-me-with-a-long-random-secret', `INBOUND_WEBHOOK_SECRET=${inboundSecret}`)
  .replace('ADMIN_API_KEY=replace-me-with-a-long-random-secret', `ADMIN_API_KEY=${adminKey}`)
  .replace('DATA_ENCRYPTION_KEY=', `DATA_ENCRYPTION_KEY=${encryptionKey}`);

writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
console.log('Arquivo .env local criado com segredos aleatorios. Nenhum segredo foi exibido.');
