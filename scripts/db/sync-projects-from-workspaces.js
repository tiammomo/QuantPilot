#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const ROOT = path.join(__dirname, '..', '..');
const PROJECTS_DIR = path.resolve(ROOT, process.env.PROJECTS_DIR || './data/projects');

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function dateFromProjectId(projectId) {
  const match = projectId.match(/(?:project|continuation)-(\d{10,})/);
  if (!match) return new Date();
  const numeric = Number.parseInt(match[1], 10);
  if (!Number.isFinite(numeric)) return new Date();
  const timestamp = numeric > 9_999_999_999 ? numeric : numeric * 1000;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function inferProject(projectDirName) {
  const repoPath = path.join(PROJECTS_DIR, projectDirName);
  const manifest = await readJson(path.join(repoPath, '.quantpilot', 'manifest.json'));
  const generationState = await readJson(path.join(repoPath, '.quantpilot', 'generation-state.json'));
  const packageJson = await readJson(path.join(repoPath, 'package.json'));
  const stat = await fs.stat(repoPath);
  const createdAt = manifest?.createdAt ? new Date(manifest.createdAt) : dateFromProjectId(projectDirName);
  const updatedAt = generationState?.updatedAt ? new Date(generationState.updatedAt) : stat.mtime;
  const quantCapabilityId = manifest?.quant?.capabilityId;

  return {
    id: projectDirName,
    name: manifest?.projectName || packageJson?.name || projectDirName,
    description: generationState?.originalInstruction
      ? String(generationState.originalInstruction).slice(0, 240)
      : null,
    status:
      generationState?.status === 'failed'
        ? 'failed'
        : generationState?.status === 'completed'
          ? 'idle'
          : 'idle',
    repoPath,
    initialPrompt: generationState?.originalInstruction || '',
    templateType: 'nextjs',
    preferredCli: manifest?.runtime?.cli || generationState?.cliPreference || 'claude',
    selectedModel: manifest?.runtime?.model || generationState?.selectedModel || null,
    settings: JSON.stringify({
      quant: {
        capabilityId: quantCapabilityId || 'market_overview',
        status: 'recovered_from_workspace',
      },
    }),
    createdAt,
    updatedAt,
    lastActiveAt: updatedAt,
  };
}

async function main() {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const projectDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('project-'))
    .map((entry) => entry.name)
    .sort();

  let created = 0;
  let skipped = 0;

  for (const projectDir of projectDirs) {
    const existing = await prisma.project.findUnique({
      where: { id: projectDir },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const project = await inferProject(projectDir);
    await prisma.project.create({ data: project });
    created += 1;
  }

  console.log(`Workspace sync complete: ${created} created, ${skipped} skipped.`);
}

main()
  .catch((error) => {
    console.error('[sync-projects-from-workspaces] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
