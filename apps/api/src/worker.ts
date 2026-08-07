import { Worker } from 'bullmq';
import { config } from './config.js';
import { pool } from './db/client.js';
import { closeQueueConnections, redis, type BlingJob, type ConversationJob, type OutboxJob, type TraceJob } from './queue.js';
import { processBlingCatalogSync } from './services/bling.js';
import { processConversation } from './services/conversation-processor.js';
import { dispatchOutboxEvent } from './services/outbox-dispatcher.js';
import { persistTrace } from './services/operation-traces.js';

const worker = new Worker<ConversationJob>('conversation.process', async (job) => {
  await processConversation(job.data);
}, {
  connection: redis,
  concurrency: config.CONVERSATION_WORKER_CONCURRENCY
});

const outboundWorker = new Worker<OutboxJob>('outbound.dispatch', async (job) => {
  await dispatchOutboxEvent(job.data.eventId, {
    finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
  });
}, { connection: redis, concurrency: config.OUTBOUND_WORKER_CONCURRENCY });

const blingWorker = new Worker<BlingJob>('bling.request', async (job) => {
  await processBlingCatalogSync(job.data.integrationJobId);
}, { connection: redis, concurrency: 3, limiter: { max: 3, duration: 1_000 } });

const traceWorker = new Worker<TraceJob>('operation.trace', async (job) => {
  await persistTrace(job.data);
}, { connection: redis, concurrency: config.TRACE_WORKER_CONCURRENCY });

worker.on('completed', (job) => console.log(JSON.stringify({ level: 'info', event: 'conversation_processed', jobId: job.id })));
worker.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', event: 'conversation_failed', jobId: job?.id, error: error.message })));
outboundWorker.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', event: 'outbound_failed', jobId: job?.id, error: error.message })));
blingWorker.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', event: 'bling_job_failed', jobId: job?.id, error: error.message })));
traceWorker.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', event: 'trace_job_failed', jobId: job?.id, error: error.message })));

async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: 'info', event: 'worker_stopping', signal }));
  await Promise.all([worker.close(), outboundWorker.close(), blingWorker.close(), traceWorker.close()]);
  await closeQueueConnections();
  await pool.end();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

console.log(JSON.stringify({ level: config.LOG_LEVEL, event: 'worker_started', queue: 'conversation.process' }));
