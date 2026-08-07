import { z } from 'zod';
import { pool, withTransaction } from '../db/client.js';

export const tagScopeSchema = z.enum(['product', 'conversation', 'contact']);
export const tagInputSchema = z.object({
  scope: tagScopeSchema,
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().min(2).max(100),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
});

export const tagAssignmentSchema = z.object({
  tagSlug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  source: z.enum(['manual', 'rule', 'agent', 'integration']).default('manual')
});

type SubjectType = z.infer<typeof tagScopeSchema>;

export async function createTag(organizationId: string, input: z.infer<typeof tagInputSchema>) {
  const result = await pool.query(
    `INSERT INTO tags (organization_id, scope, slug, name, color)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, organization_id, scope, slug, name, color, created_at`,
    [organizationId, input.scope, input.slug, input.name, input.color ?? null]
  );
  return result.rows[0];
}

export async function listTags(organizationId: string, scope?: SubjectType) {
  const result = await pool.query(
    `SELECT id, scope, slug, name, color, created_at
       FROM tags
      WHERE organization_id = $1 AND ($2::text IS NULL OR scope = $2)
      ORDER BY scope, name`,
    [organizationId, scope ?? null]
  );
  return result.rows;
}

export async function assignTag(organizationId: string, subjectType: SubjectType, subjectId: string, tagSlug: string, source: z.infer<typeof tagAssignmentSchema>['source'] = 'manual') {
  return withTransaction(async (client) => {
    await assertSubject(client, organizationId, subjectType, subjectId);
    const assigned = await client.query(
      `INSERT INTO tag_assignments (organization_id, tag_id, subject_type, subject_id, source)
       SELECT $1, id, $2, $3, $4 FROM tags
        WHERE organization_id = $1 AND scope = $2 AND slug = $5
       ON CONFLICT (tag_id, subject_type, subject_id) DO UPDATE SET source = EXCLUDED.source
       RETURNING id, tag_id, subject_type, subject_id, source, created_at`,
      [organizationId, subjectType, subjectId, source, tagSlug]
    );
    if (!assigned.rowCount) throw new Error('tag_not_found');
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id, detail)
       VALUES ($1, 'system', 'tag.assigned', $2, $3, $4)`,
      [organizationId, subjectType, subjectId, JSON.stringify({ tagSlug, source })]
    );
    return assigned.rows[0];
  });
}

export async function removeTagAssignment(organizationId: string, subjectType: SubjectType, subjectId: string, tagSlug: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM tag_assignments ta USING tags t
      WHERE ta.organization_id = $1 AND ta.subject_type = $2 AND ta.subject_id = $3
        AND t.id = ta.tag_id AND t.slug = $4`,
    [organizationId, subjectType, subjectId, tagSlug]
  );
  return Boolean(result.rowCount);
}

export async function listSubjectTags(organizationId: string, subjectType: SubjectType, subjectId: string) {
  const result = await pool.query(
    `SELECT t.id, t.scope, t.slug, t.name, t.color, ta.source, ta.created_at
       FROM tag_assignments ta JOIN tags t ON t.id = ta.tag_id
      WHERE ta.organization_id = $1 AND ta.subject_type = $2 AND ta.subject_id = $3
      ORDER BY t.name`,
    [organizationId, subjectType, subjectId]
  );
  return result.rows;
}

async function assertSubject(client: Parameters<typeof withTransaction>[0] extends (client: infer Client) => unknown ? Client : never, organizationId: string, type: SubjectType, id: string): Promise<void> {
  const table = type === 'conversation' ? 'conversations' : type === 'product' ? 'products' : 'contacts';
  const result = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
  if (!result.rowCount) throw new Error(`${type}_not_found`);
}
