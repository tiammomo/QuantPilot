import { prisma } from '@/lib/db/client';
import {
  decrypt,
  encrypt,
  isCurrentEncryptionFormat,
} from '@/lib/crypto';

const SUPPORTED_PROVIDERS = ['github', 'supabase', 'vercel'] as const;
export type ServiceProvider = (typeof SUPPORTED_PROVIDERS)[number];

interface ServiceTokenRecord {
  id: string;
  provider: ServiceProvider;
  name: string;
  token: null;
  token_preview: string;
  has_token: boolean;
  created_at: string;
  last_used: string | null;
}

function assertProvider(provider: string): asserts provider is ServiceProvider {
  if (!SUPPORTED_PROVIDERS.includes(provider as ServiceProvider)) {
    throw new Error('Invalid provider');
  }
}

function toResponse(model: {
  id: string;
  provider: string;
  name: string;
  token: string;
  createdAt: Date;
  lastUsed: Date | null;
}): ServiceTokenRecord {
  const plainToken = decodeStoredToken(model.token);
  return {
    id: model.id,
    provider: model.provider as ServiceProvider,
    name: model.name,
    token: null,
    token_preview: maskToken(plainToken),
    has_token: plainToken.length > 0,
    created_at: model.createdAt.toISOString(),
    last_used: model.lastUsed ? model.lastUsed.toISOString() : null,
  };
}

function decodeStoredToken(value: string): string {
  if (isCurrentEncryptionFormat(value)) {
    return decrypt(value);
  }
  return value;
}

async function migrateTokenEncryption(record: { id: string; token: string }): Promise<string> {
  const plainToken = decodeStoredToken(record.token);
  if (!isCurrentEncryptionFormat(record.token)) {
    await prisma.serviceToken.update({
      where: { id: record.id },
      data: { token: encrypt(plainToken) },
    });
  }
  return plainToken;
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return '••••';
  }
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

export async function createServiceToken(
  provider: string,
  token: string,
  name: string,
): Promise<ServiceTokenRecord> {
  assertProvider(provider);

  if (!token.trim()) {
    throw new Error('Token cannot be empty');
  }
  if (token.length > 65_536) {
    throw new Error('Token is too large');
  }
  if (name.length > 120) {
    throw new Error('Token name is too large');
  }

  await prisma.serviceToken.deleteMany({
    where: { provider },
  });

  const stored = await prisma.serviceToken.create({
    data: {
      provider,
      name: name.trim() || `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Token`,
      token: encrypt(token.trim()),
    },
  });

  return toResponse(stored);
}

export async function getServiceToken(provider: string): Promise<ServiceTokenRecord | null> {
  assertProvider(provider);

  const record = await prisma.serviceToken.findFirst({
    where: { provider },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    return null;
  }

  const plainToken = await migrateTokenEncryption(record);
  return toResponse({ ...record, token: plainToken });
}

export async function deleteServiceToken(tokenId: string): Promise<boolean> {
  try {
    await prisma.serviceToken.delete({
      where: { id: tokenId },
    });
    return true;
  } catch (error) {
    return false;
  }
}

export async function getPlainServiceToken(provider: string): Promise<string | null> {
  assertProvider(provider);

  const record = await prisma.serviceToken.findFirst({
    where: { provider },
  });

  if (!record) {
    return null;
  }

  return migrateTokenEncryption(record);
}

export async function touchServiceToken(provider: string): Promise<void> {
  assertProvider(provider);

  await prisma.serviceToken.updateMany({
    where: { provider },
    data: { lastUsed: new Date() },
  });
}
