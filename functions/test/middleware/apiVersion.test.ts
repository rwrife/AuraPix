import { describe, expect, it, vi } from 'vitest';

describe('apiVersionMiddleware', () => {
  it('allows requests without version header and sets response version header', async () => {
    const { apiVersionMiddleware } = await import('../../src/middleware/apiVersion.js');
    const next = vi.fn();
    const setHeader = vi.fn();

    apiVersionMiddleware(
      { header: () => undefined } as any,
      { setHeader } as any,
      next
    );

    expect(setHeader).toHaveBeenCalledWith('X-API-Version', '1');
    expect(setHeader).toHaveBeenCalledWith('Vary', 'X-API-Version');
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows matching major version', async () => {
    const { apiVersionMiddleware } = await import('../../src/middleware/apiVersion.js');
    const next = vi.fn();

    apiVersionMiddleware(
      { header: () => '1.2.3' } as any,
      { setHeader: vi.fn() } as any,
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects malformed version header', async () => {
    const { apiVersionMiddleware } = await import('../../src/middleware/apiVersion.js');

    expect(() => {
      apiVersionMiddleware(
        { header: () => 'v1' } as any,
        { setHeader: vi.fn() } as any,
        vi.fn()
      );
    }).toThrowError(/Invalid X-API-Version format/);
  });

  it('rejects unsupported major version', async () => {
    const { apiVersionMiddleware } = await import('../../src/middleware/apiVersion.js');

    expect(() => {
      apiVersionMiddleware(
        { header: () => '2' } as any,
        { setHeader: vi.fn() } as any,
        vi.fn()
      );
    }).toThrowError(/Unsupported X-API-Version/);
  });
});
