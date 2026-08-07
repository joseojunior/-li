ALTER TABLE products
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bling')),
  ADD COLUMN external_product_id text,
  ADD COLUMN inventory_quantity integer CHECK (inventory_quantity IS NULL OR inventory_quantity >= 0),
  ADD COLUMN inventory_updated_at timestamptz,
  ADD COLUMN source_updated_at timestamptz,
  ADD COLUMN sync_hash char(64),
  ADD COLUMN last_synced_at timestamptz;

CREATE UNIQUE INDEX products_bling_external_id_idx
  ON products (organization_id, source, external_product_id)
  WHERE external_product_id IS NOT NULL;

CREATE TABLE bling_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  client_secret_ciphertext text NOT NULL,
  client_secret_iv text NOT NULL,
  client_secret_auth_tag text NOT NULL,
  access_token_ciphertext text,
  access_token_iv text,
  access_token_auth_tag text,
  refresh_token_ciphertext text,
  refresh_token_iv text,
  refresh_token_auth_tag text,
  access_token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled', 'error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bling_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  state_hash char(64) NOT NULL UNIQUE,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bling_oauth_states_valid_idx
  ON bling_oauth_states (organization_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE catalog_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_job_id uuid UNIQUE REFERENCES integration_jobs(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'bling' CHECK (provider = 'bling'),
  mode text NOT NULL CHECK (mode IN ('full', 'incremental')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_configuration', 'completed', 'failed', 'cancelled')),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  products_seen integer NOT NULL DEFAULT 0,
  products_upserted integer NOT NULL DEFAULT 0,
  products_deactivated integer NOT NULL DEFAULT 0,
  error_code text,
  error_detail text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX catalog_sync_runs_one_active_idx
  ON catalog_sync_runs (organization_id, provider)
  WHERE status IN ('queued', 'running');

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('product', 'conversation', 'contact')),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text NOT NULL,
  color char(7) CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, scope, slug)
);

CREATE TABLE tag_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('product', 'conversation', 'contact')),
  subject_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'rule', 'agent', 'integration')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tag_id, subject_type, subject_id)
);

CREATE INDEX tag_assignments_subject_idx ON tag_assignments (organization_id, subject_type, subject_id);
CREATE INDEX tag_assignments_tag_idx ON tag_assignments (tag_id, subject_type);

CREATE TABLE routing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  action jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX routing_policies_active_idx
  ON routing_policies (organization_id, priority, created_at)
  WHERE enabled;

CREATE TABLE routing_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  policy_id uuid REFERENCES routing_policies(id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('continue', 'handoff', 'pause_automation')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX routing_decisions_conversation_idx ON routing_decisions (conversation_id, created_at DESC);
