CREATE TABLE operation_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('received', 'queued', 'running', 'completed', 'failed', 'skipped')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operation_traces_organization_created_idx
  ON operation_traces (organization_id, created_at DESC);
CREATE INDEX operation_traces_conversation_created_idx
  ON operation_traces (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;
