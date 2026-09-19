import path from 'path';
import { realpathSync } from 'node:fs';

// Standalone changes cwd to .next/standalone. Resolve the deployment symlink
// once so a running Worker cannot silently switch code when current advances.
export const ROOT = realpathSync(process.env.QUANTPILOT_EVAL_ROOT || process.cwd());
export const CASES_PATH = path.join(ROOT, 'benchmarks', 'quantpilot', 'cases.json');
export const EVAL_SETS_PATH = path.join(ROOT, 'benchmarks', 'quantpilot', 'eval-sets.json');
export const REPORTS_DIR = path.join(ROOT, 'tmp', 'quantpilot-benchmark-reports');
export const QUEUE_DIR = path.join(ROOT, 'tmp', 'quantpilot-eval-queue');
export const LOG_DIR = path.join(QUEUE_DIR, 'logs');
export const REPAIRS_DIR = path.join(ROOT, 'tmp', 'quantpilot-eval-repairs');
export const REPAIRS_PATH = path.join(REPAIRS_DIR, 'repairs.json');
