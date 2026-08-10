import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { z } from 'zod';
import { allowLoginAttempt, createSession, requirePanelRole, requirePanelUser, revokeSession } from './auth/sessions.js';
import { hashPassword, verifyPassword } from './auth/passwords.js';
import { normalizeChatAiWebhook } from './channels/chatai-webhook.js';
import { createChatAiSimulationPayload } from './channels/chatai-simulation.js';
import { config } from './config.js';
import { pool } from './db/client.js';
import { blingQueue, conversationQueue, outboundQueue, publishTrace, redis, scheduleBlingJob, scheduleConversation, scheduleOutbound } from './queue.js';
import { requireAdminKey, requireInboundSecret, requirePanelOrigin } from './security.js';
import { catalogSyncRequestSchema, listBlingCatalogSyncRuns, requestBlingCatalogSync } from './services/bling.js';
import { beginBlingAuthorization, blingConnectionInputSchema, completeBlingAuthorization, getBlingConnectionStatus, saveBlingConnection } from './services/bling-oauth.js';
import { addProductMedia, createProduct, productInputSchema, productMediaInputSchema, productUpdateSchema, removeProductMedia, searchProducts, updateProduct } from './services/catalog.js';
import { channelProcessingSchema, chatAiConnectionSchema, chatAiWebhookUrl, generateChatAiWebhook, getPersistedChatAiWebhookUrl, saveChannelProcessing, saveChatAiConnection, validChatAiWebhookToken } from './services/channel-connections.js';
import { assertChannelAccess, channelInputSchema, createChatAiChannel, listOrganizationChannels } from './services/channels.js';
import { handoffConversation, handoffSchema, resumeConversation } from './services/handoff.js';
import { ingestInbound, inboundMessageSchema } from './services/inbound.js';
import { completeProductUpload, createProductUploadIntent, productUploadIntentSchema } from './services/media-assets.js';
import { outboundMessageSchema, queueOutboundMessage } from './services/outbound.js';
import { ensureLilibagPlaybook, getLilibagPlaybook } from './services/lilibag-playbook.js';
import { agentConfigurationInputSchema, agentKeySchema, getAiConfiguration, openAiKeyInputSchema, promptTestInputSchema, saveOpenAiKey, testAgentPrompt, updateAgentConfiguration } from './services/agent-configuration.js';
import { createRoutingPolicy, listRoutingPolicies, routingPolicyInputSchema } from './services/routing.js';
import { getSalesContext } from './services/sales-context.js';
import { getOperationTraceSummary, listOperationTraces } from './services/operation-traces.js';
import { assignTag, createTag, listSubjectTags, listTags, removeTagAssignment, tagAssignmentSchema, tagInputSchema, tagScopeSchema } from './services/tags.js';

const app = Fastify({
  trustProxy: config.TRUST_PROXY,
  bodyLimit: config.API_BODY_LIMIT_BYTES,
  maxParamLength: 512,
  logger: {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'req.headers.x-admin-api-key', 'req.headers.x-webhook-secret',
        'req.body.password', 'req.body.apiToken', 'req.body.clientSecret', 'req.body.accessToken', 'req.body.refreshToken'
      ],
      censor: '[REDACTED]'
    }
  }
});
await app.register(cors, { origin: config.WEB_APP_ORIGIN, credentials: true });
await app.register(helmet, {
  contentSecurityPolicy: false,
  hsts: config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false
});
await app.register(rateLimit, {
  global: true,
  max: config.API_RATE_LIMIT_MAX,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.ip,
  skipOnError: true
});

app.addHook('onRequest', async (request, reply) => {
  if (request.url.split('?', 1)[0].startsWith('/v1/panel/')) return requirePanelOrigin(request, reply);
});
app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('cache-control', 'no-store');
  return payload;
});

app.get('/health', async () => ({ status: 'ok' }));

app.get('/ready', async (_request, reply) => {
  try {
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    return { status: 'ready' };
  } catch {
    return reply.code(503).send({ status: 'unavailable' });
  }
});

