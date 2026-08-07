import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ChatAiConnection } from '../channels/chatai.js';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../security/encryption.js';

const backendUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname.endsWith('.atendeai.chat');
}, 'A URL deve usar HTTPS em um subdomínio atendeai.chat.');

export const chatAiConnectionSchema = z.object({
  backendUrl: backendUrlSchema,
  apiToken: z.string().min(16).max(1_000),
  queueId: z.number().int().min(0).max(1_000_000).default(0),
  processingDelayMs: z.number().int().min(1_000).max(30_000).default(5_000)
});

export const channelProcessingSchema = z.object({
  processingDelayMs: z.number().int().min(1_000).max(30_000).default(5_000)
});

type StoredConnection = {
  config: { queueId?: number; processingDelayMs?: number };
  backend_url: string | null;
  token_ciphertext: string | null;
  token_iv: string | null;
  token_auth_tag: string | null;
  webhook_token_hash: string | null;
};

async function getStoredConnection(channelId: string): Promise<StoredConnection | null> {
  const result = await pool.query<StoredConnection>(
    `SELECT backend_url, token_ciphertext, token_iv, token_auth_tag, webhook_token_hash, config
       FROM channel_connections WHERE channel_id = $1 AND provider = 'chatai'`,
    [channelId]
  );
  return result.rows[0] ?? null;
}

function nextWebhookToken() {
  const callbackToken = randomBytes(32).toString('base64url');
  return { callbackToken, callbackTokenHash: createHash('sha256').update(callbackToken).digest('hex') };
}

export async function generateChatAiWebhook(channelId: string, input: z.infer<typeof channelProcessingSchema>) {
  const { callbackToken, callbackTokenHash } = nextWebhookToken();
  const result = await pool.query<{ id: string; channel_id: string; provider: string; status: string }>(
    `INSERT INTO channel_connections (channel_id, provider, config, webhook_token_hash, status)
     VALUES ($1, 'chatai', $2, $3, 'pending')
     ON CONFLICT (channel_id) DO UPDATE
       SET config = channel_connections.config || EXCLUDED.config,
           webhook_token_hash = EXCLUDED.webhook_token_hash,
           status = CASE
             WHEN channel_connections.backend_url IS NOT NULL
              AND channel_connections.token_ciphertext IS NOT NULL
              AND channel_connections.token_iv IS NOT NULL
              AND channel_connections.token_auth_tag IS NOT NULL THEN 'active'
             ELSE 'pending'
           END,
           updated_at = now()
     RETURNING id, channel_id, provider, status`,
    [channelId, JSON.stringify({ processingDelayMs: input.processingDelayMs }), callbackTokenHash]
  );
  return { ...result.rows[0], callbackToken };
}

export async function saveChannelProcessing(channelId: string, input: z.infer<typeof channelProcessingSchema>) {
  const result = await pool.query<{ id: string; channel_id: string; provider: string; status: string }>(
    `INSERT INTO channel_connections (channel_id, provider, config, status)
     VALUES ($1, 'chatai', $2, 'pending')
     ON CONFLICT (channel_id) DO UPDATE
       SET config = channel_connections.config || EXCLUDED.config, updated_at = now()
     RETURNING id, channel_id, provider, status`,
    [channelId, JSON.stringify({ processingDelayMs: input.processingDelayMs })]
  );
  return result.rows[0];
}

export async function saveChatAiConnection(channelId: string, input: z.infer<typeof chatAiConnectionSchema>) {
  const existing = await getStoredConnection(channelId);
  const encrypted = encryptSecret(input.apiToken);
  const generatedWebhook = existing?.webhook_token_hash ? null : nextWebhookToken();
  const result = await pool.query<{ id: string; channel_id: string; provider: string; backend_url: string; status: string }>(
    `INSERT INTO channel_connections
       (channel_id, provider, backend_url, token_ciphertext, token_iv, token_auth_tag, config, webhook_token_hash)
     VALUES ($1, 'chatai', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (channel_id) DO UPDATE
       SET provider = 'chatai', backend_url = EXCLUDED.backend_url,
           token_ciphertext = EXCLUDED.token_ciphertext, token_iv = EXCLUDED.token_iv,
           token_auth_tag = EXCLUDED.token_auth_tag, config = EXCLUDED.config,
           webhook_token_hash = EXCLUDED.webhook_token_hash,
           status = 'active', updated_at = now()
     RETURNING id, channel_id, provider, backend_url, status`,
    [
      channelId,
      input.backendUrl.replace(/\/$/, ''),
       encrypted.ciphertext,
       encrypted.iv,
       encrypted.authTag,
      JSON.stringify({ queueId: input.queueId, processingDelayMs: input.processingDelayMs }),
      generatedWebhook?.callbackTokenHash ?? existing?.webhook_token_hash ?? null
    ]
  );
  return { ...result.rows[0], callbackToken: generatedWebhook?.callbackToken ?? null };
}

export function chatAiWebhookUrl(channelId: string, callbackToken: string): string | null {
  const baseUrl = config.WEBHOOK_PUBLIC_URL ?? config.APP_PUBLIC_URL;
  if (!baseUrl) return null;
  return new URL(`/v1/webhooks/chatai/${channelId}/${callbackToken}`, baseUrl).toString();
}

export async function validChatAiWebhookToken(channelId: string, callbackToken: string): Promise<boolean> {
  const hash = createHash('sha256').update(callbackToken).digest('hex');
  const result = await pool.query(
    `SELECT 1 FROM channel_connections
      WHERE channel_id = $1 AND provider = 'chatai' AND status IN ('pending', 'active') AND webhook_token_hash = $2`,
    [channelId, hash]
  );
  return Boolean(result.rowCount);
}

export async function getChatAiConnection(channelId: string): Promise<ChatAiConnection | null> {
  if (!config.DATA_ENCRYPTION_KEY) return null;
  const result = await pool.query<{
    backend_url: string | null;
    token_ciphertext: string | null;
    token_iv: string | null;
    token_auth_tag: string | null;
    config: { queueId?: number };
  }>(
    `SELECT backend_url, token_ciphertext, token_iv, token_auth_tag, config
       FROM channel_connections WHERE channel_id = $1 AND provider = 'chatai' AND status = 'active'`,
    [channelId]
  );
  if (!result.rowCount) return null;
  const connection = result.rows[0];
  if (!connection.backend_url || !connection.token_ciphertext || !connection.token_iv || !connection.token_auth_tag) return null;
  return {
    backendUrl: connection.backend_url,
    apiToken: decryptSecret({ ciphertext: connection.token_ciphertext, iv: connection.token_iv, authTag: connection.token_auth_tag }),
    queueId: Number.isInteger(connection.config.queueId) ? connection.config.queueId! : 0
  };
}
