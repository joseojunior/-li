import { config as loadEnvironment } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

loadEnvironment({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

// Docker Swarm mounts secrets as files. Resolve them before parsing the
// configuration so the application never needs secret values in a stack file.
for (const name of [
  'DATABASE_URL', 'REDIS_URL', 'INBOUND_WEBHOOK_SECRET', 'ADMIN_API_KEY',
  'DATA_ENCRYPTION_KEY', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY', 'OPENAI_API_KEY'
]) {
  const secretFile = process.env[`${name}_FILE`];
  if (!secretFile) continue;
  try {
    process.env[name] = readFileSync(secretFile, 'utf8').trim();
  } catch {
    throw new Error(`secret_file_unreadable:${name}`);
  }
}

const optionalText = <TSchema extends z.ZodType<string>>(schema: TSchema) => z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  schema.optional()
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(32_768).max(10 * 1024 * 1024).default(1_048_576),
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(10_000).default(300),
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(100_000).default(1_200),
  WEB_APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  INBOUND_WEBHOOK_SECRET: z.string().min(24),
  ADMIN_API_KEY: z.string().min(24),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  DATA_ENCRYPTION_KEY: optionalText(z.string()),
  APP_PUBLIC_URL: optionalText(z.string().url()),
  WEBHOOK_PUBLIC_URL: optionalText(z.string().url()),
  BLING_OAUTH_REDIRECT_URI: optionalText(z.string().url()),
  MEDIA_S3_BUCKET: optionalText(z.string().min(3).max(255)),
  MEDIA_S3_REGION: z.string().min(1).default('us-east-1'),
  MEDIA_S3_ENDPOINT: optionalText(z.string().url()),
  MEDIA_S3_ACCESS_KEY_ID: optionalText(z.string().min(1)),
  MEDIA_S3_SECRET_ACCESS_KEY: optionalText(z.string().min(1)),
  MEDIA_PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  CONVERSATION_DEBOUNCE_MS: z.coerce.number().int().min(0).default(5000),
  CONVERSATION_LOCK_TTL_MS: z.coerce.number().int().min(1000).default(45000),
  CONVERSATION_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(20),
  OUTBOUND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(30),
  TRACE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(50),
  OPENAI_API_KEY: optionalText(z.string()),
  OPENAI_MODEL: optionalText(z.string())
}).superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') return;
  for (const [name, url] of [['WEB_APP_ORIGIN', value.WEB_APP_ORIGIN], ['APP_PUBLIC_URL', value.APP_PUBLIC_URL]] as const) {
    if (!url || new URL(url).protocol !== 'https:') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} deve usar HTTPS em produção.` });
    }
  }
  if (value.WEBHOOK_PUBLIC_URL && new URL(value.WEBHOOK_PUBLIC_URL).protocol !== 'https:') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WEBHOOK_PUBLIC_URL'], message: 'WEBHOOK_PUBLIC_URL deve usar HTTPS em produção.' });
  }
  if (!value.TRUST_PROXY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TRUST_PROXY'], message: 'TRUST_PROXY=true é obrigatório atrás do proxy HTTPS de produção.' });
  }
  if (!value.DATA_ENCRYPTION_KEY || Buffer.from(value.DATA_ENCRYPTION_KEY, 'base64').length !== 32) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATA_ENCRYPTION_KEY'], message: 'DATA_ENCRYPTION_KEY deve conter 32 bytes em Base64.' });
  }
});

export const config = schema.parse(process.env);
