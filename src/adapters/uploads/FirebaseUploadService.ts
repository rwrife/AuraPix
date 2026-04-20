import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as firestoreLimit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import type { UploadSessionsService, FinalizeUploadResult } from '../../domain/uploads/contract';
import type {
  CreateUploadSessionInput,
  DerivativeJobEnvelope,
  FinalizeUploadInput,
  UploadMetadata,
  UploadSession,
} from '../../domain/uploads/types';
import { COLLECTIONS } from '../../config/collections';
import {
  buildCanonicalObjectKey,
  isValidCanonicalObjectKey,
} from './inMemoryUploadSessionsService';

interface FirebaseUploadServiceOptions {
  userId: string;
  libraryId?: string;
  now?: () => number;
}

interface StoredUploadSession {
  ownerUserId: string;
  ownerLibraryId: string;
  fileName: string;
  idempotencyKey: string;
  objectKey: string;
  uploadUrl: string;
  expiresAt: string;
  clientRequestId: string | null;
  createdAt: string;
}

interface StoredUploadMetadata {
  ownerUserId: string;
  ownerLibraryId: string;
  sessionId: string;
  idempotencyKey: string;
  fileName: string;
  objectKey: string;
  sourcePointer: string;
  byteSize: number;
  processingState: UploadMetadata['processingState'];
  derivativeJobId: string;
  createdAt: string;
}

interface StoredDerivativeJob {
  ownerUserId: string;
  ownerLibraryId: string;
  idempotencyKey: string;
  metadataUploadId: string;
  objectKey: string;
  status: DerivativeJobEnvelope['status'];
  createdAt: string;
}

export class FirebaseUploadService implements UploadSessionsService {
  private readonly ownerUserId: string;
  private readonly ownerLibraryId: string;
  private readonly now: () => number;

  constructor(
    private readonly db: Firestore,
    options: FirebaseUploadServiceOptions,
  ) {
    this.ownerUserId = options.userId;
    this.ownerLibraryId = options.libraryId ?? `library-${options.userId}`;
    this.now = options.now ?? Date.now;
  }

  async createUploadSession(input: CreateUploadSessionInput): Promise<UploadSession> {
    const fileName = input.fileName.trim();
    if (!fileName) {
      throw new Error('File name is required.');
    }

    const clientRequestId = input.clientRequestId?.trim();
    if (clientRequestId) {
      const replayQuery = query(
        collection(this.db, COLLECTIONS.UPLOAD_SESSIONS),
        where('ownerUserId', '==', this.ownerUserId),
        where('clientRequestId', '==', clientRequestId),
        firestoreLimit(1),
      );
      const replaySnapshot = await getDocs(replayQuery);
      if (!replaySnapshot.empty) {
        const replay = replaySnapshot.docs[0].data() as StoredUploadSession;
        if (replay.fileName !== fileName) {
          throw new Error('Client request id already used for a different file name.');
        }
        return this.mapSession(replaySnapshot.docs[0].id, replay);
      }
    }

    const sessionId = `uplsess_${crypto.randomUUID()}`;
    const idempotencyKey = `upk_${crypto.randomUUID()}`;
    const objectKey = buildCanonicalObjectKey({ fileName, now: new Date(this.now()) });
    const expiresAt = new Date(this.now() + 15 * 60 * 1000).toISOString();

    const session: StoredUploadSession = {
      ownerUserId: this.ownerUserId,
      ownerLibraryId: this.ownerLibraryId,
      fileName,
      idempotencyKey,
      objectKey,
      uploadUrl: `https://uploads.firebase.local/${sessionId}`,
      expiresAt,
      clientRequestId: clientRequestId ?? null,
      createdAt: new Date(this.now()).toISOString(),
    };

    await setDoc(doc(this.db, COLLECTIONS.UPLOAD_SESSIONS, sessionId), session);
    return this.mapSession(sessionId, session);
  }

  async finalizeUpload(input: FinalizeUploadInput): Promise<FinalizeUploadResult> {
    if (input.byteSize <= 0) {
      throw new Error('Byte size must be greater than zero.');
    }

    const normalizedFileName = input.fileName.trim();
    if (!normalizedFileName) {
      throw new Error('File name is required.');
    }

    const sessionDoc = await getDoc(doc(this.db, COLLECTIONS.UPLOAD_SESSIONS, input.sessionId));
    if (!sessionDoc.exists()) {
      throw new Error('Upload session not found.');
    }

    const session = sessionDoc.data() as StoredUploadSession;
    if (session.ownerUserId !== this.ownerUserId || session.ownerLibraryId !== this.ownerLibraryId) {
      throw new Error('Upload session not found.');
    }

    if (input.idempotencyKey !== session.idempotencyKey) {
      throw new Error('Idempotency key does not match upload session.');
    }

    if (!isValidCanonicalObjectKey(session.objectKey)) {
      throw new Error('Upload object key is invalid.');
    }

    const replayQuery = query(
      collection(this.db, COLLECTIONS.UPLOAD_METADATA),
      where('ownerUserId', '==', this.ownerUserId),
      where('idempotencyKey', '==', input.idempotencyKey),
      firestoreLimit(1),
    );
    const replaySnapshot = await getDocs(replayQuery);
    if (!replaySnapshot.empty) {
      const replayDoc = replaySnapshot.docs[0];
      const replay = replayDoc.data() as StoredUploadMetadata;
      if (replay.sessionId !== input.sessionId) {
        throw new Error('Idempotency key already used by a different upload session.');
      }

      const replayJob = await this.getJobById(replay.derivativeJobId);
      return {
        metadata: this.mapMetadata(replayDoc.id, replay),
        job: replayJob,
        idempotentReplay: true,
      };
    }

    const uploadId = `upl_${crypto.randomUUID()}`;
    const jobId = `drv_${crypto.randomUUID()}`;
    const nowIso = new Date(this.now()).toISOString();

    const metadata: StoredUploadMetadata = {
      ownerUserId: this.ownerUserId,
      ownerLibraryId: this.ownerLibraryId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      fileName: normalizedFileName,
      objectKey: session.objectKey,
      sourcePointer: `gs://${this.ownerLibraryId}/${session.objectKey}`,
      byteSize: input.byteSize,
      processingState: 'pending_processing',
      derivativeJobId: jobId,
      createdAt: nowIso,
    };

    const job: StoredDerivativeJob = {
      ownerUserId: this.ownerUserId,
      ownerLibraryId: this.ownerLibraryId,
      idempotencyKey: input.idempotencyKey,
      metadataUploadId: uploadId,
      objectKey: session.objectKey,
      status: 'queued',
      createdAt: nowIso,
    };

    await setDoc(doc(this.db, COLLECTIONS.UPLOAD_METADATA, uploadId), metadata);
    await setDoc(doc(this.db, COLLECTIONS.DERIVATIVE_JOBS, jobId), job);

    return {
      metadata: this.mapMetadata(uploadId, metadata),
      job: this.mapJob(jobId, job),
      idempotentReplay: false,
    };
  }

