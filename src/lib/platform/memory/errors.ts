export class ExternalMemoryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'ExternalMemoryHttpError';
  }
}
