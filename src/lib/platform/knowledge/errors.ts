export class ExternalKnowledgeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly requestId: string | null,
    readonly traceId: string | null = null,
  ) {
    super(message);
    this.name = 'ExternalKnowledgeHttpError';
  }
}

export class KnowledgeIntegrationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeIntegrationError';
  }
}
