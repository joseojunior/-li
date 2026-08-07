import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/client.js';

export const channelInputSchema = z.object({
  displayName: z.string().min(2).max(255),
  externalId: z.string().min(1).max(255).optional()
});

export async function createChatAiChannel(organizationId: string, input: z.infer<typeof channelInputSchema>) {
  const externalId = input.externalId?.trim() || `pending:${randomUUID()}`;
  const result = await pool.query(
    `INSERT INTO channels (organization_id, provider, external_id, display_name)
     VALUES ($1, 'chatai', $2, $3)
     RETURNING id, provider, external_id, display_name, status, created_at`,
    [organizationId, externalId, input.displayName.trim()]
  );
  return result.rows[0];
}

export async function listOrganizationChannels(organizationId: string) {
  const result = await pool.query(
    `SELECT c.id, c.provider, c.external_id, c.display_name, c.status, c.created_at,
            cc.status AS connection_status, cc.backend_url, cc.updated_at AS connection_updated_at,
            (cc.webhook_token_hash IS NOT NULL) AS webhook_configured,
            COALESCE((cc.config ->> 'processingDelayMs')::integer, 5000) AS inbound_debounce_ms,
            COALESCE((cc.config ->> 'queueId')::integer, 0) AS outbound_queue_id
       FROM channels c
       LEFT JOIN channel_connections cc ON cc.channel_id = c.id AND cc.provider = 'chatai'
      WHERE c.organization_id = $1
      ORDER BY c.created_at DESC`,
    [organizationId]
  );
  return result.rows;
}

export async function assertChannelAccess(channelId: string, organizationId: string): Promise<void> {
  const result = await pool.query(
    `SELECT 1 FROM channels
      WHERE id = $1 AND organization_id = $2 AND provider = 'chatai'`,
    [channelId, organizationId]
  );
  if (!result.rowCount) throw new Error('channel_not_found');
}
