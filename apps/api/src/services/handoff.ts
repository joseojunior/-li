import { z } from 'zod';
import { withTransaction } from '../db/client.js';

export const handoffSchema = z.object({
  assignedUserId: z.string().uuid().optional(),
  reason: z.string().min(3).max(1_000)
});

export async function handoffConversation(conversationId: string, input: z.infer<typeof handoffSchema>) {
  return withTransaction(async (client) => {
    const updated = await client.query<{ id: string; organization_id: string; status: string; assigned_user_id: string | null }>(
      `UPDATE conversations
          SET status = 'waiting_human', assigned_user_id = $2, updated_at = now()
        WHERE id = $1 AND status <> 'waiting_human'
        RETURNING id, organization_id, status, assigned_user_id`,
      [conversationId, input.assignedUserId ?? null]
    );
    if (!updated.rowCount) {
      const existing = await client.query<{ id: string; organization_id: string; status: string; assigned_user_id: string | null }>(
        `SELECT id, organization_id, status, assigned_user_id FROM conversations WHERE id = $1`,
        [conversationId]
      );
      if (!existing.rowCount) throw new Error('conversation_not_found');
      return existing.rows[0];
    }
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id, detail)
       VALUES ($1, 'system', 'conversation.handoff', 'conversation', $2, $3)`,
      [updated.rows[0].organization_id, conversationId, JSON.stringify({ reason: input.reason, assignedUserId: input.assignedUserId })]
    );
    return updated.rows[0];
  });
}

export async function resumeConversation(conversationId: string) {
  return withTransaction(async (client) => {
    const updated = await client.query<{ id: string; organization_id: string; status: string }>(
      `UPDATE conversations SET status = 'open', updated_at = now() WHERE id = $1
       RETURNING id, organization_id, status`,
      [conversationId]
    );
    if (!updated.rowCount) throw new Error('conversation_not_found');
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id)
       VALUES ($1, 'system', 'conversation.resumed', 'conversation', $2)`,
      [updated.rows[0].organization_id, conversationId]
    );
    return updated.rows[0];
  });
}
