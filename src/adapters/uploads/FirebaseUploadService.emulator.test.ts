// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectFirestoreEmulator, getFirestore, terminate, type Firestore } from 'firebase/firestore';
import { FirebaseUploadService } from './FirebaseUploadService';

interface ServiceHarness {
  app: FirebaseApp;
  db: Firestore;
  service: FirebaseUploadService;
}

const createdHarnesses: ServiceHarness[] = [];

function getEmulatorHostPort(): { host: string; port: number } {
  const rawHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!rawHost) {
    throw new Error('FIRESTORE_EMULATOR_HOST must be set. Run this suite with firebase emulators:exec.');
  }

  const [host, portText] = rawHost.split(':');
  const port = Number(portText);
  if (!host || Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid FIRESTORE_EMULATOR_HOST value: ${rawHost}`);
  }

  return { host, port };
}

function createServiceHarness(userId: string, libraryId?: string): ServiceHarness {
  const { host, port } = getEmulatorHostPort();
  const app = initializeApp(
    {
      apiKey: 'demo-key',
      appId: `aurapix-emulator-${crypto.randomUUID()}`,
      projectId: process.env.GCLOUD_PROJECT ?? 'demo-aurapix',
    },
    `aurapix-emulator-${crypto.randomUUID()}`,
  );
  const db = getFirestore(app);
  connectFirestoreEmulator(db, host, port);

  const service = new FirebaseUploadService(db, {
    userId,
    libraryId,
    now: () => 1_700_000_000_000,
  });

  const harness = { app, db, service };
  createdHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (createdHarnesses.length > 0) {
    const harness = createdHarnesses.pop();
    if (!harness) {
      continue;
    }

    await terminate(harness.db);
    await deleteApp(harness.app);
  }
});

describe('FirebaseUploadService (Firestore emulator)', () => {
  it('creates upload sessions and replays by client request id', async () => {
    const { service } = createServiceHarness(`user-${crypto.randomUUID()}`);

    const first = await service.createUploadSession({
      fileName: 'Photo.JPG',
      clientRequestId: 'req-1',
    });
    const replay = await service.createUploadSession({
      fileName: 'Photo.JPG',
      clientRequestId: 'req-1',
    });

    expect(replay).toEqual(first);
    expect(first.sessionId).toMatch(/^uplsess_/);
    expect(first.idempotencyKey).toMatch(/^upk_/);
    expect(first.objectKey).toMatch(/^uploads\/\d{4}\/\d{2}\/\d{2}\/photo\.jpg$/);
    expect(first.uploadUrl).toContain(first.sessionId);
  });

  it('finalizes uploads with idempotent replay and queue processing', async () => {
    const { service } = createServiceHarness(`user-${crypto.randomUUID()}`);
    const session = await service.createUploadSession({ fileName: 'photo.jpg' });

    const firstFinalize = await service.finalizeUpload({
      sessionId: session.sessionId,
      idempotencyKey: session.idempotencyKey,
      fileName: 'photo.jpg',
      byteSize: 2048,
    });
    expect(firstFinalize.idempotentReplay).toBe(false);
    expect(firstFinalize.metadata.processingState).toBe('pending_processing');
    expect(firstFinalize.job.status).toBe('queued');

    const replayFinalize = await service.finalizeUpload({
      sessionId: session.sessionId,
      idempotencyKey: session.idempotencyKey,
      fileName: 'photo.jpg',
      byteSize: 2048,
    });
    expect(replayFinalize.idempotentReplay).toBe(true);
    expect(replayFinalize.metadata.uploadId).toBe(firstFinalize.metadata.uploadId);
    expect(replayFinalize.job.jobId).toBe(firstFinalize.job.jobId);

    const metadataBeforeProcessing = await service.listUploadedMetadata();
    const jobsBeforeProcessing = await service.listDerivativeJobs();
    expect(metadataBeforeProcessing).toHaveLength(1);
    expect(jobsBeforeProcessing).toHaveLength(1);
    expect(jobsBeforeProcessing[0].status).toBe('queued');

    const processedJob = await service.processNextDerivativeJob();
    expect(processedJob).not.toBeNull();
    expect(processedJob?.status).toBe('completed');

    const metadataAfterProcessing = await service.listUploadedMetadata();
    const jobsAfterProcessing = await service.listDerivativeJobs();
    expect(metadataAfterProcessing[0].processingState).toBe('completed');
    expect(jobsAfterProcessing[0].status).toBe('completed');
  });

  it('enforces owner user and owner library scoping', async () => {
    const ownerUserId = `user-${crypto.randomUUID()}`;
    const { service: ownerLibraryA } = createServiceHarness(ownerUserId, 'library-a');
    const { service: ownerLibraryB } = createServiceHarness(ownerUserId, 'library-b');
    const { service: otherUser } = createServiceHarness(`user-${crypto.randomUUID()}`, 'library-a');

    const session = await ownerLibraryA.createUploadSession({ fileName: 'scoped.jpg' });
    await ownerLibraryA.finalizeUpload({
      sessionId: session.sessionId,
      idempotencyKey: session.idempotencyKey,
      fileName: 'scoped.jpg',
      byteSize: 1024,
    });

    expect(await ownerLibraryA.listUploadedMetadata()).toHaveLength(1);
    expect(await ownerLibraryA.listDerivativeJobs()).toHaveLength(1);

    expect(await ownerLibraryB.listUploadedMetadata()).toHaveLength(0);
    expect(await ownerLibraryB.listDerivativeJobs()).toHaveLength(0);
    expect(await otherUser.listUploadedMetadata()).toHaveLength(0);
    expect(await otherUser.listDerivativeJobs()).toHaveLength(0);

    await expect(
      ownerLibraryB.finalizeUpload({
        sessionId: session.sessionId,
        idempotencyKey: session.idempotencyKey,
        fileName: 'scoped.jpg',
        byteSize: 1024,
      }),
    ).rejects.toThrow('Upload session not found.');
  });
});