app.post('/v1/webhooks/channels/:channelId/inbound', { preHandler: requireInboundSecret, config: { rateLimit: { max: config.WEBHOOK_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (request, reply) => {
  const params = z.object({ channelId: z.string().uuid() }).parse(request.params);
  const payload = inboundMessageSchema.parse(request.body);
  const result = await ingestInbound(params.channelId, payload);
  if (result.duplicate) {
    publishTrace({ organizationId: result.organizationId, channelId: params.channelId, eventType: 'webhook.duplicate', status: 'completed', detail: { provider: 'generic', messageType: payload.type } });
    return reply.code(202).send({ accepted: true, duplicate: true });
  }

  await scheduleConversation({
    organizationId: result.organizationId,
    conversationId: result.conversationId,
    messageId: result.messageId!
  }, result.processingDelayMs);
  publishTrace({ organizationId: result.organizationId, conversationId: result.conversationId, channelId: params.channelId, eventType: 'webhook.received', status: 'received', detail: { provider: 'generic', messageType: payload.type } });
  publishTrace({ organizationId: result.organizationId, conversationId: result.conversationId, channelId: params.channelId, eventType: 'queue.conversation_scheduled', status: 'queued', detail: { delayMs: result.processingDelayMs } });
  return reply.code(202).send({ accepted: true, conversationId: result.conversationId });
});

app.post('/v1/webhooks/chatai/:channelId/:callbackToken', { config: { rateLimit: { max: config.WEBHOOK_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (request, reply) => {
  const params = z.object({ channelId: z.string().uuid(), callbackToken: z.string().min(32).max(200) }).parse(request.params);
  if (!await validChatAiWebhookToken(params.channelId, params.callbackToken)) {
    return reply.code(401).send({ error: 'invalid_webhook_token' });
  }
  const messages = normalizeChatAiWebhook(request.body);
  if (!messages.length) return reply.code(202).send({ accepted: true, ignored: true });

  const results = await Promise.all(messages.map(async (message) => {
    const result = await ingestInbound(params.channelId, message);
    if (!result.duplicate) {
      await scheduleConversation({ organizationId: result.organizationId, conversationId: result.conversationId, messageId: result.messageId! }, result.processingDelayMs);
      publishTrace({ organizationId: result.organizationId, conversationId: result.conversationId, channelId: params.channelId, eventType: 'webhook.received', status: 'received', detail: { provider: 'chatai', messageType: message.type } });
      publishTrace({ organizationId: result.organizationId, conversationId: result.conversationId, channelId: params.channelId, eventType: 'queue.conversation_scheduled', status: 'queued', detail: { delayMs: result.processingDelayMs } });
    } else {
      publishTrace({ organizationId: result.organizationId, channelId: params.channelId, eventType: 'webhook.duplicate', status: 'completed', detail: { provider: 'chatai', messageType: message.type } });
    }
    return result;
  }));
  return reply.code(202).send({ accepted: true, messages: results.length, duplicates: results.filter((item) => item.duplicate).length });
});

app.post('/v1/admin/organizations', { preHandler: requireAdminKey }, async (request, reply) => {
  const body = z.object({ name: z.string().min(2).max(255), slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.body);
  const result = await pool.query<{ id: string; name: string; slug: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug',
    [body.name, body.slug]
  );
  await ensureLilibagPlaybook(result.rows[0].id);
  return reply.code(201).send(result.rows[0]);
});

app.post('/v1/admin/channels', { preHandler: requireAdminKey }, async (request, reply) => {
  const body = z.object({
    organizationId: z.string().uuid(),
    provider: z.string().min(2).max(100),
    externalId: z.string().min(1).max(255),
    displayName: z.string().min(2).max(255)
  }).parse(request.body);
  const result = await pool.query<{ id: string; organization_id: string; provider: string; external_id: string }>(
    `INSERT INTO channels (organization_id, provider, external_id, display_name)
     VALUES ($1, $2, $3, $4) RETURNING id, organization_id, provider, external_id`,
    [body.organizationId, body.provider, body.externalId, body.displayName]
  );
  return reply.code(201).send(result.rows[0]);
});

app.post('/v1/admin/channels/:channelId/chatai', { preHandler: requireAdminKey }, async (request, reply) => {
  const params = z.object({ channelId: z.string().uuid() }).parse(request.params);
  const channel = await pool.query('SELECT id FROM channels WHERE id = $1', [params.channelId]);
  if (!channel.rowCount) return reply.code(404).send({ error: 'channel_not_found' });
  const connection = await saveChatAiConnection(params.channelId, chatAiConnectionSchema.parse(request.body));
  return reply.code(201).send(connection);
});

app.post('/v1/admin/organizations/:organizationId/bling/connection', { preHandler: requireAdminKey }, async (request, reply) => {
  const params = z.object({ organizationId: z.string().uuid() }).parse(request.params);
  return reply.code(201).send(await saveBlingConnection(params.organizationId, blingConnectionInputSchema.parse(request.body)));
});

app.get('/v1/oauth/bling/callback', async (request, reply) => {
  const query = z.object({ code: z.string().min(8).max(2_000).optional(), state: z.string().min(32).max(200), error: z.string().max(255).optional() }).parse(request.query);
  if (query.error || !query.code) return reply.code(400).type('text/html').send(oauthCallbackPage(false));
  try {
    await completeBlingAuthorization({ code: query.code, state: query.state });
    return reply.type('text/html').send(oauthCallbackPage(true));
  } catch {
    return reply.code(400).type('text/html').send(oauthCallbackPage(false));
  }
});

app.post('/v1/admin/users', { preHandler: requireAdminKey }, async (request, reply) => {
  const body = z.object({
    organizationId: z.string().uuid(),
    email: z.string().email().max(255),
    displayName: z.string().min(2).max(255),
    role: z.enum(['owner', 'admin', 'agent', 'viewer']),
    password: z.string().min(12).max(256)
  }).parse(request.body);
  const passwordHash = await hashPassword(body.password);
  const result = await pool.query<{ id: string; organization_id: string; email: string; display_name: string; role: string }>(
    `INSERT INTO users (organization_id, email, display_name, role, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, organization_id, email, display_name, role`,
    [body.organizationId, body.email.toLowerCase(), body.displayName, body.role, passwordHash]
  );
  return reply.code(201).send(result.rows[0]);
});

app.post('/v1/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
  const body = z.object({
    organizationSlug: z.string().regex(/^[a-z0-9-]+$/),
    email: z.string().email().max(255),
    password: z.string().min(1).max(256)
  }).parse(request.body);
  if (!await allowLoginAttempt(request)) return reply.code(429).send({ error: 'too_many_login_attempts' });

  const result = await pool.query<{ id: string; organization_id: string; email: string; display_name: string; role: 'owner' | 'admin' | 'agent' | 'viewer'; password_hash: string | null }>(
    `SELECT u.id, u.organization_id, u.email, u.display_name, u.role, u.password_hash
       FROM users u JOIN organizations o ON o.id = u.organization_id
      WHERE o.slug = $1 AND u.email = $2 AND u.status = 'active'`,
    [body.organizationSlug, body.email.toLowerCase()]
  );
  const user = result.rows[0];
  if (!user || !await verifyPassword(body.password, user.password_hash)) {
    return reply.code(401).send({ error: 'invalid_credentials' });
  }
  await createSession(reply, user.id);
  return {
    id: user.id,
    organizationId: user.organization_id,
    email: user.email,
    displayName: user.display_name,
    role: user.role
  };
});

app.post('/v1/auth/logout', { preHandler: requirePanelUser }, async (request, reply) => {
  await revokeSession(request, reply);
  return reply.code(204).send();
});

app.get('/v1/panel/me', { preHandler: requirePanelUser }, async (request) => request.panelUser);

app.get('/v1/admin/conversations', { preHandler: requireAdminKey }, async (request) => {
  const query = z.object({ organizationId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
  const result = await pool.query(
    `SELECT c.id, c.status, c.last_message_at, c.created_at,
            ct.name AS contact_name, ct.phone_e164, ch.display_name AS channel_name
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE c.organization_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT $2`,
    [query.organizationId, query.limit]
  );
  return { data: result.rows };
});

app.get('/v1/admin/conversations/:conversationId/messages', { preHandler: requireAdminKey }, async (request) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  const result = await pool.query(
    `SELECT id, direction, type, body, media, metadata, delivery_status, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500`,
    [params.conversationId]
  );
  return { data: result.rows };
});

app.post('/v1/admin/conversations/:conversationId/handoff', { preHandler: requireAdminKey }, async (request) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  return handoffConversation(params.conversationId, handoffSchema.parse(request.body));
});

app.post('/v1/admin/conversations/:conversationId/resume', { preHandler: requireAdminKey }, async (request) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  return resumeConversation(params.conversationId);
});

app.post('/v1/admin/conversations/:conversationId/messages', { preHandler: requireAdminKey }, async (request, reply) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  const queued = await queueOutboundMessage(params.conversationId, outboundMessageSchema.parse(request.body));
  if (queued.duplicate) return reply.code(202).send({ accepted: true, duplicate: true });
  await scheduleOutbound(queued.eventId!);
  return reply.code(202).send({ accepted: true, outboxEventId: queued.eventId });
});

app.post('/v1/admin/outbox/:eventId/retry', { preHandler: requireAdminKey }, async (request, reply) => {
  const params = z.object({ eventId: z.string().uuid() }).parse(request.params);
  const retried = await pool.query<{ id: string }>(
    `UPDATE outbox_events SET status = 'pending', available_at = now()
      WHERE id = $1 AND status IN ('failed', 'waiting_configuration') AND event_type = 'message.send'
      RETURNING id`,
    [params.eventId]
  );
  if (!retried.rowCount) return reply.code(404).send({ error: 'outbox_event_not_retryable' });
  await scheduleOutbound(params.eventId);
  return reply.code(202).send({ accepted: true, outboxEventId: params.eventId });
});

app.post('/v1/admin/products', { preHandler: requireAdminKey }, async (request, reply) => {
  const product = await createProduct(productInputSchema.parse(request.body));
  return reply.code(201).send(product);
});

app.get('/v1/admin/products', { preHandler: requireAdminKey }, async (request) => {
  const query = z.object({
    organizationId: z.string().uuid(),
    q: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30)
  }).parse(request.query);
  return { data: await searchProducts(query.organizationId, query.q, query.limit) };
});

app.post('/v1/admin/bling/sync-catalog', { preHandler: requireAdminKey }, async (request, reply) => {
  const body = z.object({ organizationId: z.string().uuid() }).merge(catalogSyncRequestSchema).parse(request.body);
  const requested = await requestBlingCatalogSync(body.organizationId, body.mode);
  if (!requested.duplicate) await scheduleBlingJob(requested.integrationJobId!);
  return reply.code(202).send({ accepted: true, duplicate: requested.duplicate, integrationJobId: requested.integrationJobId });
});

app.post('/v1/admin/tags', { preHandler: requireAdminKey }, async (request, reply) => {
  const body = tagInputSchema.extend({ organizationId: z.string().uuid() }).parse(request.body);
  return reply.code(201).send(await createTag(body.organizationId, body));
});

app.get('/v1/admin/tags', { preHandler: requireAdminKey }, async (request) => {
  const query = z.object({ organizationId: z.string().uuid(), scope: tagScopeSchema.optional() }).parse(request.query);
  return { data: await listTags(query.organizationId, query.scope) };
});

app.post('/v1/admin/conversations/:conversationId/tags', { preHandler: requireAdminKey }, async (request, reply) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  const body = tagAssignmentSchema.extend({ organizationId: z.string().uuid() }).parse(request.body);
  return reply.code(201).send(await assignTag(body.organizationId, 'conversation', params.conversationId, body.tagSlug, body.source));
});

app.post('/v1/admin/routing-policies', { preHandler: requireAdminKey }, async (request, reply) => {
  const body = routingPolicyInputSchema.extend({ organizationId: z.string().uuid() }).parse(request.body);
  return reply.code(201).send(await createRoutingPolicy(body.organizationId, body));
});

app.get('/v1/admin/queues', { preHandler: requireAdminKey }, async () => {
  const states = ['waiting', 'active', 'delayed', 'failed'] as const;
  const [conversationProcessing, outboundDispatch, blingRequests] = await Promise.all([
    conversationQueue.getJobCounts(...states),
    outboundQueue.getJobCounts(...states),
    blingQueue.getJobCounts(...states)
  ]);
  return { conversationProcessing, outboundDispatch, blingRequests };
});

app.get('/v1/panel/conversations', { preHandler: requirePanelUser }, async (request) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
  const result = await pool.query(
    `SELECT c.id, c.status, c.last_message_at, c.created_at,
            ct.name AS contact_name, ct.phone_e164, ch.display_name AS channel_name
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE c.organization_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT $2`,
    [request.panelUser!.organizationId, query.limit]
  );
  return { data: result.rows };
});

app.get('/v1/panel/traces', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(80), conversationId: z.string().uuid().optional() }).parse(request.query);
  return { data: await listOperationTraces(request.panelUser!.organizationId, query) };
});

