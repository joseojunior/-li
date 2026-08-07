import { ChatAiChannelAdapter } from '../channels/chatai.js';
import { UnconfiguredChannelAdapter, type OutboundMessage } from '../channels/adapter.js';
import { withTransaction } from '../db/client.js';
import { getChatAiConnection } from './channel-connections.js';
import { createMediaAssetReadUrl } from './media-assets.js';

const adapter = new UnconfiguredChannelAdapter();

type ClaimedEvent = {
  id: string;
  organization_id: string;
  event_type: string;
  payload: { channelId: string; conversationId: string; messageId: string };
  provider: string;
  recipient: string;
  body: string;
  media: unknown;
};

export async function dispatchOutboxEvent(eventId: string, options: { finalAttempt?: boolean } = {}): Promise<void> {
  const event = await withTransaction(async (client) => {
    const claimed = await client.query<ClaimedEvent>(
      `UPDATE outbox_events oe
          SET status = 'processing', attempts = attempts + 1
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN channels ch ON ch.id = c.channel_id
         JOIN contacts ct ON ct.id = c.contact_id
        WHERE oe.id = $1 AND oe.status = 'pending' AND oe.aggregate_id = m.id AND oe.event_type = 'message.send'
        RETURNING oe.id, oe.organization_id, oe.event_type, oe.payload, ch.provider,
                  COALESCE(ct.phone_e164, ct.external_id) AS recipient, m.body, m.media`,
      [eventId]
    );
    return claimed.rows[0] ?? null;
  });
  if (!event) return;

  let outcome;
  try {
    const connection = event.provider === 'chatai' ? await getChatAiConnection(event.payload.channelId) : null;
    const adapter = connection ? new ChatAiChannelAdapter(connection) : new UnconfiguredChannelAdapter();
    outcome = await adapter.send({
      channelId: event.payload.channelId,
      conversationId: event.payload.conversationId,
      messageId: event.payload.messageId,
      provider: event.provider,
      recipient: event.recipient,
      body: event.body,
      media: await resolveDispatchMedia(event.organization_id, event.media)
    });
  } catch (error) {
    await withTransaction(async (client) => {
      await client.query(`UPDATE messages SET delivery_status = $2 WHERE id = $1`, [event.payload.messageId, options.finalAttempt ? 'failed' : 'queued']);
      await client.query(
        `UPDATE outbox_events SET status = $2, payload = payload || $3::jsonb WHERE id = $1`,
        [event.id, options.finalAttempt ? 'failed' : 'pending', JSON.stringify({ errorCode: error instanceof Error ? 'channel_dispatch_failed' : 'unknown_dispatch_failure' })]
      );
    });
    throw error;
  }

  await withTransaction(async (client) => {
    if (outcome.status === 'waiting_configuration') {
      await client.query(`UPDATE outbox_events SET status = 'waiting_configuration' WHERE id = $1`, [event.id]);
      return;
    }
    await client.query(`UPDATE messages SET delivery_status = 'sent' WHERE id = $1`, [event.payload.messageId]);
    await client.query(
      `UPDATE outbox_events SET status = 'published', published_at = now(), payload = payload || $2::jsonb WHERE id = $1`,
        [event.id, JSON.stringify({ providerMessageIds: outcome.providerMessageIds })]
    );
  });
}

async function resolveDispatchMedia(organizationId: string, value: unknown): Promise<OutboundMessage['media']> {
  if (!Array.isArray(value)) return [];
  return Promise.all(value.map(async (item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_outbound_media');
    const record = item as Record<string, unknown>;
    const filename = typeof record.filename === 'string' ? record.filename : undefined;
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType : undefined;
    if (typeof record.assetId === 'string') {
      const asset = await createMediaAssetReadUrl(organizationId, record.assetId);
      return { url: asset.url, mimeType: asset.mimeType, filename };
    }
    if (typeof record.url === 'string' && new URL(record.url).protocol === 'https:') {
      return { url: record.url, mimeType, filename };
    }
    throw new Error('invalid_outbound_media');
  }));
}
