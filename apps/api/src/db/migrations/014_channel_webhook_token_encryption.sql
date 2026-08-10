ALTER TABLE channel_connections
  ADD COLUMN webhook_token_ciphertext text,
  ADD COLUMN webhook_token_iv text,
  ADD COLUMN webhook_token_auth_tag text;
