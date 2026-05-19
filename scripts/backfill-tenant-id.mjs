#!/usr/bin/env node
/**
 * scripts/backfill-tenant-id.mjs
 *
 * Idempotently stamps `tenantId: 'default'` on existing Firestore documents
 * for the collections introduced before the tenant rollout (libraries,
 * albums, photos, upload_idempotency).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... \
 *   FIREBASE_PROJECT_ID=my-project \
 *   node scripts/backfill-tenant-id.mjs [--dry-run]
 *
 * The script is safe to re-run: documents that already carry a `tenantId`
 * are skipped. Documents missing a `tenantId` are updated with
 * `tenantId = 'default'` so they continue to resolve against the default
 * tenant after the rollout.
 *
 * NOTE: This script is intentionally dependency-light \u2014 it only requires
 * `firebase-admin`, which is already a dependency of `functions/`.
 */

import admin from 'firebase-admin';

const DEFAULT_TENANT_ID = 'default';
const COLLECTIONS = ['libraries', 'albums', 'photos', 'upload_idempotency'];
const DRY_RUN = process.argv.includes('--dry-run');

function init() {
  if (admin.apps.length > 0) return;
  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  admin.initializeApp(projectId ? { projectId } : undefined);
}

async function backfillCollection(db, collection) {
  const snap = await db.collection(collection).get();
  let scanned = 0;
  let updated = 0;

  // Firestore batched writes cap at 500 ops; chunk accordingly.
  let batch = db.batch();
  let batchOps = 0;

  for (const doc of snap.docs) {
    scanned += 1;
    const data = doc.data();
    if (data && typeof data.tenantId === 'string' && data.tenantId.length > 0) {
      continue;
    }

    if (DRY_RUN) {
      updated += 1;
      continue;
    }

    batch.update(doc.ref, { tenantId: DEFAULT_TENANT_ID });
    batchOps += 1;
    updated += 1;

    if (batchOps >= 400) {
      await batch.commit();
      batch = db.batch();
      batchOps = 0;
    }
  }

  if (!DRY_RUN && batchOps > 0) {
    await batch.commit();
  }

  console.log(
    `[${collection}] scanned=${scanned} updated=${updated}${
      DRY_RUN ? ' (dry-run)' : ''
    }`
  );
}

async function main() {
  init();
  const db = admin.firestore();
  console.log(
    `Backfilling tenantId='${DEFAULT_TENANT_ID}' across ${COLLECTIONS.join(
      ', '
    )}${DRY_RUN ? ' (dry-run)' : ''}`
  );
  for (const collection of COLLECTIONS) {
    try {
      await backfillCollection(db, collection);
    } catch (err) {
      console.error(`[${collection}] failed:`, err?.message ?? err);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('backfill-tenant-id failed:', err);
  process.exit(1);
});
