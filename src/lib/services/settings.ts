import fs from 'fs/promises';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { DEEPSEEK_MODEL_ID } from '@/lib/constants/cliModels';

const DATA_DIR = process.env.SETTINGS_DIR || path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'global-settings.json');
const GLOBAL_SETTINGS_KEY = 'global';

export type CLISettings = Record<string, Record<string, unknown>>;

export interface GlobalSettings {
  default_cli: 'claude';
  cli_settings: CLISettings;
}

const DEFAULT_SETTINGS: GlobalSettings = {
  default_cli: 'claude',
  cli_settings: {
    claude: {
      model: DEEPSEEK_MODEL_ID,
    },
  },
};

function singleProviderSettings(value?: unknown): GlobalSettings {
  void value;

  return {
    default_cli: 'claude',
    cli_settings: {
      claude: {
        model: DEEPSEEK_MODEL_ID,
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
    claude: {
      model: DEEPSEEK_MODEL_ID,
    },
  };
}

export async function updateGlobalSettings(_partial: Partial<GlobalSettings>): Promise<GlobalSettings> {
  await writeSettings(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}
