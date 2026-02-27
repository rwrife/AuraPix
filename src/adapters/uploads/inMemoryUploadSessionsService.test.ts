import {
  buildCanonicalObjectKey,
  InMemoryUploadSessionsService,
  isValidCanonicalObjectKey,
  UploadSessionRateLimitError,
} from './inMemoryUploadSessionsService';

describe('InMemoryUploadSessionsService', () => {
  it('builds and validates canonical object key format', () => {
    const key = buildCanonicalObjectKey({
      fileName: 'My Summer Photo.JPG',
      now: new Date('2026-02-23T12:00:00.000Z'),
    });

    expect(key).toBe('uploads/2026/02/23/my-summer-photo.jpg');
    expect(isValidCanonicalObjectKey(key)).toBe(true);
    expect(isValidCanonicalObjectKey('bad/key')).toBe(false);
  });

  it('replays upload session creation for duplicate client request ids', async () => {
    const service = new InMemoryUploadSessionsService();

    const first = await service.createUploadSession({
      fileName: 'Beach.png',
      clientRequestId: 'req-123',
    });

    const second = await service.createUploadSession({
      fileName: 'Beach.png',
      clientRequestId: 'req-123',
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.objectKey).toBe(first.objectKey);
  });

  it('rejects duplicate client request ids for different file names', async () => {
    const service = new InMemoryUploadSessionsService();

    await service.createUploadSession({
      fileName: 'Beach.png',
      clientRequestId: 'req-123',
    });

    await expect(
      service.createUploadSession({
        fileName: 'Mountains.png',
        clientRequestId: 'req-123',
      }),
    ).rejects.toThrow('Client request id already used for a different file name.');
  });

  it('finalize upload is idempotent per idempotency key', async () => {
    const service = new InMemoryUploadSessionsService();
    const session = await service.createUploadSession({ fileName: 'Beach.png' });

    const first = await service.finalizeUpload({
      sessionId: session.sessionId,
      idempotencyKey: session.idempotencyKey,
      fileName: 'Beach.png',
      byteSize: 2048,
    });

    const second = await service.finalizeUpload({
      sessionId: session.sessionId,
      idempotencyKey: session.idempotencyKey,
      fileName: 'Beach.png',
      byteSize: 2048,
    });

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(first.metadata.uploadId).toBe(second.metadata.uploadId);
    expect(first.job.jobId).toBe(second.job.jobId);

    const metadata = await service.listUploadedMetadata();
    const jobs = await service.listDerivativeJobs();

    expect(metadata).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it('processes the next queued derivative job and marks metadata complete', async () => {
    const service = new InMemoryUploadSessionsService();
    const session = await service.createUploadSession({ fileName: 'Beach.png' });

    const finalized = await service.finalizeUpload({
      sessionId: session.sessionId,
      idempotencyKey: session.idempotencyKey,
      fileName: 'Beach.png',
      byteSize: 2048,
    });

    const processed = await service.processNextDerivativeJob();

    expect(processed?.jobId).toBe(finalized.job.jobId);
    expect(processed?.status).toBe('completed');

    const metadata = await service.listUploadedMetadata();
    expect(metadata[0]?.processingState).toBe('completed');

    const nothingLeft = await service.processNextDerivativeJob();
    expect(nothingLeft).toBeNull();
  });

  it('keeps upload session creation backward-compatible with rate limiting disabled by default', async () => {
    const service = new InMemoryUploadSessionsService();

    await expect(
      Promise.all(
        Array.from({ length: 20 }).map((_, index) =>
          service.createUploadSession({ fileName: `photo-${index}.jpg` }),
        ),
      ),
    ).resolves.toHaveLength(20);
  });

  it('enforces upload session creation rate limits when enabled', async () => {
    let now = 1000;
    const service = new InMemoryUploadSessionsService({
      now: () => now,
      rateLimit: {
        enabled: true,
        maxRequests: 2,
        windowMs: 5_000,
      },
    });

    await service.createUploadSession({ fileName: 'one.jpg' });
    await service.createUploadSession({ fileName: 'two.jpg' });

    await expect(service.createUploadSession({ fileName: 'three.jpg' })).rejects.toBeInstanceOf(
      UploadSessionRateLimitError,
    );

    await expect(service.createUploadSession({ fileName: 'three.jpg' })).rejects.toMatchObject({
      retryAfterSeconds: 5,
    });

    now += 5_001;

    await expect(service.createUploadSession({ fileName: 'three.jpg' })).resolves.toMatchObject({
      objectKey: expect.stringMatching(/^uploads\/\d{4}\/\d{2}\/\d{2}\/three.jpg$/),
    });
  });
});