app.get('/v1/panel/traces/summary', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  return getOperationTraceSummary(request.panelUser!.organizationId);
});

app.get('/v1/panel/tags', { preHandler: requirePanelUser }, async (request) => {
  const query = z.object({ scope: tagScopeSchema.optional() }).parse(request.query);
  return { data: await listTags(request.panelUser!.organizationId, query.scope) };
});

app.get('/v1/panel/integrations/bling', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  return getBlingConnectionStatus(request.panelUser!.organizationId);
});

app.get('/v1/panel/channels', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  return { data: await listOrganizationChannels(request.panelUser!.organizationId) };
});

app.post('/v1/panel/channels', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  return reply.code(201).send(await createChatAiChannel(request.panelUser!.organizationId, channelInputSchema.parse(request.body)));
});

app.post('/v1/panel/channels/:channelId/chatai', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const params = z.object({ channelId: z.string().uuid() }).parse(request.params);
  await assertChannelAccess(params.channelId, request.panelUser!.organizationId);
  const connection = await saveChatAiConnection(params.channelId, chatAiConnectionSchema.parse(request.body));
  const webhookUrl = connection.callbackToken ? chatAiWebhookUrl(params.channelId, connection.callbackToken) : null;
  return reply.code(201).send({
    channelId: connection.channel_id,
    status: connection.status,
    backendUrl: connection.backend_url,
    webhookUrl,
    webhookUrlAvailable: Boolean(webhookUrl)
  });
});

