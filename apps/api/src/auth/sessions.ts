import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { redis } from '../queue.js';

const cookieName = 'lilibag_session';

export type PanelUser = {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
};

declare module 'fastify' {
  interface FastifyRequest {
    panelUser?: PanelUser;
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  return header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function appendSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1_000);
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  reply.header('set-cookie', `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(reply: FastifyReply): void {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  reply.header('set-cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

export async function createSession(reply: FastifyReply, userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.AUTH_SESSION_TTL_DAYS * 86_400_000);
  await pool.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash(token), expiresAt]
  );
  appendSessionCookie(reply, token, expiresAt);
}

export async function revokeSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = readCookie(request, cookieName);
  if (token) await pool.query('UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash(token)]);
  clearSessionCookie(reply);
}

async function lookupSession(request: FastifyRequest): Promise<PanelUser | null> {
  const token = readCookie(request, cookieName);
  if (!token) return null;
  const result = await pool.query<PanelUser>(
    `SELECT u.id, u.organization_id AS "organizationId", u.email, u.display_name AS "displayName", u.role
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [tokenHash(token)]
  );
  if (!result.rowCount) return null;
  await pool.query('UPDATE user_sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash(token)]);
  return result.rows[0];
}

export const requirePanelUser: preHandlerHookHandler = async (request, reply) => {
  const user = await lookupSession(request);
  if (!user) return reply.code(401).send({ error: 'authentication_required' });
  request.panelUser = user;
};

export function requirePanelRole(...roles: PanelUser['role'][]): preHandlerHookHandler {
  return async (request, reply) => {
    const user = request.panelUser;
    if (!user) return reply.code(401).send({ error: 'authentication_required' });
    if (!roles.includes(user.role)) return reply.code(403).send({ error: 'insufficient_role' });
  };
}

export async function allowLoginAttempt(request: FastifyRequest): Promise<boolean> {
  const key = `rate:login:${createHash('sha256').update(request.ip).digest('hex')}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count <= 10;
}
