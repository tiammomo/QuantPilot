import fs from 'node:fs/promises';
import path from 'node:path';

export default async function setup() {
  // This path is dedicated to browser fixtures; never use the operator's Skill store.
  await fs.rm(path.join(process.cwd(), 'tmp/e2e-skills-state'), { recursive: true, force: true });
}
