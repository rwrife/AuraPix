import { createHash } from 'node:crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';

const IDEMPOTENCY_COLLECTION = 'edit_idempotency';
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export interface ApplyEditsFingerprint {
  kind: 'apply';
  recipeVersion: number;
  operationsHash: string;
  description: string | null;
}

export interface RevertEditsFingerprint {
  kind: 'revert';
  targetVersion: number;
}

export type EditRequestFingerprint = ApplyEditsFingerprint | RevertEditsFingerprint;

export interface EditIdempotencyRecord {
  key: string;
  userId: string;
  libraryId: string;
  photoId: string;
  request: EditRequestFingerprint;
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

export function createApplyEditsFingerprint(input: {
  recipeVersion: number;
  operations: unknown;
  description?: string;
}): ApplyEditsFingerprint {
  return {
    kind: 'apply',
    recipeVersion: input.recipeVersion,
    operationsHash: createHash('sha256').update(JSON.stringify(input.operations)).digest('hex'),
    description: input.description ?? null,
  };
}

export function createRevertFingerprint(targetVersion: number): RevertEditsFingerprint {
  return {
    kind: 'revert',
    targetVersion,
  };
}

function buildRecordId(
  userId: string,
  libraryId: string,
  photoId: string,
  key: string
): string {
  return createHash('sha256')
    .update(`${userId}:${libraryId}:${photoId}:${key}`)
    .digest('hex');
}

export async function getEditIdempotencyRecord(
  dataAdapter: DataAdapter,
  userId: string,
  libraryId: string,
  photoId: string,
  key: string
): Promise<EditIdempotencyRecord | null> {
  const recordId = buildRecordId(userId, libraryId, photoId, key);
  return dataAdapter.fetchData<EditIdempotencyRecord>(IDEMPOTENCY_COLLECTION, recordId);
}

export async function storeEditIdempotencyRecord(
  dataAdapter: DataAdapter,
  record: EditIdempotencyRecord
): Promise<void> {
  const recordId = buildRecordId(record.userId, record.libraryId, record.photoId, record.key);
  await dataAdapter.storeData(IDEMPOTENCY_COLLECTION, recordId, record);
}

export function editFingerprintMatches(
  expected: EditRequestFingerprint,
  actual: EditRequestFingerprint
): boolean {
  if (expected.kind !== actual.kind) {
    return false;
  }

  if (expected.kind === 'apply' && actual.kind === 'apply') {
    return (
      expected.recipeVersion === actual.recipeVersion &&
      expected.operationsHash === actual.operationsHash &&
      expected.description === actual.description
    );
  }

  if (expected.kind === 'revert' && actual.kind === 'revert') {
    return expected.targetVersion === actual.targetVersion;
  }

  return false;
}
