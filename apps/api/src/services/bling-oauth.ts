import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../security/encryption.js';

const AUTHORIZE_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const TOKEN_URL = 'https://api.bling.com.br/Api/v3/oauth/token';
const STATE_TTL_MINUTES = 10;

export const blingConnectionInputSchema = z.object({
  clientId: z.string().min(8).max(500),
  clientSecret: z.string().min(16).max(2_000)
});

type EncryptedConnection = {
  organization_id: string;
  client_id: string;
  client_secret_ciphertext: string;
  client_secret_iv: string;
  client_secret_auth_tag: string;
  access_token_ciphertext: string | null;
  access_token_iv: string | null;
  access_token_auth_tag: string | null;
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  refresh_token_auth_tag: string | null;
  access_token_expires_at: Date | null;
  status: 'pending' | 'active' | 'disabled' | 'error';
};

type BlingTokenResponse = { access_token: string; refresh_token: string; expires_in?: number };
type ConnectionStatusRow = {
  client_id: string;
  status: 'pending' | 'active' | 'disabled' | 'error';
  access_token_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type PublicConnectionStatus = {
  status: 'not_configured' | 'pending' | 'active' | 'disabled' | 'error';
  clientIdHint?: string;
  accessTokenExpiresAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export async function saveBlingConnection(organizationId: string, input: z.infer<typeof blingConnectionInputSchema>) {
  const clientSecret = encryptSecret(input.clientSecret);
  const result = await pool.query(
    `INSERT INTO bling_connections
       (organization_id, client_id, client_secret_ciphertext, client_secret_iv, client_secret_auth_tag, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (organization_id) DO UPDATE
       SET client_id = EXCLUDED.client_id,
           client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
           client_secret_iv = EXCLUDED.client_secret_iv,
           client_secret_auth_tag = EXCLUDED.client_secret_auth_tag,
           access_token_ciphertext = NULL,
           access_token_iv = NULL,
           access_token_auth_tag = NULL,
           refresh_token_ciphertext = NULL,
           refresh_token_iv = NULL,
           refresh_token_auth_tag = NULL,
           access_token_expires_at = NULL,
           status = 'pending',
           updated_at = now()
     RETURNING organization_id, client_id, status, updated_at`,
    [organizationId, input.clientId, clientSecret.ciphertext, clientSecret.iv, clientSecret.authTag]
  );
  await pool.query(
    `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id)
     VALUES ($1, 'user', 'bling.connection_saved', 'bling_connection', $1)`,
    [organizationId]
  );
  return toPublicConnectionStatus(result.rows[0]);
}

export async function getBlingConnectionStatus(organizationId: string): Promise<PublicConnectionStatus> {
  const result = await pool.query<ConnectionStatusRow>(
    `SELECT client_id, status, access_token_expires_at, created_at, updated_at
       FROM bling_connections WHERE organization_id = $1`,
    [organizationId]
  );
  return result.rowCount ? toPublicConnectionStatus(result.rows[0]) : { status: 'not_configured' };
}

export async function beginBlingAuthorization(organizationId: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const connection = await pool.query<{ client_id: string }>(
    `SELECT client_id FROM bling_connections WHERE organization_id = $1 AND status IN ('pending', 'active')`,
    [organizationId]
  );
  if (!connection.rowCount) throw new Error('bling_connection_not_configured');
  const redirectUri = configuredRedirectUri();
  const state = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60_000);
  await pool.query(
    `INSERT INTO bling_oauth_states (organization_id, state_hash, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, sha256(state), redirectUri, expiresAt]
  );
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', connection.rows[0].client_id);
  url.searchParams.set('state', state);
  return { authorizationUrl: url.toString(), expiresAt: expiresAt.toISOString() };
}

export async function completeBlingAuthorization(input: { code: string; state: string }): Promise<{ organizationId: string }> {
  const oauthState = await withTransaction(async (client) => {
    const consumed = await client.query<{ organization_id: string }>(
      `UPDATE bling_oauth_states
          SET consumed_at = now()
        WHERE state_hash = $1 AND expires_at > now() AND consumed_at IS NULL
        RETURNING organization_id`,
      [sha256(input.state)]
    );
    if (!consumed.rowCount) throw new Error('bling_oauth_state_invalid');
    return consumed.rows[0];
  });

  const connection = await getEncryptedConnection(oauthState.organization_id);
  const token = await exchangeAuthorizationCode(connection, input.code);
  await persistToken(oauthState.organization_id, token);
  return { organizationId: oauthState.organization_id };
}

/** Retorna um access token válido exclusivamente para workers de integração. */
export async function getValidBlingAccessToken(organizationId: string): Promise<string> {
  const connection = await getEncryptedConnection(organizationId);
  if (connection.status !== 'active' || !connection.access_token_ciphertext || !connection.access_token_iv || !connection.access_token_auth_tag) {
    throw new Error('bling_connection_not_active');
  }
  const expiresSoon = !connection.access_token_expires_at || connection.access_token_expires_at.getTime() <= Date.now() + 120_000;
  if (!expiresSoon) {
    return decryptSecret({ ciphertext: connection.access_token_ciphertext, iv: connection.access_token_iv, authTag: connection.access_token_auth_tag });
  }
  if (!connection.refresh_token_ciphertext || !connection.refresh_token_iv || !connection.refresh_token_auth_tag) throw new Error('bling_refresh_token_missing');

  const refreshToken = decryptSecret({ ciphertext: connection.refresh_token_ciphertext, iv: connection.refresh_token_iv, authTag: connection.refresh_token_auth_tag });
  const token = await requestToken(connection, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }));
  await persistToken(organizationId, token);
  return token.access_token;
}

function configuredRedirectUri(): string {
  if (config.BLING_OAUTH_REDIRECT_URI) return config.BLING_OAUTH_REDIRECT_URI;
  if (config.APP_PUBLIC_URL) return new URL('/v1/oauth/bling/callback', config.APP_PUBLIC_URL).toString();
  throw new Error('bling_oauth_redirect_uri_not_configured');
}

async function getEncryptedConnection(organizationId: string): Promise<EncryptedConnection> {
  const result = await pool.query<EncryptedConnection>(
    `SELECT organization_id, client_id, client_secret_ciphertext, client_secret_iv, client_secret_auth_tag,
            access_token_ciphertext, access_token_iv, access_token_auth_tag,
            refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag,
            access_token_expires_at, status
       FROM bling_connections WHERE organization_id = $1`,
    [organizationId]
  );
  if (!result.rowCount) throw new Error('bling_connection_not_configured');
  return result.rows[0];
}

async function exchangeAuthorizationCode(connection: EncryptedConnection, code: string): Promise<BlingTokenResponse> {
  return requestToken(connection, new URLSearchParams({ grant_type: 'authorization_code', code }));
}

async function requestToken(connection: EncryptedConnection, body: URLSearchParams): Promise<BlingTokenResponse> {
  const clientSecret = decryptSecret({
    ciphertext: connection.client_secret_ciphertext,
    iv: connection.client_secret_iv,
    authTag: connection.client_secret_auth_tag
  });
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${connection.client_id}:${clientSecret}`).toString('base64')}`,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'enable-jwt': '1'
      },
      body
    });
  } catch {
    throw new Error('bling_oauth_network_error');
  }
  if (!response.ok) throw new Error('bling_oauth_token_exchange_failed');
  const parsed = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.coerce.number().int().positive().optional()
  }).safeParse(await response.json());
  if (!parsed.success) throw new Error('bling_oauth_token_response_invalid');
  return parsed.data;
}

async function persistToken(organizationId: string, token: BlingTokenResponse): Promise<void> {
  const accessToken = encryptSecret(token.access_token);
  const refreshToken = encryptSecret(token.refresh_token);
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 21_600) * 1_000);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE bling_connections
          SET access_token_ciphertext = $2, access_token_iv = $3, access_token_auth_tag = $4,
              refresh_token_ciphertext = $5, refresh_token_iv = $6, refresh_token_auth_tag = $7,
              access_token_expires_at = $8, status = 'active', updated_at = now()
        WHERE organization_id = $1`,
      [organizationId, accessToken.ciphertext, accessToken.iv, accessToken.authTag, refreshToken.ciphertext, refreshToken.iv, refreshToken.authTag, expiresAt]
    );
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, entity_id, detail)
       VALUES ($1, 'integration', 'bling.authorization_completed', 'bling_connection', $1, $2)`,
      [organizationId, JSON.stringify({ accessTokenExpiresAt: expiresAt.toISOString() })]
    );
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toPublicConnectionStatus(connection: ConnectionStatusRow): PublicConnectionStatus {
  const visibleSuffix = connection.client_id.slice(-6);
  return {
    status: connection.status,
    clientIdHint: `••••••${visibleSuffix}`,
    accessTokenExpiresAt: connection.access_token_expires_at?.toISOString() ?? null,
    createdAt: connection.created_at.toISOString(),
    updatedAt: connection.updated_at.toISOString()
  };
}
