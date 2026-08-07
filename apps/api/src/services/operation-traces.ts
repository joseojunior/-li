import { pool } from '../db/client.js';

export type TraceStatus = 'received' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export type TraceEvent = {
  organizationId: string;
  conversationId?: string | null;
  channelId?: string | null;
  agentRunId?: string | null;
  eventType: string;
  status: TraceStatus;
  detail?: Record<string, unknown>;
};

export async function persistTrace(event: TraceEvent): Promise<void> {
  await pool.query(
    `INSERT INTO operation_traces
      (organization_id, conversation_id, channel_id, agent_run_id, event_type, status, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.organizationId, event.conversationId ?? null, event.channelId ?? null, event.agentRunId ?? null, event.eventType, event.status, JSON.stringify(event.detail ?? {})]
  );
}

export async function listOperationTraces(organizationId: string, options: { limit: number; conversationId?: string }) {
  const result = await pool.query(
    `SELECT ot.id, ot.event_type, ot.status, ot.detail, ot.created_at,
            ot.conversation_id, ot.channel_id, ot.agent_run_id,
            c.display_name AS channel_name, ct.name AS contact_name, ct.phone_e164
       FROM operation_traces ot
       LEFT JOIN channels c ON c.id = ot.channel_id
       LEFT JOIN conversations cv ON cv.id = ot.conversation_id
       LEFT JOIN contacts ct ON ct.id = cv.contact_id
      WHERE ot.organization_id = $1
        AND ($2::uuid IS NULL OR ot.conversation_id = $2)
      ORDER BY ot.created_at DESC
      LIMIT $3`,
    [organizationId, options.conversationId ?? null, options.limit]
  );
  return result.rows;
}

export async function getOperationTraceSummary(organizationId: string) {
  const result = await pool.query<{
    total: string; failed: string; webhook: string; queue: string; agent: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS total,
       count(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status = 'failed') AS failed,
       count(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND event_type LIKE 'webhook.%') AS webhook,
       count(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND event_type LIKE 'queue.%') AS queue,
       count(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND event_type LIKE 'agent.%') AS agent
     FROM operation_traces WHERE organization_id = $1`,
    [organizationId]
  );
  const row = result.rows[0];
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}
