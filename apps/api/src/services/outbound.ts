import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';

const directMediaSchema = z.object({
  url: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'A URL da mídia deve usar HTTPS.'),
  mimeType: z.string().max(120).optional(),
  filename: z.string().max(255).optional()
});

const storedMediaSchema = z.object({
  assetId: z.string().uuid(),
  mimeType: z.string().max(120).optional(),
  filename: z.string().max(255).optional()
});

export const outboundMediaSchema = z.union([directMediaSchema, storedMediaSchema]);
export type OutboundMedia = z.infer<typeof outboundMediaSchema>;

export const outboundMessageSchema = z.object({
  body: z.string().min(1).max(20_000),
  media: z.array(outboundMediaSchema).max(10).default([]),
  idempotencyKey: z.string().min(8).max(255)
});

export async function queueOutboundMessage(conversationId: string, input: z.infer<typeof outboundMessageSchema>) {
  return withTransaction((client) => queueOutboundMessageInTransaction(client, conversationId, input));
}

/**
 * Keeps a message record and its delivery intent atomic with the operation
 * that decided to send it (agent run, manual action, automation, etc.).
 */
export async function queueOutboundMessageInTransaction(client: PoolClient, conversationId: string, input: z.infer<typeof outboundMessageSchema>) {
  const conversation = await client.query<{ organization_id: string; channel_id: string }>(
    'SELECT organization_id, channel_id FROM conversations WHERE id = $1',
    [conversationId]
  );
  if (!conversation.rowCount) throw new Error('conversation_not_found');

  const message = await client.query<{ id: string }>(
    `INSERT INTO messages (organization_id, conversation_id, direction, type, body, media, idempotency_key, delivery_status)
     VALUES ($1, $2, 'outbound', $3, $4, $5, $6, 'queued')
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      conversation.rows[0].organization_id,
      conversationId,
      input.media.length ? 'image' : 'text',
      input.body,
      JSON.stringify(input.media),
      input.idempotencyKey
    ]
  );
  if (!message.rowCount) return { duplicate: true as const, eventId: null };

  const event = await client.query<{ id: string }>(
    `INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'message', $2, 'message.send', $3)
     RETURNING id`,
    [
      conversation.rows[0].organization_id,
      message.rows[0].id,
      JSON.stringify({ channelId: conversation.rows[0].channel_id, conversationId, messageId: message.rows[0].id })
    ]
  );
  return { duplicate: false as const, eventId: event.rows[0].id };
}
