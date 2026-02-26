import {
  buildCanonicalObjectKey,
  InMemoryUploadSessionsService,
  isValidCanonicalObjectKey,
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
});
