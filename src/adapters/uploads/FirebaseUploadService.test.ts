import { beforeEach, describe, expect, it, vi } from 'vitest';

type FirestoreDoc = Record<string, unknown>;

interface CollectionRefMock {
  path: string;
}

interface DocRefMock {
  collectionPath: string;
  id: string;
}

interface WhereConstraint {
  kind: 'where';
  fieldPath: string;
  value: unknown;
}

interface OrderByConstraint {
  kind: 'orderBy';
  fieldPath: string;
  direction: 'asc' | 'desc';
}

interface LimitConstraint {
  kind: 'limit';
  value: number;
}

type QueryConstraintMock = WhereConstraint | OrderByConstraint | LimitConstraint;

interface QueryRefMock {
  collectionPath: string;
  constraints: QueryConstraintMock[];
}

const dbState = new Map<string, Map<string, FirestoreDoc>>();
let nextAutoId = 0;

function ensureCollection(path: string): Map<string, FirestoreDoc> {
  const existing = dbState.get(path);
  if (existing) {
    return existing;
  }
  const created = new Map<string, FirestoreDoc>();
  dbState.set(path, created);
  return created;
}

function cloneDoc(docData: FirestoreDoc): FirestoreDoc {
  return { ...docData };
}

function applyConstraints(docs: Array<{ id: string; data: FirestoreDoc }>, constraints: QueryConstraintMock[]) {
  let result = docs;

  for (const constraint of constraints) {
    if (constraint.kind === 'where') {
      result = result.filter((docEntry) => docEntry.data[constraint.fieldPath] === constraint.value);
    }
  }

  for (const constraint of constraints) {
    if (constraint.kind === 'orderBy') {
      result = [...result].sort((left, right) => {
        const leftValue = left.data[constraint.fieldPath];
        const rightValue = right.data[constraint.fieldPath];

        if (leftValue === rightValue) {
          return 0;
        }
        if (leftValue === undefined) {
          return 1;
        }
        if (rightValue === undefined) {
          return -1;
        }

        const comparison = String(leftValue).localeCompare(String(rightValue));
        return constraint.direction === 'asc' ? comparison : comparison * -1;
      });
    }
  }

  const limitConstraint = constraints.find((constraint) => constraint.kind === 'limit') as
    | LimitConstraint
    | undefined;
  if (limitConstraint) {
    result = result.slice(0, limitConstraint.value);
  }

  return result;
}

vi.mock('firebase/firestore', () => {
  return {
    collection: (_db: unknown, path: string): CollectionRefMock => ({ path }),
    doc: (first: unknown, second: string, third?: string): DocRefMock => {
      if (typeof third === 'string') {
        return {
          collectionPath: second,
          id: third,
        };
      }

      return {
        collectionPath: (first as CollectionRefMock).path,
        id: second,
      };
    },
    where: (fieldPath: string, op: string, value: unknown): WhereConstraint => {
      if (op !== '==') {
        throw new Error(`Unsupported where operator in test mock: ${op}`);
      }
      return {
        kind: 'where',
        fieldPath,
        value,
      };
    },
    orderBy: (fieldPath: string, direction: 'asc' | 'desc' = 'asc'): OrderByConstraint => ({
      kind: 'orderBy',
      fieldPath,
      direction,
    }),
    limit: (value: number): LimitConstraint => ({
      kind: 'limit',
      value,
    }),
    query: (collectionRef: CollectionRefMock, ...constraints: QueryConstraintMock[]): QueryRefMock => ({
      collectionPath: collectionRef.path,
      constraints,
    }),
    setDoc: async (docRef: DocRefMock, data: FirestoreDoc): Promise<void> => {
      const collectionStore = ensureCollection(docRef.collectionPath);
      collectionStore.set(docRef.id, cloneDoc(data));
    },
    addDoc: async (collectionRef: CollectionRefMock, data: FirestoreDoc): Promise<{ id: string }> => {
      const collectionStore = ensureCollection(collectionRef.path);
      const id = `auto_${nextAutoId++}`;
      collectionStore.set(id, cloneDoc(data));
      return { id };
    },
    updateDoc: async (docRef: DocRefMock, updates: FirestoreDoc): Promise<void> => {
      const collectionStore = ensureCollection(docRef.collectionPath);
      const existing = collectionStore.get(docRef.id);
      if (!existing) {
        throw new Error(`Doc not found: ${docRef.collectionPath}/${docRef.id}`);
      }
      collectionStore.set(docRef.id, { ...existing, ...updates });
    },
    getDoc: async (docRef: DocRefMock) => {
      const collectionStore = ensureCollection(docRef.collectionPath);
      const data = collectionStore.get(docRef.id);
      return {
        id: docRef.id,
        exists: () => Boolean(data),
        data: () => cloneDoc(data ?? {}),
      };
    },
    getDocs: async (target: QueryRefMock | CollectionRefMock) => {
      const isQuery = 'constraints' in target;
      const collectionPath = isQuery ? target.collectionPath : target.path;
      const constraints = isQuery ? target.constraints : [];
      const collectionStore = ensureCollection(collectionPath);
      const rawDocs = [...collectionStore.entries()].map(([id, data]) => ({
        id,
        data,
      }));
      const docs = applyConstraints(rawDocs, constraints).map((entry) => ({
        id: entry.id,
        data: () => cloneDoc(entry.data),
      }));
      return {
        empty: docs.length === 0,
        docs,
      };
    },
  };
});

import { FirebaseUploadService } from './FirebaseUploadService';

describe('FirebaseUploadService', () => {
  beforeEach(() => {
    dbState.clear();
    nextAutoId = 0;
  });

  it('creates upload sessions and replays by client request id', async () => {
    const service = new FirebaseUploadService({} as never, { userId: 'user-1', now: () => 1_700_000_000_000 });

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
    const service = new FirebaseUploadService({} as never, { userId: 'user-1', now: () => 1_700_000_000_000 });
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

  it('scopes metadata and jobs by user', async () => {
    const alice = new FirebaseUploadService({} as never, { userId: 'alice', now: () => 1_700_000_000_000 });
    const bob = new FirebaseUploadService({} as never, { userId: 'bob', now: () => 1_700_000_000_000 });

    const aliceSession = await alice.createUploadSession({ fileName: 'alice.jpg' });
    await alice.finalizeUpload({
      sessionId: aliceSession.sessionId,
      idempotencyKey: aliceSession.idempotencyKey,
      fileName: 'alice.jpg',
      byteSize: 1024,
    });

    expect(await alice.listUploadedMetadata()).toHaveLength(1);
    expect(await alice.listDerivativeJobs()).toHaveLength(1);
    expect(await bob.listUploadedMetadata()).toHaveLength(0);
    expect(await bob.listDerivativeJobs()).toHaveLength(0);
  });
});
