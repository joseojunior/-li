CREATE TABLE conversation_sales_contexts (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'discovery' CHECK (stage IN ('discovery', 'context', 'pain', 'consequence', 'ideal', 'recommendation', 'choice', 'pricing', 'freight', 'checkout', 'after_sales', 'human', 'sensitive')),
  intent text NOT NULL DEFAULT 'unknown' CHECK (intent IN ('unknown', 'product_discovery', 'price', 'discount', 'freight', 'checkout', 'payment', 'order_status', 'after_sales', 'partnership', 'wholesale', 'sensitive_loss')),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_agent_question text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversation_sales_contexts_organization_stage_idx
  ON conversation_sales_contexts (organization_id, stage, updated_at DESC);

CREATE TABLE agent_evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  input jsonb NOT NULL,
  expected jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_evaluation_cases_organization_idx ON agent_evaluation_cases (organization_id, status);
