import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import type { TraceEvent } from './services/operation-traces.js';

export type ConversationJob = {
  organizationId: string;
  conversationId: string;
  messageId: string;
};

export type OutboxJob = { eventId: string };
export type BlingJob = { integrationJobId: string };
export type TraceJob = TraceEvent;

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const conversationQueue = new Queue<ConversationJob>('conversation.process', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: 500,
    removeOnFail: 2_000
  }
});

export const outboundQueue = new Queue<OutboxJob>('outbound.dispatch', {
  connection: redis,
  defaultJobOptions: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000
  }
});

export const blingQueue = new Queue<BlingJob>('bling.request', {
  connection: redis,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: 500,
    removeOnFail: 2_000
  }
});

export const traceQueue = new Queue<TraceJob>('operation.trace', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: 2_000,
    removeOnFail: 5_000
  }
});

export async function scheduleConversation(job: ConversationJob, delay = config.CONVERSATION_DEBOUNCE_MS): Promise<void> {
  await conversationQueue.add('process', job, {
    jobId: `message-${job.messageId}`,
    delay
  });
}

export async function scheduleOutbound(eventId: string): Promise<void> {
  await outboundQueue.add('dispatch', { eventId }, { jobId: `outbox-${eventId}` });
}

export async function scheduleBlingJob(integrationJobId: string): Promise<void> {
  await blingQueue.add('request', { integrationJobId }, { jobId: `bling-${integrationJobId}` });
}

export async function scheduleTrace(event: TraceJob): Promise<void> {
  await traceQueue.add('persist', event);
}

export function publishTrace(event: TraceJob): void {
  void scheduleTrace(event).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown_trace_queue_error';
    console.error(JSON.stringify({ level: 'warn', event: 'trace_enqueue_failed', error: message }));
  });
}

export async function closeQueueConnections(): Promise<void> {
  await Promise.all([conversationQueue.close(), outboundQueue.close(), blingQueue.close(), traceQueue.close()]);
  await redis.quit();
}
