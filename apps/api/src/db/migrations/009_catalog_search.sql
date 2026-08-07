CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX products_tags_idx ON products USING gin (tags);
CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops);
CREATE INDEX products_category_trgm_idx ON products USING gin (category gin_trgm_ops);

CREATE TABLE product_embeddings (
  product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model text,
  embedding real[],
  content_hash char(64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  error_code text,
  indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status <> 'ready') OR (model IS NOT NULL AND embedding IS NOT NULL AND cardinality(embedding) > 0))
);

CREATE INDEX product_embeddings_ready_idx
  ON product_embeddings (organization_id, updated_at DESC)
  WHERE status = 'ready';
