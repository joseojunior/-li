import { randomUUID } from 'node:crypto';
import { LilibagAgentRunner } from '../agents/runner.js';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/client.js';
import { publishTrace, redis, scheduleOutbound, type ConversationJob } from '../queue.js';
import { applyRoutingPolicy } from './routing.js';
import { applyLilibagSafetyPolicy } from './sales-context.js';
import { getLilibagPlaybook } from './lilibag-playbook.js';
import { parseAgentDecision } from '../agent-system/decision.js';
import { prepareAgentOutbound } from './agent-outbound.js';
import { queueOutboundMessageInTransaction } from './outbound.js';
import { handoffConversation } from './handoff.js';

const runner = new LilibagAgentRunner();

export async function processConversation(job: ConversationJob): Promise<void> {
  const lockKey = `lock:conversation:${job.conversationId}`;
  const lockValue = randomUUID();
  const lockAcquired = await redis.set(lockKey, lockValue, 'PX', config.CONVERSATION_LOCK_TTL_MS, 'NX');
  if (lockAcquired !== 'OK') {
    publishTrace({ organizationId: job.organizationId, conversationId: job.conversationId, eventType: 'agent.skipped', status: 'skipped', detail: { reason: 'conversation_locked' } });
    return;
  }

  try {
    const state = await pool.query<{ newest_message_at: Date | null; newest_run_at: Date | null }>(
      `SELECT
         (SELECT max(created_at) FROM messages WHERE conversation_id = $1 AND direction = 'inbound') AS newest_message_at,
         (SELECT max(created_at) FROM agent_runs WHERE conversation_id = $1) AS newest_run_at`,
      [job.conversationId]
    );
    const { newest_message_at: newestMessageAt, newest_run_at: newestRunAt } = state.rows[0];
    if (!newestMessageAt || (newestRunAt && newestRunAt >= newestMessageAt)) return;

    const messages = await pool.query<{ id: string; direction: 'inbound' | 'outbound'; type: string; body: string | null; created_at: Date }>(
      `SELECT id, direction, type, body, created_at FROM messages
       WHERE conversation_id = $1 AND direction = 'inbound' AND created_at >= COALESCE($2, '-infinity'::timestamptz)
       ORDER BY created_at ASC`,
      [job.conversationId, newestRunAt ?? null]
    );
    if (!messages.rowCount) return;

    const routing = await applyRoutingPolicy({
      organizationId: job.organizationId,
      conversationId: job.conversationId,
      messageId: messages.rows[messages.rows.length - 1].id,
      messageType: messages.rows[messages.rows.length - 1].type
    });
    // Uma conversa em atendimento humano, fechada ou pausada por política não
    // pode gerar uma execução automática do agente.
    if (routing.decision !== 'continue') {
      publishTrace({ organizationId: job.organizationId, conversationId: job.conversationId, eventType: 'agent.skipped', status: 'skipped', detail: { reason: routing.decision } });
      return;
    }

    const latestMessage = messages.rows[messages.rows.length - 1];
    const safety = await applyLilibagSafetyPolicy({
      organizationId: job.organizationId,
      conversationId: job.conversationId,
      messageId: latestMessage.id,
      body: latestMessage.body
    });
    if (safety.handoff) {
      publishTrace({ organizationId: job.organizationId, conversationId: job.conversationId, eventType: 'agent.handoff', status: 'skipped', detail: { reason: safety.reason } });
      return;
    }

    const playbook = await getLilibagPlaybook(job.organizationId);

    const run = await pool.query<{ id: string }>(
        `INSERT INTO agent_runs
          (organization_id, conversation_id, status, input_message_ids, started_at)
         VALUES ($1, $2, 'running', $3, now())
         RETURNING id`,
        [
          job.organizationId,
          job.conversationId,
          JSON.stringify(messages.rows.map((message) => message.id))
        ]
    );
    publishTrace({ organizationId: job.organizationId, conversationId: job.conversationId, agentRunId: run.rows[0].id, eventType: 'agent.run_started', status: 'running', detail: { inputMessages: messages.rows.length, promptVersion: playbook ? playbook.version : null } });

    try {
      const result = await runner.run({
        runId: run.rows[0].id,
        organizationId: job.organizationId,
        conversationId: job.conversationId,
        messageIds: messages.rows.map((message) => message.id),
        messages: messages.rows.map((message) => ({
          id: message.id,
          direction: message.direction,
          type: message.type,
          body: message.body,
          createdAt: message.created_at.toISOString()
        })),
        instructions: playbook?.instructions,
        promptVersion: playbook ? `${playbook.version}:${playbook.checksum.slice(0, 12)}` : undefined
      });

      const decision = result.status === 'completed' ? parseAgentDecision(result.output.decision) : null;
      if (decision?.action === 'handoff') {
        await handoffConversation(job.conversationId, { reason: decision.handoffReason });
        publishTrace({
          organizationId: job.organizationId,
          conversationId: job.conversationId,
          agentRunId: run.rows[0].id,
          eventType: 'agent.handoff',
          status: 'completed',
          detail: { reason: decision.handoffReason, source: 'structured_decision' }
        });
      }
      const outboundIntent = decision ? await prepareAgentOutbound(job.organizationId, decision) : null;
      let outboundEventId: string | null = null;

      await withTransaction(async (client) => {
        await client.query(
          `UPDATE agent_runs
              SET status = $2, provider = $3, model = $4, prompt_version = $5,
                  output = $6, error_code = $7, error_detail = $8, completed_at = now()
            WHERE id = $1`,
          [run.rows[0].id, result.status, result.provider, result.model, result.promptVersion, JSON.stringify(result.output), result.errorCode ?? null, result.errorDetail ?? null]
        );
        const queued = outboundIntent
          ? await queueOutboundMessageInTransaction(client, job.conversationId, {
              body: outboundIntent.body,
              media: outboundIntent.media,
              idempotencyKey: `agent-run:${run.rows[0].id}:customer-message`
            })
          : null;
        outboundEventId = queued?.eventId ?? null;
      await client.query(
        `INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'agent_run', $2, $3, $4)`,
        [
          job.organizationId,
          run.rows[0].id,
          `agent.run.${result.status}`,
          JSON.stringify({
            conversationId: job.conversationId,
            status: result.status,
            reason: result.output.reason ?? null,
            decision: decision?.action ?? null,
            outboxEventId: queued?.eventId ?? null,
            requestedProductIds: outboundIntent?.requestedProductIds ?? [],
            resolvedProductIds: outboundIntent?.resolvedProductIds ?? []
          })
        ]
      );
      });
      if (outboundEventId) {
        await scheduleOutbound(outboundEventId);
        publishTrace({
          organizationId: job.organizationId,
          conversationId: job.conversationId,
          agentRunId: run.rows[0].id,
          eventType: 'queue.outbound_scheduled',
          status: 'queued',
          detail: { outboxEventId: outboundEventId, mediaCount: outboundIntent?.media.length ?? 0 }
        });
      }
      publishTrace({
        organizationId: job.organizationId,
        conversationId: job.conversationId,
        agentRunId: run.rows[0].id,
        eventType: 'agent.run_finished',
        status: result.status === 'failed' ? 'failed' : result.status === 'completed' ? 'completed' : 'skipped',
        detail: { provider: result.provider, model: result.model, result: result.status, errorCode: result.errorCode ?? null, decision: decision?.action ?? null, mediaCount: outboundIntent?.media.length ?? 0 }
      });
    } catch (error) {
      await pool.query(
        `UPDATE agent_runs SET status = 'failed', error_code = 'agent_execution_failed', completed_at = now() WHERE id = $1`,
        [run.rows[0].id]
      );
      publishTrace({ organizationId: job.organizationId, conversationId: job.conversationId, agentRunId: run.rows[0].id, eventType: 'agent.run_finished', status: 'failed', detail: { errorCode: 'agent_execution_failed' } });
      throw error;
    }
  } finally {
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      lockKey,
      lockValue
    );
  }
}