app.post('/v1/panel/channels/:channelId/webhook', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const params = z.object({ channelId: z.string().uuid() }).parse(request.params);
  await assertChannelAccess(params.channelId, request.panelUser!.organizationId);
  const connection = await generateChatAiWebhook(params.channelId, channelProcessingSchema.parse(request.body));
  const webhookUrl = chatAiWebhookUrl(params.channelId, connection.callbackToken);
  return reply.code(201).send({
    channelId: connection.channel_id,
    status: connection.status,
    webhookUrl,
    webhookUrlAvailable: Boolean(webhookUrl)
  });
});

app.get('/v1/panel/channels/:channelId/webhook', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  const params = z.object({ channelId: z.string().uuid() }).parse(request.params);
  await assertChannelAccess(params.channelId, request.panelUser!.organizationId);
  const webhookUrl = await getPersistedChatAiWebhookUrl(params.channelId);
  return { channelId: params.channelId, webhookUrl, webhookUrlAvailable: Boolean(webhookUrl) };
});

app.post('/v1/panel/channels/:channelId/simulate-inbound', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const params = z.object({ channelId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    message: z.string().min(1).max(2_000),
    contactName: z.string().min(1).max(120).default('Contato de teste'),
    phoneE164: z.string().min(8).max(20).default('+5511999990000'),
    queueId: z.number().int().min(0).max(1_000_000).default(0)
  }).parse(request.body);
  await assertChannelAccess(params.channelId, request.panelUser!.organizationId);
  const normalized = normalizeChatAiWebhook(createChatAiSimulationPayload(body));
  if (!normalized.length) return reply.code(422).send({ error: 'simulation_normalization_failed' });
  const result = await ingestInbound(params.channelId, normalized[0]);
  if (!result.duplicate) {
    await scheduleConversation({ organizationId: result.organizationId, conversationId: result.conversationId, messageId: result.messageId! }, result.processingDelayMs);
    publishTrace({ organizationId: result.organizationId, conversationId: result.conversationId, channelId: params.channelId, eventType: 'webhook.simulated', status: 'received', detail: { provider: 'chatai_simulator', messageType: normalized[0].type } });
    publishTrace({ organizationId: result.organizationId, conversationId: result.conversationId, channelId: params.channelId, eventType: 'queue.conversation_scheduled', status: 'queued', detail: { delayMs: result.processingDelayMs, source: 'simulation' } });
  }
  return reply.code(202).send({ accepted: true, duplicate: result.duplicate, conversationId: result.conversationId, normalized: { type: normalized[0].type, body: normalized[0].body, externalContactId: normalized[0].externalContactId } });
});

