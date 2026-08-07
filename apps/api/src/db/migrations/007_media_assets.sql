CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  bucket text NOT NULL,
  storage_key text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'ready', 'failed', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  UNIQUE (bucket, storage_key)
);

CREATE INDEX media_assets_organization_status_idx ON media_assets (organization_id, status, created_at DESC);
CREATE INDEX media_assets_product_idx ON media_assets (product_id) WHERE product_id IS NOT NULL;

ALTER TABLE product_media
  ADD COLUMN asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;

ALTER TABLE product_media
  ALTER COLUMN public_url DROP NOT NULL;

CREATE INDEX product_media_asset_idx ON product_media (asset_id) WHERE asset_id IS NOT NULL;
