import bcrypt from 'bcryptjs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encryptSecret(plaintext: string, keyHex: string): EncryptedSecret {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(encrypted: EncryptedSecret, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function rotateSecret(
  encrypted: EncryptedSecret,
  currentKeyHex: string,
  newKeyHex: string,
): EncryptedSecret {
  return encryptSecret(decryptSecret(encrypted, currentKeyHex), newKeyHex);
}

export function normalizePayload<T>(input: T): T {
  if (typeof input === 'string') {
    return input.trim() as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => normalizePayload(item)) as T;
  }

  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [
        key,
        normalizePayload(value),
      ]),
    ) as T;
  }

  return input;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}