  async listUploadedMetadata(): Promise<UploadMetadata[]> {
    const metadataQuery = query(
      collection(this.db, COLLECTIONS.UPLOAD_METADATA),
      where('ownerUserId', '==', this.ownerUserId),
      where('ownerLibraryId', '==', this.ownerLibraryId),
      orderBy('createdAt', 'desc'),
    );
    const snapshot = await getDocs(metadataQuery);
    return snapshot.docs.map((docSnap) => this.mapMetadata(docSnap.id, docSnap.data() as StoredUploadMetadata));
  }

  async listDerivativeJobs(): Promise<DerivativeJobEnvelope[]> {
    const jobsQuery = query(
      collection(this.db, COLLECTIONS.DERIVATIVE_JOBS),
      where('ownerUserId', '==', this.ownerUserId),
      where('ownerLibraryId', '==', this.ownerLibraryId),
      orderBy('createdAt', 'asc'),
    );
    const snapshot = await getDocs(jobsQuery);
    return snapshot.docs.map((docSnap) => this.mapJob(docSnap.id, docSnap.data() as StoredDerivativeJob));
  }

  async processNextDerivativeJob(): Promise<DerivativeJobEnvelope | null> {
    const queuedJobsQuery = query(
      collection(this.db, COLLECTIONS.DERIVATIVE_JOBS),
      where('ownerUserId', '==', this.ownerUserId),
      where('ownerLibraryId', '==', this.ownerLibraryId),
      where('status', '==', 'queued'),
      orderBy('createdAt', 'asc'),
      firestoreLimit(1),
    );
    const snapshot = await getDocs(queuedJobsQuery);
    if (snapshot.empty) {
      return null;
    }

    const jobDoc = snapshot.docs[0];
    const job = jobDoc.data() as StoredDerivativeJob;
    const completedJob: StoredDerivativeJob = {
      ...job,
      status: 'completed',
    };

    await updateDoc(doc(this.db, COLLECTIONS.DERIVATIVE_JOBS, jobDoc.id), {
      status: 'completed',
    });
    await updateDoc(doc(this.db, COLLECTIONS.UPLOAD_METADATA, job.metadataUploadId), {
      processingState: 'completed',
    });

    return this.mapJob(jobDoc.id, completedJob);
  }

  private async getJobById(jobId: string): Promise<DerivativeJobEnvelope> {
    const jobDoc = await getDoc(doc(this.db, COLLECTIONS.DERIVATIVE_JOBS, jobId));
    if (!jobDoc.exists()) {
      throw new Error('Derivative job not found for finalized upload.');
    }
    const job = jobDoc.data() as StoredDerivativeJob;
    if (job.ownerUserId !== this.ownerUserId || job.ownerLibraryId !== this.ownerLibraryId) {
      throw new Error('Derivative job not found for finalized upload.');
    }
    return this.mapJob(jobDoc.id, job);
  }

  private mapSession(sessionId: string, session: StoredUploadSession): UploadSession {
    return {
      sessionId,
      idempotencyKey: session.idempotencyKey,
      objectKey: session.objectKey,
      uploadUrl: session.uploadUrl,
      expiresAt: session.expiresAt,
    };
  }

  private mapMetadata(uploadId: string, metadata: StoredUploadMetadata): UploadMetadata {
    return {
      uploadId,
      fileName: metadata.fileName,
      objectKey: metadata.objectKey,
      sourcePointer: metadata.sourcePointer,
      byteSize: metadata.byteSize,
      processingState: metadata.processingState,
      derivativeJobId: metadata.derivativeJobId,
    };
  }

  private mapJob(jobId: string, job: StoredDerivativeJob): DerivativeJobEnvelope {
    return {
      jobId,
      idempotencyKey: job.idempotencyKey,
      metadataUploadId: job.metadataUploadId,
      objectKey: job.objectKey,
      status: job.status,
      createdAt: job.createdAt,
    };
  }
}
