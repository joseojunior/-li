CREATE TABLE ai_provider_connections (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'openai' CHECK (provider = 'openai'),
  api_key_ciphertext text,
  api_key_iv text,
  api_key_auth_tag text,
  configured_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (api_key_ciphertext IS NULL AND api_key_iv IS NULL AND api_key_auth_tag IS NULL)
    OR (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL AND api_key_auth_tag IS NOT NULL)
  )
);

CREATE TABLE agent_configurations (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_key text NOT NULL CHECK (agent_key IN ('attendant', 'support', 'product')),
  model text NOT NULL CHECK (model IN ('gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol')),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, agent_key)
);

CREATE INDEX agent_configurations_enabled_idx
  ON agent_configurations (organization_id, agent_key) WHERE enabled;
