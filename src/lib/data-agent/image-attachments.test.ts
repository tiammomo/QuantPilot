import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeDataAgentImageAttachment,
  writeDataAgentAttachmentManifest,
} from './image-attachments';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PROJECTS_DIR;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('Data Agent image attachments', () => {
  it('normalizes a project asset and writes a domain-neutral manifest', async () => {
    const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-data-agent-assets-'));
    temporaryDirectories.push(projectsRoot);
    process.env.PROJECTS_DIR = projectsRoot;
    const projectRoot = path.join(projectsRoot, 'project-a');
    await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'assets', 'input.png'), PNG_BYTES);

    const normalized = await normalizeDataAgentImageAttachment({
      projectId: 'project-a',
      projectRoot,
      attachment: { name: '业务截图', path: 'assets/input.png', mimeType: 'image/png' },
      index: 0,
    });
    expect(normalized).toMatchObject({
      path: 'assets/input.png',
      publicUrl: '/uploads/input.png',
      mimeType: 'image/png',
    });

    const receiptPath = await writeDataAgentAttachmentManifest({
      projectRoot,
      projectId: 'project-a',
      requestId: 'request-a',
      images: [normalized],
      instruction: 'Inspect the supplied business image.',
    });
    const receipt = JSON.parse(await fs.readFile(path.join(projectRoot, receiptPath!), 'utf8'));
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      projectId: 'project-a',
      requestId: 'request-a',
      attachments: [{ path: 'assets/input.png' }],
    });
    expect(receipt.extractionContract).toBeUndefined();
  });
});
