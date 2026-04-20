import { describe, expect, it } from 'vitest';
import {
  buildFirebaseCanonicalObjectKey,
  FirebaseUploadService,
  isFirebaseCanonicalObjectKey,
} from './FirebaseUploadService';

describe('FirebaseUploadService', () => {
  it('builds and validates canonical object keys', () => {
    const key = buildFirebaseCanonicalObjectKey({
      fileName: 'My Summer Photo.JPG',
      now: new Date('2026-02-23T12:00:00.000Z'),
    });

    expect(key).toBe('uploads/2026/02/23/my-summer-photo.jpg');
    expect(isFirebaseCanonicalObjectKey(key)).toBe(true);
    expect(isFirebaseCanonicalObjectKey('bad/key')).toBe(false);
  });

  it('supports retry-safe session creation and finalize idempotency', async () => {
    const service = new FirebaseUploadService();

    const first = await service.createUploadSession({
      fileName: 'Beach.png',
      clientRequestId: 'req-123',
    });

    const second = await service.createUploadSession({
      fileName: 'Beach.png',
      clientRequestId: 'req-123',
    });

    expect(second.sessionId).toBe(first.sessionId);

    const finalized = await service.finalizeUpload({
      sessionId: first.sessionId,
      idempotencyKey: first.idempotencyKey,
      fileName: 'Beach.png',
      byteSize: 2048,
    });

    const replay = await service.finalizeUpload({
      sessionId: first.sessionId,
      idempotencyKey: first.idempotencyKey,
      fileName: 'Beach.png',
      byteSize: 2048,
    });

    expect(finalized.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect((await service.listUploadedMetadata())).toHaveLength(1);
    expect((await service.listDerivativeJobs())).toHaveLength(1);
  });

  it('processes queued derivative jobs', async () => {
    const service = new FirebaseUploadService();
    const session = await service.createUploadSession({ fileName: 'Beach.png' });

    await service.finalizeUpload({
      sessionId: session.sessionId,
      idempotencyKey: session.idempotencyKey,
      fileName: 'Beach.png',
      byteSize: 2048,
    });

    const processed = await service.processNextDerivativeJob();
    expect(processed?.status).toBe('completed');

    const metadata = await service.listUploadedMetadata();
    expect(metadata[0]?.processingState).toBe('completed');
  });
});
