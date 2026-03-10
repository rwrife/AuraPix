import { describe, expect, it } from 'vitest';
import { summarizeAuditEventsByType } from '../../src/routes/complianceV1.js';
import type { AuditEventRecord } from '../../src/services/audit/AuditService.js';

describe('summarizeAuditEventsByType', () => {
  it('returns grouped totals by event type', () => {
    const events: AuditEventRecord[] = [
      {
        id: '1',
        eventType: 'compliance.export.requested',
        actorId: 'user-1',
        targetId: 'exp-1',
        createdAt: '2026-03-08T01:00:00.000Z',
      },
      {
        id: '2',
        eventType: 'signing.key.requested',
        actorId: 'user-1',
        targetId: 'key-1',
        createdAt: '2026-03-08T02:00:00.000Z',
      },
      {
        id: '3',
        eventType: 'signing.key.requested',
        actorId: 'user-1',
        targetId: 'key-2',
        createdAt: '2026-03-08T03:00:00.000Z',
      },
    ];

    expect(summarizeAuditEventsByType(events)).toEqual({
      'compliance.export.requested': 1,
      'signing.key.requested': 2,
    });
  });

  it('returns an empty summary for no events', () => {
    expect(summarizeAuditEventsByType([])).toEqual({});
  });
});