app.put('/v1/panel/channels/:channelId/processing', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  const params = z.object({ channelId: z.string().uuid() }).parse(request.params);
  await assertChannelAccess(params.channelId, request.panelUser!.organizationId);
  return saveChannelProcessing(params.channelId, channelProcessingSchema.parse(request.body));
});

app.put('/v1/panel/integrations/bling/connection', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  return saveBlingConnection(request.panelUser!.organizationId, blingConnectionInputSchema.parse(request.body));
});

app.get('/v1/panel/integrations/bling/catalog-sync-runs', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) }).parse(request.query);
  return { data: await listBlingCatalogSyncRuns(request.panelUser!.organizationId, query.limit) };
});

app.get('/v1/panel/ai/configuration', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  return getAiConfiguration(request.panelUser!.organizationId);
});

app.post('/v1/panel/ai/openai-key', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  return reply.code(201).send(await saveOpenAiKey(request.panelUser!.organizationId, openAiKeyInputSchema.parse(request.body)));
});

app.put('/v1/panel/ai/agents/:agentKey', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  const params = z.object({ agentKey: agentKeySchema }).parse(request.params);
  return updateAgentConfiguration(request.panelUser!.organizationId, params.agentKey, agentConfigurationInputSchema.parse(request.body));
});

app.post('/v1/panel/ai/prompt-test', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  return testAgentPrompt(request.panelUser!.organizationId, promptTestInputSchema.parse(request.body));
});

