import crypto from 'crypto';

const CURRENT_ALGORITHM = 'aes-256-gcm';
const LEGACY_ALGORITHM = 'aes-256-cbc';
const CURRENT_FORMAT_PREFIX = 'v2';
const PLACEHOLDER_ENCRYPTION_KEY = 'replace-with-a-64-character-hex-secret';
const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;
const LEGACY_IV_LENGTH = 16;

function isValidEncryptionKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isProductionBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

function shouldRequireConfiguredKey(): boolean {
  if (isProductionBuildPhase()) {
    return false;
  }
  return process.env.NODE_ENV === 'production' || process.env.QUANTPILOT_DEGRADATION_MODE === 'strict';
}

function resolveEncryptionKey(): string {
  const configured = process.env.ENCRYPTION_KEY;
  if (isValidEncryptionKey(configured)) {
    return configured.toLowerCase();
  }

  if (shouldRequireConfiguredKey()) {
    throw new Error('ENCRYPTION_KEY must be a stable 64-character hex string in production or strict mode.');
  }

  if (isProductionBuildPhase()) {
    return crypto.createHash('sha256').update('quantpilot-local-development-encryption-key').digest('hex');
  }

  if (configured && configured !== PLACEHOLDER_ENCRYPTION_KEY) {
    console.warn('[crypto] Ignoring invalid ENCRYPTION_KEY. Expected a 64-character hex string.');
  } else {
    console.warn('[crypto] ENCRYPTION_KEY is not configured. Using a stable local-development fallback key.');
  }

  return crypto.createHash('sha256').update('quantpilot-local-development-encryption-key').digest('hex');
}

const ENCRYPTION_KEY = resolveEncryptionKey();
const KEY_BUFFER = Buffer.from(ENCRYPTION_KEY, 'hex');

function assertHexPart(value: string, label: string, expectedBytes?: number): Buffer {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`Invalid encrypted payload: ${label}`);
  }

  const buffer = Buffer.from(value, 'hex');
  if (expectedBytes !== undefined && buffer.length !== expectedBytes) {
    throw new Error(`Invalid encrypted payload: ${label}`);
  }
  return buffer;
}

export function isCurrentEncryptionFormat(value: string): boolean {
  return value.startsWith(`${CURRENT_FORMAT_PREFIX}:`);
}

export function isLegacyEncryptionFormat(value: string): boolean {
  const [iv, encryptedText, ...extra] = value.split(':');
  return (
    extra.length === 0 &&
    /^[0-9a-f]{32}$/i.test(iv ?? '') &&
    Boolean(encryptedText) &&
    encryptedText.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(encryptedText)
  );
}

/**
 * Encrypt a string using authenticated AES-256-GCM.
 * @param text - Plain text to encrypt
 * @returns Versioned encrypted text (format: v2:iv:authTag:ciphertext)
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(CURRENT_ALGORITHM, KEY_BUFFER, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [CURRENT_FORMAT_PREFIX, iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Decrypt a versioned AES-256-GCM value or a legacy AES-256-CBC value.
 * Legacy support keeps existing local environment records readable while new
 * writes use authenticated encryption.
 * @returns Decrypted plain text
 */
export function decrypt(text: string): string {
  if (isCurrentEncryptionFormat(text)) {
    const [prefix, ivHex, authTagHex, encryptedHex, ...extra] = text.split(':');
    if (prefix !== CURRENT_FORMAT_PREFIX || extra.length > 0) {
      throw new Error('Invalid encrypted payload: format');
    }

    const iv = assertHexPart(ivHex, 'iv', GCM_IV_LENGTH);
    const authTag = assertHexPart(authTagHex, 'auth tag', GCM_AUTH_TAG_LENGTH);
    const encrypted = assertHexPart(encryptedHex, 'ciphertext');
    const decipher = crypto.createDecipheriv(CURRENT_ALGORITHM, KEY_BUFFER, iv, {
      authTagLength: GCM_AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  if (!isLegacyEncryptionFormat(text)) {
    throw new Error('Invalid encrypted payload: unsupported format');
  }

  const [ivHex, encryptedHex] = text.split(':');
  const iv = assertHexPart(ivHex, 'legacy iv', LEGACY_IV_LENGTH);
  const encrypted = assertHexPart(encryptedHex, 'legacy ciphertext');
  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, KEY_BUFFER, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
