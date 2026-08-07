import { hashPassword } from '../auth/passwords.js';
import { config } from '../config.js';
import { ensureLilibagPlaybook } from '../services/lilibag-playbook.js';
import { pool } from './client.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} e obrigatorio.`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

if (config.NODE_ENV === 'production') {
  throw new Error('O bootstrap local nao pode ser executado em producao.');
}

const organizationName = optional('BOOTSTRAP_ORGANIZATION_NAME', 'Lilibag Local');
const organizationSlug = optional('BOOTSTRAP_ORGANIZATION_SLUG', 'lilibag-local');
const adminEmail = required('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
const adminName = optional('BOOTSTRAP_ADMIN_NAME', 'Administrador Local');
const adminPassword = required('BOOTSTRAP_ADMIN_PASSWORD');

if (!/^[a-z0-9-]+$/.test(organizationSlug)) {
  throw new Error('BOOTSTRAP_ORGANIZATION_SLUG deve conter apenas letras minusculas, numeros e hifens.');
}
if (!/^\S+@\S+\.\S+$/.test(adminEmail)) {
  throw new Error('BOOTSTRAP_ADMIN_EMAIL deve ser um e-mail valido.');
}
if (adminPassword.length < 12) {
  throw new Error('BOOTSTRAP_ADMIN_PASSWORD precisa ter pelo menos 12 caracteres.');
}

try {
  const organization = await pool.query<{ id: string; slug: string }>(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, slug`,
    [organizationName, organizationSlug]
  );
  const organizationId = organization.rows[0].id;

  const existingUser = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE organization_id = $1 AND email = $2',
    [organizationId, adminEmail]
  );

  let accountCreated = false;
  if (!existingUser.rowCount) {
    const passwordHash = await hashPassword(adminPassword);
    await pool.query(
      `INSERT INTO users (organization_id, email, display_name, role, password_hash)
       VALUES ($1, $2, $3, 'owner', $4)`,
      [organizationId, adminEmail, adminName, passwordHash]
    );
    accountCreated = true;
  } else {
    await pool.query(
      `UPDATE users
          SET display_name = $3, role = 'owner', status = 'active'
        WHERE organization_id = $1 AND email = $2`,
      [organizationId, adminEmail, adminName]
    );
  }

  await ensureLilibagPlaybook(organizationId);
  console.log(JSON.stringify({
    status: 'ready',
    organizationSlug,
    adminEmail,
    account: accountCreated ? 'created' : 'already_exists',
    message: 'Entre no painel usando o slug, e-mail e a senha informada neste comando.'
  }, null, 2));
} finally {
  await pool.end();
}