app.post('/v1/panel/integrations/bling/authorization', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  return reply.code(201).send(await beginBlingAuthorization(request.panelUser!.organizationId));
});

app.post('/v1/panel/integrations/bling/catalog-sync', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const body = catalogSyncRequestSchema.parse(request.body);
  const requested = await requestBlingCatalogSync(request.panelUser!.organizationId, body.mode);
  if (!requested.duplicate) await scheduleBlingJob(requested.integrationJobId!);
  return reply.code(202).send({ accepted: true, duplicate: requested.duplicate, integrationJobId: requested.integrationJobId });
});

app.post('/v1/panel/tags', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  return reply.code(201).send(await createTag(request.panelUser!.organizationId, tagInputSchema.parse(request.body)));
});

app.get('/v1/panel/conversations/:conversationId/tags', { preHandler: requirePanelUser }, async (request) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  await assertConversationAccess(params.conversationId, request.panelUser!.organizationId);
  return { data: await listSubjectTags(request.panelUser!.organizationId, 'conversation', params.conversationId) };
});

app.get('/v1/panel/conversations/:conversationId/sales-context', { preHandler: requirePanelUser }, async (request) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  await assertConversationAccess(params.conversationId, request.panelUser!.organizationId);
  return getSalesContext(request.panelUser!.organizationId, params.conversationId);
});

