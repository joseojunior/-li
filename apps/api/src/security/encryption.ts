import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export type EncryptedValue = { ciphertext: string; iv: string; authTag: string };

function encryptionKey(): Buffer {
  if (!config.DATA_ENCRYPTION_KEY) throw new Error('data_encryption_key_not_configured');
  const key = Buffer.from(config.DATA_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('data_encryption_key_invalid');
  return key;
}

export function encryptSecret(value: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

export function decryptSecret(value: EncryptedValue): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

