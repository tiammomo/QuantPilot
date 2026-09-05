const RESERVED_REPOSITORY_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function sanitizeRepositoryName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/g, '')
    .slice(0, 100)
    .replace(/[.-]+$/g, '');
}

export function validateRepositoryName(name: string): string {
  if (!name.trim()) return 'Repository name is required';
  if (name.length > 100) return 'Repository name must be 100 characters or less';
  if (name.startsWith('.') || name.startsWith('-') || name.endsWith('.') || name.endsWith('-')) {
    return 'Repository name cannot start or end with a period or hyphen';
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return 'Repository name can only contain alphanumeric characters, periods, hyphens, and underscores';
  }
  if (name.includes('..')) return 'Repository name cannot contain consecutive periods';
  if (RESERVED_REPOSITORY_NAMES.has(name.toLowerCase())) {
    return 'Repository name cannot be a reserved name';
  }
  return '';
}

export function repositoryAvailabilityMessage(params: {
  name: string;
  status: number;
  available?: boolean;
}): { error: string; warning: string } {
  const successful = params.status >= 200 && params.status < 300;
  if (params.status === 409 || (successful && params.available === false)) {
    return { error: `Repository name "${params.name}" already exists`, warning: '' };
  }
  if (params.status === 401) {
    return {
      error: '',
      warning: 'GitHub token is not configured. Add it in Global Settings before creating the repository.',
    };
  }
  if (params.status === 403) {
    return {
      error: '',
      warning: 'The configured GitHub token cannot inspect repositories. Check its permissions.',
    };
  }
  if (!successful || params.available !== true) {
    return {
      error: '',
      warning: `Repository availability could not be verified (HTTP ${params.status}). The server will validate again when you submit.`,
    };
  }
  return { error: '', warning: '' };
}
