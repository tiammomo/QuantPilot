import path from 'path';

export const ROOT = process.cwd();
export const CASES_PATH = path.join(ROOT, 'benchmarks', 'quantpilot', 'cases.json');
export const EVAL_SETS_PATH = path.join(ROOT, 'benchmarks', 'quantpilot', 'eval-sets.json');
export const REPORTS_DIR = path.join(ROOT, 'tmp', 'quantpilot-benchmark-reports');
export const QUEUE_DIR = path.join(ROOT, 'tmp', 'quantpilot-eval-queue');
export const LOG_DIR = path.join(QUEUE_DIR, 'logs');
export const REPAIRS_DIR = path.join(ROOT, 'tmp', 'quantpilot-eval-repairs');
export const REPAIRS_PATH = path.join(REPAIRS_DIR, 'repairs.json');
