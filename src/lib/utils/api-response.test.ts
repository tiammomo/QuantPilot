import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createSuccessResponse,
  handleApiError,
} from './api-response';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('API responses', () => {
  it('returns a stable success envelope', async () => {
    const response = createSuccessResponse({ id: 'project-1' }, 201);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, data: { id: 'project-1' } });
  });

  it('maps explicit client errors without hiding actionable messages', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = handleApiError(
      new ApiError(422, 'invalid_symbol', 'Symbol format is invalid'),
      'test',
      'Request failed',
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Request failed',
      message: 'Symbol format is invalid',
    });
  });

  it('maps malformed JSON to a client error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = handleApiError(new SyntaxError('Unexpected token'), 'test');
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe('Invalid JSON request body');
  });

  it('does not expose internal error details in 500 responses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = handleApiError(new Error('database password=secret failed'), 'test');
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('password=secret');
  });
});
