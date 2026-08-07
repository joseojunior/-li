import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

function sameSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export async function requireInboundSecret(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const received = request.headers['x-webhook-secret'];
  if (!sameSecret(typeof received === 'string' ? received : undefined, config.INBOUND_WEBHOOK_SECRET)) {
    await reply.code(401).send({ error: 'invalid_webhook_secret' });
  }
}

export async function requireAdminKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const received = request.headers['x-admin-api-key'];
  if (!sameSecret(typeof received === 'string' ? received : undefined, config.ADMIN_API_KEY)) {
    await reply.code(401).send({ error: 'invalid_admin_key' });
  }
}

/** Cookie authentication is only accepted for writes originating in the panel. */
export async function requirePanelOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (request.headers.origin !== config.WEB_APP_ORIGIN) {
    await reply.code(403).send({ error: 'invalid_panel_origin' });
  }
}