app.post('/v1/panel/conversations/:conversationId/tags', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin', 'agent')] }, async (request, reply) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  await assertConversationAccess(params.conversationId, request.panelUser!.organizationId);
  const body = tagAssignmentSchema.parse(request.body);
  return reply.code(201).send(await assignTag(request.panelUser!.organizationId, 'conversation', params.conversationId, body.tagSlug, body.source));
});

app.delete('/v1/panel/conversations/:conversationId/tags/:tagSlug', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin', 'agent')] }, async (request, reply) => {
  const params = z.object({ conversationId: z.string().uuid(), tagSlug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }).parse(request.params);
  await assertConversationAccess(params.conversationId, request.panelUser!.organizationId);
  const removed = await removeTagAssignment(request.panelUser!.organizationId, 'conversation', params.conversationId, params.tagSlug);
  if (!removed) return reply.code(404).send({ error: 'tag_assignment_not_found' });
  return reply.code(204).send();
});

app.get('/v1/panel/routing-policies', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  return { data: await listRoutingPolicies(request.panelUser!.organizationId) };
});

app.get('/v1/panel/agent/playbook', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const playbook = await getLilibagPlaybook(request.panelUser!.organizationId) ?? await ensureLilibagPlaybook(request.panelUser!.organizationId);
  return { id: playbook.id, name: 'lilibag-sales', version: playbook.version, checksum: playbook.checksum, instructions: playbook.instructions };
});

app.post('/v1/panel/agent/playbook/bootstrap', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const playbook = await ensureLilibagPlaybook(request.panelUser!.organizationId);
  return reply.code(201).send({ id: playbook!.id, name: 'lilibag-sales', version: playbook!.version, checksum: playbook!.checksum });
});

app.post('/v1/panel/routing-policies', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  return reply.code(201).send(await createRoutingPolicy(request.panelUser!.organizationId, routingPolicyInputSchema.parse(request.body)));
});

app.get('/v1/panel/conversations/:conversationId/messages', { preHandler: requirePanelUser }, async (request) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  await assertConversationAccess(params.conversationId, request.panelUser!.organizationId);
  const result = await pool.query(
    `SELECT id, direction, type, body, media, metadata, delivery_status, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500`,
    [params.conversationId]
  );
  return { data: result.rows };
});

app.post('/v1/panel/conversations/:conversationId/handoff', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin', 'agent')] }, async (request) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  await assertConversationAccess(params.conversationId, request.panelUser!.organizationId);
  return handoffConversation(params.conversationId, handoffSchema.parse(request.body));
});

app.post('/v1/panel/conversations/:conversationId/resume', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin', 'agent')] }, async (request) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  await assertConversationAccess(params.conversationId, request.panelUser!.organizationId);
  return resumeConversation(params.conversationId);
});

app.post('/v1/panel/conversations/:conversationId/messages', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin', 'agent')] }, async (request, reply) => {
  const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
  await assertConversationAccess(params.conversationId, request.panelUser!.organizationId);
  const queued = await queueOutboundMessage(params.conversationId, outboundMessageSchema.parse(request.body));
  if (queued.duplicate) return reply.code(202).send({ accepted: true, duplicate: true });
  await scheduleOutbound(queued.eventId!);
  return reply.code(202).send({ accepted: true, outboxEventId: queued.eventId });
});

