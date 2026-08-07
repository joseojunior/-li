ALTER TABLE channel_connections
  ALTER COLUMN backend_url DROP NOT NULL,
  ALTER COLUMN token_ciphertext DROP NOT NULL,
  ALTER COLUMN token_iv DROP NOT NULL,
  ALTER COLUMN token_auth_tag DROP NOT NULL;

ALTER TABLE channel_connections DROP CONSTRAINT channel_connections_status_check;

ALTER TABLE channel_connections
  ADD CONSTRAINT channel_connections_status_check
  CHECK (status IN ('pending', 'active', 'disabled'));
