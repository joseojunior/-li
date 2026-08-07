import { z } from 'zod';
import { pool, withTransaction } from '../db/client.js';

const tagSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const routingPolicyInputSchema = z.object({
  name: z.string().min(2).max(120),
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
  conditions: z.object({
    channelIds: z.array(z.string().uuid()).max(30).optional(),
    messageTypes: z.array(z.enum(['text', 'image', 'audio', 'video', 'document'])).max(5).optional(),
    hasTagsAll: z.array(tagSlugSchema).max(30).optional(),
    hasTagsAny: z.array(tagSlugSchema).max(30).optional()
  }).default({}),
  action: z.object({
    type: z.enum(['continue', 'handoff', 'pause_automation']),
    reason: z.string().min(3).max(1_000).optional(),
    addConversationTags: z.array(tagSlugSchema).max(30).default([])
  }).superRefine((value, ctx) => {
    if (value.type !== 'continue' && !value.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Informe o motivo da regra.' });
  })
});

type Policy = {
  id: string;
  name: string;
  conditions: z.infer<typeof routingPolicyInputSchema>['conditions'];
  action: z.infer<typeof routingPolicyInputSchema>['action'];
};

export async function createRoutingPolicy(organizationId: string, input: z.infer<typeof routingPolicyInputSchema>) {
  await assertConversationTagsExist(organizationId, [...(input.conditions.hasTagsAll ?? []), ...(input.conditions.hasTagsAny ?? []), ...input.action.addConversationTags]);
  const result = await pool.query(
    `INSERT INTO routing_policies (organization_id, name, priority, enabled, conditions, action)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, priority, enabled, conditions, action, created_at, updated_at`,
    [organizationId, input.name, input.priority, input.enabled, JSON.stringify(input.conditions), JSON.stringify(input.action)]
  );
  return result.rows[0];
}

export async function listRoutingPolicies(organizationId: string) {
  const result = await pool.query(
    `SELECT id, name, priority, enabled, conditions, action, created_at, updated_at
       FROM routing_policies WHERE organization_id = $1
      ORDER BY priority ASC, created_at ASC`,
    [organizationId]
  );
  return result.rows;
}

export async function applyRoutingPolicy(input: { organizationId: string; conversationId: string; messageId: string; messageType: string }): Promise<{ decision: 'continue' | 'handoff' | 'pause_automation'; policyId?: string }> {
  const context = await pool.query<{ channel_id: string; status: string; tags: string[] }>(
    `SELECT c.channel_id, c.status, COALESCE(array_agg(t.slug) FILTER (WHERE t.slug IS NOT NULL), '{}') AS tags
       FROM conversations c
       LEFT JOIN tag_assignments ta ON ta.subject_type = 'conversation' AND ta.subject_id = c.id
       LEFT JOIN tags t ON t.id = ta.tag_id
      WHERE c.id = $1 AND c.organization_id = $2
      GROUP BY c.id`,
    [input.conversationId, input.organizationId]
  );
  if (!context.rowCount) throw new Error('conversation_not_found');
  if (context.rows[0].status !== 'open') return { decision: 'pause_automation' };

  const policies = await pool.query<Policy>(
    `SELECT id, name, conditions, action FROM routing_policies
      WHERE organization_id = $1 AND enabled = true
      ORDER BY priority ASC, created_at ASC`,
    [input.organizationId]
  );
  const policy = policies.rows.find((candidate) => matches(candidate, context.rows[0], input.messageType));
  if (!policy) return { decision: 'continue' };

  await withTransaction(async (client) => {
    if (policy.action.addConversationTags.length) {
      await client.query(
        `INSERT INTO tag_assignments (organization_id, tag_id, subject_type, subject_id, source)
         SELECT $1, id, 'conversation', $2, 'rule' FROM tags
          WHERE organization_id = $1 AND scope = 'conversation' AND slug = ANY($3::text[])
         ON CONFLICT (tag_id, subject_type, subject_id) DO UPDATE SET source = EXCLUDED.source`,
        [input.organizationId, input.conversationId, policy.action.addConversationTags]
      );
    }
    if (policy.action.type === 'handoff') {
      await client.query(`UPDATE conversations SET status = 'waiting_human', updated_at = now() WHERE id = $1`, [input.conversationId]);
    }
    await client.query(
      `INSERT INTO routing_decisions (organization_id, conversation_id, message_id, policy_id, decision, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.organizationId, input.conversationId, input.messageId, policy.id, policy.action.type, JSON.stringify({ policyName: policy.name, reason: policy.action.reason ?? null })]
    );
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id, detail)
       VALUES ($1, 'system', 'routing.policy_applied', 'conversation', $2, $3)`,
      [input.organizationId, input.conversationId, JSON.stringify({ policyId: policy.id, decision: policy.action.type })]
    );
  });
  return { decision: policy.action.type, policyId: policy.id };
}

function matches(policy: Policy, context: { channel_id: string; tags: string[] }, messageType: string): boolean {
  const conditions = policy.conditions ?? {};
  if (conditions.channelIds?.length && !conditions.channelIds.includes(context.channel_id)) return false;
  if (conditions.messageTypes?.length && !conditions.messageTypes.includes(messageType as never)) return false;
  if (conditions.hasTagsAll?.some((tag) => !context.tags.includes(tag))) return false;
  if (conditions.hasTagsAny?.length && !conditions.hasTagsAny.some((tag) => context.tags.includes(tag))) return false;
  return true;
}

async function assertConversationTagsExist(organizationId: string, slugs: string[]): Promise<void> {
  const required = [...new Set(slugs)];
  if (!required.length) return;
  const result = await pool.query<{ slug: string }>(
    `SELECT slug FROM tags WHERE organization_id = $1 AND scope = 'conversation' AND slug = ANY($2::text[])`,
    [organizationId, required]
  );
  if (result.rowCount !== required.length) throw new Error('routing_policy_tag_not_found');
}