app.get('/v1/panel/products', { preHandler: requirePanelUser }, async (request) => {
  const query = z.object({ q: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
  return { data: await searchProducts(request.panelUser!.organizationId, query.q, query.limit) };
});

app.post('/v1/panel/products', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const body = productInputSchema.omit({ organizationId: true }).parse(request.body);
  const product = await createProduct({ ...body, organizationId: request.panelUser!.organizationId });
  return reply.code(201).send(product);
});

app.patch('/v1/panel/products/:productId', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request) => {
  const params = z.object({ productId: z.string().uuid() }).parse(request.params);
  return updateProduct(request.panelUser!.organizationId, params.productId, productUpdateSchema.parse(request.body));
});

app.post('/v1/panel/products/:productId/media', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const params = z.object({ productId: z.string().uuid() }).parse(request.params);
  const media = await addProductMedia(request.panelUser!.organizationId, params.productId, productMediaInputSchema.parse(request.body));
  return reply.code(201).send(media);
});

app.post('/v1/panel/products/:productId/media/upload-intents', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const params = z.object({ productId: z.string().uuid() }).parse(request.params);
  const intent = await createProductUploadIntent(request.panelUser!.organizationId, params.productId, productUploadIntentSchema.parse(request.body));
  return reply.code(201).send(intent);
});

app.post('/v1/panel/products/:productId/media/uploads/:assetId/complete', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const params = z.object({ productId: z.string().uuid(), assetId: z.string().uuid() }).parse(request.params);
  const media = await completeProductUpload(request.panelUser!.organizationId, params.productId, params.assetId);
  return reply.code(201).send(media);
});

app.delete('/v1/panel/products/:productId/media/:mediaId', { preHandler: [requirePanelUser, requirePanelRole('owner', 'admin')] }, async (request, reply) => {
  const params = z.object({ productId: z.string().uuid(), mediaId: z.string().uuid() }).parse(request.params);
  const removed = await removeProductMedia(request.panelUser!.organizationId, params.productId, params.mediaId);
  if (!removed) return reply.code(404).send({ error: 'product_media_not_found' });
  return reply.code(204).send();
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    const response: { error: string; details?: ReturnType<typeof error.flatten> } = { error: 'invalid_request' };
    if (config.NODE_ENV !== 'production') response.details = error.flatten();
    return reply.code(400).send(response);
  }
  if (error instanceof Error && (error.message === 'channel_not_found_or_inactive' || error.message === 'channel_not_found' || error.message === 'conversation_not_found' || error.message === 'conversation_not_available' || error.message === 'product_not_found' || error.message === 'media_asset_not_found' || error.message === 'media_asset_not_linked' || error.message === 'tag_not_found' || error.message === 'tag_assignment_not_found' || error.message === 'routing_policy_tag_not_found' || error.message === 'agent_playbook_not_found')) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof Error && (error.message === 'media_storage_not_configured' || error.message === 'media_object_invalid' || error.message === 'data_encryption_key_not_configured' || error.message === 'data_encryption_key_invalid' || error.message === 'bling_connection_not_configured' || error.message === 'bling_oauth_redirect_uri_not_configured')) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof Error && error.message === 'sales_context_sensitive_fact_not_allowed') return reply.code(400).send({ error: error.message });
  app.log.error(error);
  return reply.code(500).send({ error: 'internal_error' });
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'api_stopping');
  await app.close();
  await Promise.all([conversationQueue.close(), outboundQueue.close(), blingQueue.close()]);
  await redis.quit();
  await pool.end();
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });

async function assertConversationAccess(conversationId: string, organizationId: string): Promise<void> {
  const result = await pool.query('SELECT 1 FROM conversations WHERE id = $1 AND organization_id = $2', [conversationId, organizationId]);
  if (!result.rowCount) throw new Error('conversation_not_available');
}

function oauthCallbackPage(success: boolean): string {
  const title = success ? 'Bling conectado' : 'Não foi possível conectar o Bling';
  const message = success ? 'A autorização foi concluída. Você já pode voltar ao painel.' : 'A autorização expirou, foi recusada ou não pôde ser validada. Volte ao painel e tente novamente.';
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:560px;margin:12vh auto;padding:24px;color:#203e34"><h1>${title}</h1><p>${message}</p></body></html>`;
}
