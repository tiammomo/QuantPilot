import fs from 'node:fs/promises';
import path from 'node:path';

function isWithin(basePath: string, candidate: string): boolean {
  const relative = path.relative(basePath, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realpathOfNearestExistingAncestor(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`无法解析项目路径的现有父目录：${candidate}`);
      }
      current = parent;
    }
  }
}

/** Validate both lexical and symlink-resolved workspace containment. */
export async function validateMoAgentProjectPath(
  projectPath: string,
  projectsDir: string,
): Promise<string> {
  const absoluteBasePath = path.resolve(projectsDir);
  const absoluteProjectPath = path.resolve(projectPath);
  if (!isWithin(absoluteBasePath, absoluteProjectPath)) {
    throw new Error(
      `Security violation: project path must be within ${absoluteBasePath}. Got: ${absoluteProjectPath}`,
    );
  }

  const [canonicalBasePath, canonicalAncestor] = await Promise.all([
    fs.realpath(absoluteBasePath),
    realpathOfNearestExistingAncestor(absoluteProjectPath),
  ]);
  if (!isWithin(canonicalBasePath, canonicalAncestor)) {
    throw new Error(
      `Security violation: project path resolves outside ${canonicalBasePath}. Got: ${canonicalAncestor}`,
    );
  }

  const canonicalProjectPath = await fs.realpath(absoluteProjectPath);
  if (!isWithin(canonicalBasePath, canonicalProjectPath)) {
    throw new Error(
      `Security violation: project path resolves outside ${canonicalBasePath}. Got: ${canonicalProjectPath}`,
    );
  }
  const stat = await fs.stat(canonicalProjectPath);
  if (!stat.isDirectory()) {
    throw new Error(`MoAgent project path is not a directory: ${canonicalProjectPath}`);
  }
  return canonicalProjectPath;
}
