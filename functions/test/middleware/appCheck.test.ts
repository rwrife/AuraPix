import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DEFAULT_ENV = {
  APP_CHECK_ENFORCE_UPLOADS: process.env.APP_CHECK_ENFORCE_UPLOADS,
  APP_CHECK_BYPASS_TOKENS: process.env.APP_CHECK_BYPASS_TOKENS,
};

function restoreEnv(): void {
  process.env.APP_CHECK_ENFORCE_UPLOADS = DEFAULT_ENV.APP_CHECK_ENFORCE_UPLOADS;
  process.env.APP_CHECK_BYPASS_TOKENS = DEFAULT_ENV.APP_CHECK_BYPASS_TOKENS;
}

describe('appCheckUploadMiddleware', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.APP_CHECK_ENFORCE_UPLOADS;
    delete process.env.APP_CHECK_BYPASS_TOKENS;
  });

  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('passes through when enforcement is disabled', async () => {
    const { appCheckUploadMiddleware } = await import('../../src/middleware/appCheck.js');
    const next = vi.fn();

    appCheckUploadMiddleware(
      { header: () => undefined } as any,
      {} as any,
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects missing token when enforcement is enabled', async () => {
    process.env.APP_CHECK_ENFORCE_UPLOADS = 'true';
    const { appCheckUploadMiddleware } = await import('../../src/middleware/appCheck.js');

    expect(() => {
      appCheckUploadMiddleware(
        { header: () => undefined } as any,
        {} as any,
        vi.fn()
      );
    }).toThrowError(/App Check token required/);
  });

  it('accepts configured bypass token', async () => {
    process.env.APP_CHECK_ENFORCE_UPLOADS = 'true';
    process.env.APP_CHECK_BYPASS_TOKENS = 'dev-bypass-token';
    const { appCheckUploadMiddleware } = await import('../../src/middleware/appCheck.js');
    const next = vi.fn();

    appCheckUploadMiddleware(
      { header: () => 'dev-bypass-token' } as any,
      {} as any,
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });
});
