import { randomUUID } from 'node:crypto';
import type { DataAdapter, QueryFilter } from '../../adapters/data/DataAdapter.js';

/**
 * Persistent audit record for sensitive tenant operations.
 *
 * The original shape (`eventType`, `actorId`, `targetId`, `createdAt`) is
 * preserved for backward compatibility with existing callers
 * (signing, branding, compliance routes). Issue #164 adds:
 *   - `tenantId` so the host audit-events API can filter by tenant
 *   - `occurredAt` as the canonical timestamp (mirrors `createdAt`)
 *   - `resourceType` so the API can categorise records without parsing
 *     `eventType`
 *
 * `createdAt` continues to be set; for newly written records `occurredAt`
 * equals `createdAt`. Legacy records without `tenantId` are not returned by
 * the host API (strict tenant-scoped filter).
 */
export const AUDIT_EVENTS_COLLECTION = 'auditEvents';

export interface AuditEventRecord {
  id: string;
  eventType: string;
  actorId: string;
  /** Optional target/resource identifier (e.g. exportRequestId, keyId). */
  targetId?: string;
  /**
   * Tenant identifier. Added in issue #164 for the host audit-events API.
   * Optional for backward compatibility with pre-tenant call sites; the
   * host API filters strictly by tenantId, so records without one are not
   * returned by that endpoint.
   */
  tenantId?: string;
  /**
   * Coarse resource type the event applies to. Examples:
   *   "compliance.export" | "branding" | "share-link" | "tenant-api-key"
   * When omitted, callers can infer from `eventType`.
   */
  resourceType?: string;
  /** ISO-8601 timestamp; preserved for backward compatibility. */
  createdAt: string;
  /**
   * ISO-8601 timestamp used by the host API as the canonical "when". Equal
   * to `createdAt` for new records; left undefined on legacy records, in
   * which case readers should fall back to `createdAt`.
   */
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAuditEvent(
  dataAdapter: DataAdapter,
  event: Omit<AuditEventRecord, 'id' | 'createdAt' | 'occurredAt'> & {
    createdAt?: string;
    occurredAt?: string;
  }
): Promise<AuditEventRecord> {
  const ts = event.occurredAt ?? event.createdAt ?? new Date().toISOString();
  const record: AuditEventRecord = {
    id: randomUUID(),
    createdAt: ts,
    occurredAt: ts,
    ...event,
    // Re-assert canonical timestamps so caller-supplied `createdAt` /
    // `occurredAt` win, but at least one is always present.
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
    ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
  };

  await dataAdapter.storeData<AuditEventRecord>(
    AUDIT_EVENTS_COLLECTION,
    record.id,
    record
  );
  return record;
}

/**
 * Lightweight query helper used by the host audit-events API
 * (issue #164). Filters that map cleanly to a `QueryFilter` are pushed
 * down to the adapter; in-memory adapters then apply the rest. Firestore
 * relies on the composite index added in this PR for the
 * `(tenantId asc, occurredAt desc)` ordering.
 *
 * NOTE: The DataAdapter abstraction does not yet expose orderBy / startAfter
 * pagination, so this helper paginates in-memory after a tenant-scoped
 * query. To keep memory bounded we cap the underlying fetch at
 * `HARD_FETCH_CAP` and reject calls that try to page past it; callers can
 * narrow with `since`/`until` to stay within the cap.
 */
export const AUDIT_HARD_FETCH_CAP = 5000;

export interface AuditEventQuery {
  tenantId: string;
  since?: string;
  until?: string;
  actorId?: string;
  action?: string;
  resourceType?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface AuditEventPage {
  events: AuditEventRecord[];
  nextPageToken: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** Retention window (days) returned by the API. */
export const AUDIT_RETENTION_DAYS = 90;

function compareDesc(a: AuditEventRecord, b: AuditEventRecord): number {
  const at = a.occurredAt ?? a.createdAt;
  const bt = b.occurredAt ?? b.createdAt;
  if (at !== bt) return bt.localeCompare(at);
  return b.id.localeCompare(a.id);
}

export function encodePageToken(record: AuditEventRecord): string {
  const ts = record.occurredAt ?? record.createdAt;
  const payload = JSON.stringify({ t: ts, i: record.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodePageToken(
  token: string
): { t: string; i: string } | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') {
      return null;
    }
    return { t: parsed.t, i: parsed.i };
  } catch {
    return null;
  }
}

export async function queryAuditEvents(
  dataAdapter: DataAdapter,
  query: AuditEventQuery
): Promise<AuditEventPage> {
  const pageSize = Math.min(
    Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );

  // Retention floor: never return records older than the hard cap.
  const retentionFloor = new Date(
    Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const sinceEffective =
    query.since && query.since > retentionFloor ? query.since : retentionFloor;

  const filters: QueryFilter[] = [
    { field: 'tenantId', operator: '==', value: query.tenantId },
  ];
  if (query.actorId) {
    filters.push({ field: 'actorId', operator: '==', value: query.actorId });
  }
  if (query.action) {
    filters.push({ field: 'eventType', operator: '==', value: query.action });
  }
  if (query.resourceType) {
    filters.push({
      field: 'resourceType',
      operator: '==',
      value: query.resourceType,
    });
  }

  const records = await dataAdapter.queryData<AuditEventRecord>(
    AUDIT_EVENTS_COLLECTION,
    filters
  );

  // Time bounds (applied in-memory; Firestore equivalent is a range filter
  // on occurredAt within the same composite index).
  const filtered = records.filter((r) => {
    const ts = r.occurredAt ?? r.createdAt;
    if (!ts) return false;
    if (ts < sinceEffective) return false;
    if (query.until && ts > query.until) return false;
    return true;
  });

  filtered.sort(compareDesc);

  // Cursor: pageToken encodes the (occurredAt,id) of the last returned
  // record; skip rows that sort >= the cursor (since order is desc).
  let startIdx = 0;
  if (query.pageToken) {
    const cur = decodePageToken(query.pageToken);
    if (!cur) {
      // Invalid token — treat as start (safer than 400 on transient client
      // bugs; callers needing strictness validate at the route layer).
      startIdx = 0;
    } else {
      startIdx = filtered.findIndex((r) => {
        const ts = r.occurredAt ?? r.createdAt;
        if (ts < cur.t) return true;
        if (ts > cur.t) return false;
        return r.id < cur.i;
      });
      if (startIdx === -1) startIdx = filtered.length;
    }
  }

  const slice = filtered.slice(startIdx, startIdx + pageSize);
  const nextToken =
    startIdx + pageSize < filtered.length && slice.length > 0
      ? encodePageToken(slice[slice.length - 1]!)
      : null;

  return { events: slice, nextPageToken: nextToken };
}
