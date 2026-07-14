import crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_KEY = '5f'.repeat(32);
const originalEnvironment = {
  encryptionKey: process.env.ENCRYPTION_KEY,
  degradationMode: process.env.QUANTPILOT_DEGRADATION_MODE,
};

async function loadCryptoModule() {
  vi.resetModules();
  return import('./crypto');
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  delete process.env.QUANTPILOT_DEGRADATION_MODE;
});

afterAll(() => {
  if (originalEnvironment.encryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEnvironment.encryptionKey;
  if (originalEnvironment.degradationMode === undefined) delete process.env.QUANTPILOT_DEGRADATION_MODE;
  else process.env.QUANTPILOT_DEGRADATION_MODE = originalEnvironment.degradationMode;
});

describe('crypto', () => {
  it('round-trips secrets with the authenticated v2 format', async () => {
    const { decrypt, encrypt, isCurrentEncryptionFormat } = await loadCryptoModule();
    const encrypted = encrypt('quantpilot-secret-量化');

    expect(isCurrentEncryptionFormat(encrypted)).toBe(true);
    expect(encrypted).not.toContain('quantpilot-secret');
    expect(decrypt(encrypted)).toBe('quantpilot-secret-量化');
  });

  it('rejects a tampered authentication tag or ciphertext', async () => {
    const { decrypt, encrypt } = await loadCryptoModule();
    const encrypted = encrypt('do-not-tamper');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('0') ? '1' : '0'}`;

    expect(() => decrypt(tampered)).toThrow();
  });

  it('decrypts legacy AES-256-CBC values', async () => {
    const { decrypt, isLegacyEncryptionFormat } = await loadCryptoModule();
    const iv = Buffer.alloc(16, 7);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(TEST_KEY, 'hex'), iv);
    const encrypted = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()]);
    const legacyValue = `${iv.toString('hex')}:${encrypted.toString('hex')}`;

    expect(isLegacyEncryptionFormat(legacyValue)).toBe(true);
    expect(decrypt(legacyValue)).toBe('legacy-secret');
  });

  it('rejects unsupported payloads instead of treating them as ciphertext', async () => {
    const { decrypt } = await loadCryptoModule();
    expect(() => decrypt('plain-text')).toThrow('unsupported format');
  });
});
