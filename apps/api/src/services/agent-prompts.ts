import { createHash } from 'node:crypto';
import { specialistPromptDefaults } from '../agent-system/instructions.js';
import type { LilibagAgentKey } from '../agent-system/types.js';
import { pool, withTransaction } from '../db/client.js';
import { LILIBAG_PLAYBOOK_NAME, LILIBAG_SALES_INSTRUCTIONS } from './lilibag-playbook.js';

export type AgentPromptVersion = {
  id: string;
  agentKey: LilibagAgentKey;
  version: number;
  instructions: string;
  checksum: string;
  status: 'draft' | 'active' | 'archived';
  createdAt: string;
};

const promptNames: Record<LilibagAgentKey, string> = {
  attendant: LILIBAG_PLAYBOOK_NAME,
  support: 'lilibag-support',
  product: 'lilibag-product'
};

const defaults: Record<LilibagAgentKey, string> = {
  attendant: LILIBAG_SALES_INSTRUCTIONS,
  support: specialistPromptDefaults.support,
  product: specialistPromptDefaults.product
};

function agentKeyForName(name: string): LilibagAgentKey | null {
  return (Object.keys(promptNames) as LilibagAgentKey[]).find((key) => promptNames[key] === name) ?? null;
}

function rowToVersion(row: { id: string; name: string; version: number; instructions: string; checksum: string; status: AgentPromptVersion['status']; created_at: Date }): AgentPromptVersion {
  const agentKey = agentKeyForName(row.name);
  if (!agentKey) throw new Error('agent_prompt_not_found');
  return { id: row.id, agentKey, version: row.version, instructions: row.instructions, checksum: row.checksum, status: row.status, createdAt: row.created_at.toISOString() };
}

export async function ensureAgentPromptVersions(organizationId: string): Promise<void> {
  await Promise.all((Object.keys(promptNames) as LilibagAgentKey[]).map(async (agentKey) => {
    const instructions = defaults[agentKey];
    await pool.query(
      `INSERT INTO prompt_versions (organization_id, name, version, instructions, checksum, status)
       VALUES ($1, $2, 1, $3, $4, 'active')
       ON CONFLICT (organization_id, name, version) DO NOTHING`,
      [organizationId, promptNames[agentKey], instructions, createHash('sha256').update(instructions).digest('hex')]
    );
  }));
}

export async function listAgentPromptVersions(organizationId: string): Promise<AgentPromptVersion[]> {
  const result = await pool.query<{ id: string; name: string; version: number; instructions: string; checksum: string; status: AgentPromptVersion['status']; created_at: Date }>(
    `SELECT id, name, version, instructions, checksum, status, created_at
       FROM prompt_versions
      WHERE organization_id = $1 AND name = ANY($2::text[])
      ORDER BY name, version DESC`,
    [organizationId, Object.values(promptNames)]
  );
  return result.rows.map(rowToVersion);
}

export async function createAgentPromptVersion(organizationId: string, input: { agentKey: LilibagAgentKey; instructions: string }): Promise<AgentPromptVersion> {
  const name = promptNames[input.agentKey];
  const instructions = input.instructions.trim();
  const checksum = createHash('sha256').update(instructions).digest('hex');
  return withTransaction(async (client) => {
    const latest = await client.query<{ version: number }>(
      `SELECT version FROM prompt_versions
        WHERE organization_id = $1 AND name = $2
        ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [organizationId, name]
    );
    const created = await client.query<{ id: string; name: string; version: number; instructions: string; checksum: string; status: AgentPromptVersion['status']; created_at: Date }>(
      `INSERT INTO prompt_versions (organization_id, name, version, instructions, checksum, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')
       RETURNING id, name, version, instructions, checksum, status, created_at`,
      [organizationId, name, (latest.rows[0]?.version ?? 0) + 1, instructions, checksum]
    );
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id, detail)
       VALUES ($1, 'user', 'ai.prompt_version_created', 'prompt_version', $2, $3)`,
      [organizationId, created.rows[0].id, JSON.stringify({ agentKey: input.agentKey, version: created.rows[0].version })]
    );
    return rowToVersion(created.rows[0]);
  });
}

export async function activateAgentPromptVersion(organizationId: string, promptId: string): Promise<AgentPromptVersion> {
  return withTransaction(async (client) => {
    const target = await client.query<{ id: string; name: string; version: number; instructions: string; checksum: string; status: AgentPromptVersion['status']; created_at: Date }>(
      `SELECT id, name, version, instructions, checksum, status, created_at
         FROM prompt_versions
        WHERE id = $1 AND organization_id = $2 AND name = ANY($3::text[])
        FOR UPDATE`,
      [promptId, organizationId, Object.values(promptNames)]
    );
    if (!target.rowCount) throw new Error('agent_prompt_not_found');
    await client.query(
      `UPDATE prompt_versions SET status = 'archived'
        WHERE organization_id = $1 AND name = $2 AND status = 'active' AND id <> $3`,
      [organizationId, target.rows[0].name, promptId]
    );
    const activated = await client.query<{ id: string; name: string; version: number; instructions: string; checksum: string; status: AgentPromptVersion['status']; created_at: Date }>(
      `UPDATE prompt_versions SET status = 'active'
        WHERE id = $1 AND organization_id = $2
        RETURNING id, name, version, instructions, checksum, status, created_at`,
      [promptId, organizationId]
    );
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id, detail)
       VALUES ($1, 'user', 'ai.prompt_version_activated', 'prompt_version', $2, $3)`,
      [organizationId, promptId, JSON.stringify({ agentKey: agentKeyForName(activated.rows[0].name), version: activated.rows[0].version })]
    );
    return rowToVersion(activated.rows[0]);
  });
}

export async function getActiveAgentPrompts(organizationId: string): Promise<Partial<Record<LilibagAgentKey, AgentPromptVersion>>> {
  const result = await pool.query<{ id: string; name: string; version: number; instructions: string; checksum: string; status: AgentPromptVersion['status']; created_at: Date }>(
    `SELECT id, name, version, instructions, checksum, status, created_at
       FROM prompt_versions
      WHERE organization_id = $1 AND name = ANY($2::text[]) AND status = 'active'`,
    [organizationId, Object.values(promptNames)]
  );
  return Object.fromEntries(result.rows.map((row) => {
    const version = rowToVersion(row);
    return [version.agentKey, version];
  })) as Partial<Record<LilibagAgentKey, AgentPromptVersion>>;
}

export async function findAgentPromptVersion(organizationId: string, promptId: string): Promise<AgentPromptVersion | null> {
  const result = await pool.query<{ id: string; name: string; version: number; instructions: string; checksum: string; status: AgentPromptVersion['status']; created_at: Date }>(
    `SELECT id, name, version, instructions, checksum, status, created_at
       FROM prompt_versions
      WHERE id = $1 AND organization_id = $2 AND name = ANY($3::text[])`,
    [promptId, organizationId, Object.values(promptNames)]
  );
  return result.rowCount ? rowToVersion(result.rows[0]) : null;
}
