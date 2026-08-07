ALTER TABLE channel_connections
  ADD COLUMN webhook_token_hash char(64);

CREATE INDEX channel_connections_webhook_token_idx ON channel_connections (channel_id, webhook_token_hash)
  WHERE webhook_token_hash IS NOT NULL;

