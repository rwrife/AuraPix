import type { FinalizeUploadResult, UploadSessionsService } from '../../domain/uploads/contract';
import type {
  CreateUploadSessionInput,
  DerivativeJobEnvelope,
  FinalizeUploadInput,
  UploadMetadata,
  UploadSession,
} from '../../domain/uploads/types';

interface StoredFinalizeResult {
  sessionId: string;
  result: FinalizeUploadResult;
}

function slugifyFileName(fileName: string): string {
  return fileName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildCanonicalObjectKey({
  fileName,
  now = new Date(),
}: {
  fileName: string;
  now?: Date;
}): string {
  const cleanName = slugifyFileName(fileName);
  if (!cleanName) {
    throw new Error('File name is required to build canonical object key.');
  }

  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `uploads/${year}/${month}/${day}/${cleanName}`;
}

export function isValidCanonicalObjectKey(key: string): boolean {
  return /^uploads\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9._-]+$/.test(key);
}

export class InMemoryUploadSessionsService implements UploadSessionsService {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly finalizeByIdempotency = new Map<string, StoredFinalizeResult>();
  private readonly metadata = new Map<string, UploadMetadata>();
  private readonly jobs = new Map<string, DerivativeJobEnvelope>();

  async createUploadSession(input: CreateUploadSessionInput): Promise<UploadSession> {
    const fileName = input.fileName.trim();
    if (!fileName) {
      throw new Error('File name is required.');
    }

    const sessionId = `uplsess_${crypto.randomUUID()}`;
    const idempotencyKey = `upk_${crypto.randomUUID()}`;
    const objectKey = buildCanonicalObjectKey({ fileName });

    const session: UploadSession = {
      sessionId,
      idempotencyKey,
      objectKey,
      uploadUrl: `https://uploads.local/${sessionId}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  async finalizeUpload(input: FinalizeUploadInput): Promise<FinalizeUploadResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new Error('Upload session not found.');
    }

    if (input.idempotencyKey !== session.idempotencyKey) {
      throw new Error('Idempotency key does not match upload session.');
    }

    if (input.byteSize <= 0) {
      throw new Error('Byte size must be greater than zero.');
    }

    const replay = this.finalizeByIdempotency.get(input.idempotencyKey);
    if (replay) {
      if (replay.sessionId !== input.sessionId) {
        throw new Error('Idempotency key already used by a different upload session.');
      }
      return {
        ...replay.result,
        idempotentReplay: true,
      };
    }

    if (!isValidCanonicalObjectKey(session.objectKey)) {
      throw new Error('Upload object key is invalid.');
    }

    const uploadId = `upl_${crypto.randomUUID()}`;
    const jobId = `drv_${crypto.randomUUID()}`;

    const metadata: UploadMetadata = {
      uploadId,
      fileName: input.fileName.trim(),
      objectKey: session.objectKey,
      sourcePointer: `gs://aurapix-dev/${session.objectKey}`,
      byteSize: input.byteSize,
      processingState: 'pending_processing',
      derivativeJobId: jobId,
    };

    const job: DerivativeJobEnvelope = {
      jobId,
      idempotencyKey: input.idempotencyKey,
      metadataUploadId: uploadId,
      objectKey: session.objectKey,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };

    this.metadata.set(uploadId, metadata);
    this.jobs.set(jobId, job);

    const result: FinalizeUploadResult = {
      metadata,
      job,
      idempotentReplay: false,
    };

    this.finalizeByIdempotency.set(input.idempotencyKey, {
      sessionId: input.sessionId,
      result,
    });

    return result;
  }

  async listUploadedMetadata(): Promise<UploadMetadata[]> {
    return [...this.metadata.values()];
  }

  async listDerivativeJobs(): Promise<DerivativeJobEnvelope[]> {
    return [...this.jobs.values()];
  }

  async processNextDerivativeJob(): Promise<DerivativeJobEnvelope | null> {
    const nextJob = [...this.jobs.values()].find((job) => job.status === 'queued');
    if (!nextJob) {
      return null;
    }

    const completedJob: DerivativeJobEnvelope = {
      ...nextJob,
      status: 'completed',
    };

    this.jobs.set(completedJob.jobId, completedJob);

    const metadata = this.metadata.get(completedJob.metadataUploadId);
    if (metadata) {
      this.metadata.set(metadata.uploadId, {
        ...metadata,
        processingState: 'completed',
      });
    }

    return completedJob;
  }
}
