import { createHash } from 'node:crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';

const IDEMPOTENCY_COLLECTION = 'upload_idempotency';
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export interface UploadRequestFingerprint {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadIdempotencyRecord {
  key: string;
  userId: string;
  libraryId: string;
  request: UploadRequestFingerprint;
  responseBody: unknown;
  createdAt: string;
}

export function getNormalizedIdempotencyKey(
  headerValue: string | string[] | undefined
): string | null {
  if (typeof headerValue !== 'string') {
    return null;
  }

  const normalized = headerValue.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(`Idempotency key exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }

  return normalized;
}

export function createUploadFingerprint(file: {
  originalname: string;
  mimetype: string;
  size: number;
}): UploadRequestFingerprint {
  return {
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
  };
}

function buildRecordId(userId: string, libraryId: string, key: string): string {
  return createHash('sha256').update(`${userId}:${libraryId}:${key}`).digest('hex');
}

export async function getUploadIdempotencyRecord(
  dataAdapter: DataAdapter,
  userId: string,
  libraryId: string,
  key: string
): Promise<UploadIdempotencyRecord | null> {
  const recordId = buildRecordId(userId, libraryId, key);
  return dataAdapter.fetchData<UploadIdempotencyRecord>(IDEMPOTENCY_COLLECTION, recordId);
}

export async function storeUploadIdempotencyRecord(
  dataAdapter: DataAdapter,
  record: UploadIdempotencyRecord
): Promise<void> {
  const recordId = buildRecordId(record.userId, record.libraryId, record.key);
  await dataAdapter.storeData(IDEMPOTENCY_COLLECTION, recordId, record);
}

export function uploadFingerprintMatches(
  expected: UploadRequestFingerprint,
  actual: UploadRequestFingerprint
): boolean {
  return (
    expected.originalName === actual.originalName &&
    expected.mimeType === actual.mimeType &&
    expected.sizeBytes === actual.sizeBytes
  );
}
