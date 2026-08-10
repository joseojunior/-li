import { ChatAiChannelAdapter, type ChatAiTagCandidate } from '../channels/chatai.js';
import type pg from 'pg';
import { pool, withTransaction } from '../db/client.js';
import { publishTrace } from '../queue.js';
import { getChatAiConnection } from './channel-connections.js';

type ImportedTag = ChatAiTagCandidate & { slug: string };

export type ChatAiTagSyncResult = {
  found: number;
  imported: number;
  existing: number;
  tags: ImportedTag[];
};

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function toImportableTags(candidates: ChatAiTagCandidate[]): ImportedTag[] {
  const bySlug = new Map<string, ImportedTag>();
  for (const candidate of candidates) {
    const name = candidate.name.trim().replace(/\s+/g, ' ').slice(0, 100);
    const slug = slugify(name);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, { name, slug, color: candidate.color });
  }
  return [...bySlug.values()].slice(0, 300);
}

/** Imports only the provider's tag catalog. Contacts and ticket content never enter our database. */
export async function syncChatAiConversationTags(organizationId: string, channelId: string): Promise<ChatAiTagSyncResult> {
  const connection = await getChatAiConnection(channelId);
  if (!connection) throw new Error('chatai_connection_not_configured');

  const tags = toImportableTags(await new ChatAiChannelAdapter(connection).listConversationTags());
  const imported = await withTransaction(async (client) => {
    let count = 0;
    for (const tag of tags) {
      const result = await client.query(
        `INSERT INTO tags (organization_id, scope, slug, name, color)
         VALUES ($1, 'conversation', $2, $3, $4)
         ON CONFLICT (organization_id, scope, slug) DO NOTHING
         RETURNING id`,
        [organizationId, tag.slug, tag.name, tag.color ?? null]
      );
      count += result.rowCount ?? 0;
    }
    return count;
  });

  publishTrace({
    organizationId,
    channelId,
    eventType: 'integration.chatai_tags_synced',
    status: 'completed',
    detail: { found: tags.length, imported, existing: tags.length - imported }
  });
  return { found: tags.length, imported, existing: tags.length - imported, tags };
}

/** Applies tags included by the provider webhook to just the current conversation. */
export async function applyInboundChatAiTags(client: pg.PoolClient, organizationId: string, conversationId: string, rawTags: string[]): Promise<void> {
  const tags = toImportableTags(rawTags.map((name) => ({ name })));
  for (const tag of tags.slice(0, 30)) {
    await client.query(
      `INSERT INTO tags (organization_id, scope, slug, name)
       VALUES ($1, 'conversation', $2, $3)
       ON CONFLICT (organization_id, scope, slug) DO NOTHING`,
      [organizationId, tag.slug, tag.name]
    );
    await client.query(
      `INSERT INTO tag_assignments (organization_id, tag_id, subject_type, subject_id, source)
       SELECT $1, id, 'conversation', $2, 'integration' FROM tags
        WHERE organization_id = $1 AND scope = 'conversation' AND slug = $3
       ON CONFLICT (tag_id, subject_type, subject_id) DO NOTHING`,
      [organizationId, conversationId, tag.slug]
    );
  }
}
