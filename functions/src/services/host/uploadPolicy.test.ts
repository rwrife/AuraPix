import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateUploadPolicy } from './uploadPolicy.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evaluateUploadPolicy', () => {
  const payload = {
    userId: 'u1',
    libraryId: 'lib1',
    sizeBytes: 1024,
    mimeType: 'image/jpeg',
    originalName: 'photo.jpg',
  };

  it('allows upload when host webhook is disabled', async () => {
    const result = await evaluateUploadPolicy(payload, { timeoutMs: 100 });
    expect(result.allow).toBe(true);
    expect(result.reason).toBe('host-policy-disabled');
  });

  it('denies upload when host webhook explicitly denies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ allow: false, reason: 'quota exceeded' }),
      })
    );

    const result = await evaluateUploadPolicy(payload, {
      webhookUrl: 'https://host.example/hooks/upload-policy',
      timeoutMs: 100,
    });

    expect(result).toEqual({ allow: false, reason: 'quota exceeded' });
  });

  it('fails open when webhook is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const result = await evaluateUploadPolicy(payload, {
      webhookUrl: 'https://host.example/hooks/upload-policy',
      timeoutMs: 100,
    });

    expect(result.allow).toBe(true);
    expect(result.reason).toBe('host-policy-webhook-unavailable');
  });
});
