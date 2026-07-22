import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createImageExtractionTool,
  extractUploadedImageMetadata,
} from './image-extraction';

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-image-tool-'));
  temporaryDirectories.push(workspace);
  await fs.mkdir(path.join(workspace, '.data-agent'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'uploads'), { recursive: true });
  return workspace;
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function toolContext() {
  return {
    runId: 'image-test',
    turn: 1,
    toolCallId: 'call-image',
    operationId: 'op_test',
    signal: new AbortController().signal,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('MoAgent image extraction tool', () => {
  it('validates attachment metadata and preserves the manual-confirmation contract', async () => {
    const workspace = await makeWorkspace();
    const imagePath = path.join(workspace, 'uploads', 'portfolio.png');
    await fs.writeFile(imagePath, png(640, 360));
    await fs.writeFile(path.join(workspace, '.data-agent', 'attachments.json'), JSON.stringify({
      attachments: [{
        id: 'portfolio-1',
        name: 'portfolio.png',
        path: 'uploads/portfolio.png',
        mimeType: 'image/png',
        publicUrl: '/uploads/portfolio.png',
      }],
    }));
    const tool = createImageExtractionTool({
      workspaceRoot: workspace,
      now: () => new Date('2026-07-15T00:00:00.000Z'),
    });
    const input = tool.parseInput?.({ prompt: '提取持仓' }) ?? { prompt: '提取持仓' };
    const result = await tool.execute(input, toolContext());

    expect(tool.name).toBe('quant_extract_uploaded_image');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.runtime).toBe('MoAgent');
    expect(result.data.status).toBe('metadata_ready');
    if (result.data.status !== 'metadata_ready') return;
    expect(result.data.images[0]).toMatchObject({
      id: 'portfolio-1',
      path: 'uploads/portfolio.png',
      mimeType: 'image/png',
      width: 640,
      height: 360,
      size: 24,
    });
    expect(result.data.images[0]).not.toHaveProperty('absolutePath');
    expect(result.data).not.toHaveProperty('projectPath');
    expect(result.data.images[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.data.imageExtraction.needs_manual_confirmation).toBe(true);
    expect(result.data.imageExtraction.manual_confirmation_fields).toContain('holdings[].cost_price');
    expect(result.content).toContain('verified 1 uploaded image');
    expect(result.content).not.toContain(result.data.images[0].sha256);
  });

  it('rejects attachment manifests that do not use the canonical relative path field', async () => {
    const workspace = await makeWorkspace();
    const imagePath = path.join(workspace, 'uploads', 'portfolio.png');
    await fs.writeFile(imagePath, png(10, 10));
    await fs.writeFile(path.join(workspace, '.data-agent', 'attachments.json'), JSON.stringify({
      attachments: [{ id: 'old-shape', name: 'portfolio.png', absolutePath: imagePath }],
    }));

    const result = await createImageExtractionTool({ workspaceRoot: workspace })
      .execute({}, toolContext());

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ATTACHMENT' } });
  });

  it('returns the canonical no-attachments status', async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, '.data-agent', 'attachments.json'),
      JSON.stringify({ attachments: [] }),
    );

    const result = await extractUploadedImageMetadata({}, { workspaceRoot: workspace });
    expect(result).toMatchObject({
      schemaVersion: 1,
      runtime: 'MoAgent',
      tool: 'image-extraction',
      status: 'no_attachments',
    });
  });

  it('rejects direct paths and symlinks that escape the workspace', async () => {
    const workspace = await makeWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-image-outside-'));
    temporaryDirectories.push(outside);
    const outsideImage = path.join(outside, 'outside.png');
    await fs.writeFile(outsideImage, png(1, 1));
    const tool = createImageExtractionTool({ workspaceRoot: workspace });

    const direct = await tool.execute({ imagePath: outsideImage }, toolContext());
    expect(direct).toMatchObject({ ok: false, error: { code: 'ABSOLUTE_PATH_DENIED' } });

    await fs.symlink(outsideImage, path.join(workspace, 'uploads', 'escape.png'));
    const symlink = await tool.execute({ imagePath: 'uploads/escape.png' }, toolContext());
    expect(symlink).toMatchObject({ ok: false, error: { code: 'SYMLINK_ESCAPE_DENIED' } });
  });

  it('rejects files whose contents are not a supported image', async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, 'uploads', 'fake.png'), 'not an image');
    const tool = createImageExtractionTool({ workspaceRoot: workspace });
    const result = await tool.execute({ imagePath: 'uploads/fake.png' }, toolContext());

    expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_IMAGE' } });
  });

  it('fails closed when structured metadata would exceed the model-visible output budget', async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, 'uploads', 'bounded.png'), png(10, 10));
    const tool = createImageExtractionTool({ workspaceRoot: workspace, maxOutputChars: 1_024 });
    const result = await tool.execute({
      imagePath: 'uploads/bounded.png',
      prompt: 'x'.repeat(900),
    }, toolContext());

    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_OUTPUT_TOO_LARGE' } });
  });
});
