import { randomUUID } from 'node:crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';

export interface AuditEventRecord {
  id: string;
  eventType: string;
  actorId: string;
  targetId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export async function recordAuditEvent(
  dataAdapter: DataAdapter,
  event: Omit<AuditEventRecord, 'id' | 'createdAt'> & { createdAt?: string }
): Promise<AuditEventRecord> {
  const record: AuditEventRecord = {
    id: randomUUID(),
    createdAt: event.createdAt ?? new Date().toISOString(),
    ...event,
  };

  await dataAdapter.storeData<AuditEventRecord>('auditEvents', record.id, record);
  return record;
}
