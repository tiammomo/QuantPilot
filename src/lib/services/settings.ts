import fs from 'fs/promises';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import {
  PI_AGENT_DEFAULT_MODEL,
  normalizePiAgentModelId,
} from '@/lib/constants/models';
import { PRODUCT_CLI_ID } from '@/lib/constants/cli';

const DATA_DIR = process.env.SETTINGS_DIR || path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'global-settings.json');
const GLOBAL_SETTINGS_KEY = 'global';

export type CLISettings = Record<string, Record<string, unknown>>;

export interface GlobalSettings {
  default_cli: typeof PRODUCT_CLI_ID;
  cli_settings: CLISettings;
}

const DEFAULT_SETTINGS: GlobalSettings = {
  default_cli: PRODUCT_CLI_ID,
  cli_settings: {
    [PRODUCT_CLI_ID]: {
      model: PI_AGENT_DEFAULT_MODEL,
    },
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function configuredModel(value?: unknown): string {
  const root = record(value);
  const cliSettings = record(root?.cli_settings ?? root?.cliSettings);
  const provider = record(cliSettings?.[PRODUCT_CLI_ID]);
  return normalizePiAgentModelId(
    typeof provider?.model === 'string' ? provider.model : PI_AGENT_DEFAULT_MODEL,
  );
}

function singleProviderSettings(value?: unknown): GlobalSettings {
  return {
    default_cli: PRODUCT_CLI_ID,
    cli_settings: {
      [PRODUCT_CLI_ID]: {
        model: configuredModel(value),
      },
    },
  };
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readSettingsFile(): Promise<GlobalSettings | null> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    return singleProviderSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeSettings(settings: GlobalSettings): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key: GLOBAL_SETTINGS_KEY },
    update: { value: settings as unknown as Prisma.InputJsonValue },
    create: { key: GLOBAL_SETTINGS_KEY, value: settings as unknown as Prisma.InputJsonValue },
  });
}

async function readSettingsFromDatabase(): Promise<GlobalSettings | null> {
  try {
    const record = await prisma.platformSetting.findUnique({
      where: { key: GLOBAL_SETTINGS_KEY },
    });
    return record?.value ? singleProviderSettings(record.value) : null;
  } catch {
    return null;
  }
}

async function migrateSettingsFileToDatabase(settings: GlobalSettings): Promise<void> {
  try {
    await writeSettings(settings);
  } catch {
    await ensureDataDir();
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  }
}

export async function loadGlobalSettings(): Promise<GlobalSettings> {
  const stored = await readSettingsFromDatabase();
  if (stored) {
    return stored;
  }

  const existing = await readSettingsFile();
  if (existing) {
    await migrateSettingsFileToDatabase(existing);
    return existing;
  }

  await writeSettings(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export function normalizeCliSettings(settings: unknown): CLISettings | undefined {
  if (!settings || typeof settings !== 'object') {
    return undefined;
  }

  return {
    ...singleProviderSettings({ cli_settings: settings }).cli_settings,
  };
}

export async function updateGlobalSettings(partial: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const current = await loadGlobalSettings();
  const next = singleProviderSettings({
    ...current,
    ...partial,
    cli_settings: partial.cli_settings ?? current.cli_settings,
  });
  await writeSettings(next);
  return next;
}
