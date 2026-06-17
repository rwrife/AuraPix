import fs from 'node:fs';

const INDEX_PATH = 'firestore.indexes.json';

const REQUIRED_INDEXES = [
  {
    collectionGroup: 'uploadSessions',
    fields: [
      { fieldPath: 'ownerUserId', order: 'ASCENDING' },
      { fieldPath: 'clientRequestId', order: 'ASCENDING' },
    ],
  },
  {
    collectionGroup: 'uploadMetadata',
    fields: [
      { fieldPath: 'ownerUserId', order: 'ASCENDING' },
      { fieldPath: 'idempotencyKey', order: 'ASCENDING' },
    ],
  },
  {
    collectionGroup: 'uploadMetadata',
    fields: [
      { fieldPath: 'ownerUserId', order: 'ASCENDING' },
      { fieldPath: 'ownerLibraryId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
    ],
  },
  {
    collectionGroup: 'derivativeJobs',
    fields: [
      { fieldPath: 'ownerUserId', order: 'ASCENDING' },
      { fieldPath: 'ownerLibraryId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'ASCENDING' },
    ],
  },
  {
    collectionGroup: 'derivativeJobs',
    fields: [
      { fieldPath: 'ownerUserId', order: 'ASCENDING' },
      { fieldPath: 'ownerLibraryId', order: 'ASCENDING' },
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'ASCENDING' },
    ],
  },
  {
    // Host audit-events API (issue #164): tenant-scoped listing
    // ordered by occurredAt desc.
    collectionGroup: 'auditEvents',
    fields: [
      { fieldPath: 'tenantId', order: 'ASCENDING' },
      { fieldPath: 'occurredAt', order: 'DESCENDING' },
    ],
  },
];

function loadIndexFile() {
  const raw = fs.readFileSync(INDEX_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.indexes)) {
    throw new Error(`${INDEX_PATH} must contain an "indexes" array.`);
  }

  return parsed.indexes;
}

function normalizeIndex(index) {
  const fields = Array.isArray(index.fields) ? index.fields : [];
  const fieldKey = fields
    .map((field) => {
      const mode = field.order ?? field.arrayConfig ?? 'UNKNOWN';
      return `${field.fieldPath}:${mode}`;
    })
    .join(',');
  return `${index.collectionGroup}|${fieldKey}`;
}

function describeIndex(index) {
  return `${index.collectionGroup} [${index.fields
    .map((field) => `${field.fieldPath}:${field.order ?? field.arrayConfig ?? 'UNKNOWN'}`)
    .join(', ')}]`;
}

function main() {
  const indexes = loadIndexFile();
  const available = new Set(indexes.map(normalizeIndex));

  const missing = REQUIRED_INDEXES.filter((required) => !available.has(normalizeIndex(required)));

  if (missing.length > 0) {
    console.error('Firestore index validation failed. Missing required indexes:');
    for (const index of missing) {
      console.error(`- ${describeIndex(index)}`);
    }
    process.exit(1);
  }

  console.log(`Firestore index validation passed (${REQUIRED_INDEXES.length} required indexes present).`);
}

main();
