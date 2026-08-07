import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { withTransaction } from '../db/client.js';

export const inboundMessageSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  externalMessageId: z.string().min(1).max(255).optional(),
  externalContactId: z.string().min(1).max(255),
  contact: z.object({
    name: z.string().min(1).max(255).optional(),
    phoneE164: z.string().min(7).max(32).optional()
  }).default({}),
  type: z.enum(['text', 'image', 'audio', 'video', 'document']),
  body: z.string().max(20_000).optional(),
  media: z.array(z.object({
    url: z.string().url(),
    mimeType: z.string().max(120).optional(),
    filename: z.string().max(255).optional()
  })).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type InboundMessage = z.infer<typeof inboundMessageSchema>;

export type IngestedMessage = {
  duplicate: boolean;
  organizationId: string;
  conversationId: string;
  messageId?: string;
  processingDelayMs: number;
};

type ChannelRow = { id: string; organization_id: string; processing_delay_ms: number };
type ContactRow = { id: string };
type ConversationRow = { id: string };
type MessageRow = { id: string };

export async function ingestInbound(channelId: string, message: InboundMessage): Promise<IngestedMessage> {
  return withTransaction(async (client) => {
    const channel = await findChannel(client, channelId);

    const event = await client.query(
      `INSERT INTO inbox_events (organization_id, source, event_type, idempotency_key, payload)
       VALUES ($1, 'channel', 'message.received', $2, $3)
       ON CONFLICT (organization_id, source, idempotency_key) DO NOTHING
       RETURNING id`,
      [channel.organization_id, message.idempotencyKey, JSON.stringify(message)]
    );
    if (!event.rowCount) {
      return { duplicate: true, organizationId: channel.organization_id, conversationId: '', processingDelayMs: channel.processing_delay_ms };
    }

    const contact = await client.query<ContactRow>(
      `INSERT INTO contacts (organization_id, external_id, name, phone_e164, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, external_id) DO UPDATE
         SET name = COALESCE(EXCLUDED.name, contacts.name),
             phone_e164 = COALESCE(EXCLUDED.phone_e164, contacts.phone_e164),
             metadata = contacts.metadata || EXCLUDED.metadata,
             updated_at = now()
       RETURNING id`,
      [channel.organization_id, message.externalContactId, message.contact.name ?? null, message.contact.phoneE164 ?? null, JSON.stringify(message.metadata)]
    );

    const conversation = await client.query<ConversationRow>(
      `INSERT INTO conversations (organization_id, channel_id, contact_id, last_message_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (channel_id, contact_id) DO UPDATE
         SET last_message_at = now(), updated_at = now()
       RETURNING id`,
      [channel.organization_id, channel.id, contact.rows[0].id]
    );

    const storedMessage = await client.query<MessageRow>(
      `INSERT INTO messages
         (organization_id, conversation_id, direction, type, body, media, metadata, external_message_id, idempotency_key, delivery_status)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, 'received')
       RETURNING id`,
      [
        channel.organization_id,
        conversation.rows[0].id,
        message.type,
        message.body ?? null,
        JSON.stringify(message.media),
        JSON.stringify(message.metadata),
        message.externalMessageId ?? null,
        message.idempotencyKey
      ]
    );

    await client.query('UPDATE inbox_events SET processed_at = now() WHERE id = $1', [event.rows[0].id]);
    return {
      duplicate: false,
      organizationId: channel.organization_id,
      conversationId: conversation.rows[0].id,
      messageId: storedMessage.rows[0].id,
      processingDelayMs: channel.processing_delay_ms
    };
  });
}

async function findChannel(client: pg.PoolClient, channelId: string): Promise<ChannelRow> {
  const result = await client.query<ChannelRow>(
    `SELECT c.id, c.organization_id,
            COALESCE((cc.config ->> 'processingDelayMs')::integer, $2) AS processing_delay_ms
       FROM channels c
       LEFT JOIN channel_connections cc ON cc.channel_id = c.id AND cc.provider = 'chatai'
      WHERE c.id = $1 AND c.status = 'active'`,
    [channelId, config.CONVERSATION_DEBOUNCE_MS]
  );
  if (!result.rowCount) throw new Error('channel_not_found_or_inactive');
  return result.rows[0];
}
