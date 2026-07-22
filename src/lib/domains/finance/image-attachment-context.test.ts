import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeFinanceAttachmentContext } from './image-attachment-context';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('Finance image attachment context', () => {
  it('projects the finance extraction contract onto the generic manifest', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-finance-assets-'));
    temporaryDirectories.push(projectRoot);

    const receiptPath = await writeFinanceAttachmentContext({
      projectRoot,
      projectId: 'project-a',
      requestId: 'request-a',
      images: [{
        name: '持仓截图',
        path: 'assets/holding.png',
        url: '/api/assets/project-a/holding.png',
        publicUrl: '/uploads/holding.png',
        mimeType: 'image/png',
        size: 9,
      }],
    });
    const receipt = JSON.parse(await fs.readFile(path.join(projectRoot, receiptPath!), 'utf8'));
    expect(receipt).toMatchObject({
      attachments: [{ path: 'assets/holding.png' }],
      extractionContract: {
        requiredSkill: 'image-extraction',
        requiredTool: 'quant_extract_uploaded_image',
      },
    });
  });
});
