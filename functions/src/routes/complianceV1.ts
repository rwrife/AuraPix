import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { featureConfig } from '../config/index.js';
import type { AuditEventRecord } from '../services/audit/AuditService.js';
import { recordAuditEvent } from '../services/audit/AuditService.js';

export type ExportRequestStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ExportRequestRecord {
  id: string;
  userId: string;
  status: ExportRequestStatus;
  format: 'json';
  includeAssets: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown> | null;
  };
}

function sendError(
  res: { status: (code: number) => { json: (payload: ApiErrorPayload) => void } },
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: randomUUID(),
      details,
    },
  });
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(100, Math.max(1, Math.floor(value)));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(100, Math.max(1, parsed));
    }
  }
  return fallback;
}

function parseWindowDays(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(90, Math.max(1, Math.floor(value)));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(90, Math.max(1, parsed));
    }
  }
  return fallback;
}

export function summarizeAuditEventsByType(auditEvents: AuditEventRecord[]): Record<string, number> {
  return auditEvents.reduce<Record<string, number>>((acc, event) => {
    acc[event.eventType] = (acc[event.eventType] ?? 0) + 1;
    return acc;
  }, {});
}

export function createComplianceV1Router(dataAdapter: DataAdapter): Router {
  const router = Router();

  router.post('/exports', async (req, res, next) => {
    try {
      if (!featureConfig.complianceExportsEnabled) {
        sendError(res, 404, 'FEATURE_DISABLED', 'Compliance exports API is disabled');
        return;
      }

      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }

      const format = req.body?.format;
      if (format !== undefined && format !== 'json') {
        sendError(res, 400, 'INVALID_BODY', 'format must be "json"');
        return;
      }

      const exportRequestId = randomUUID();
      const now = new Date().toISOString();
      const includeAssets = toBoolean(req.body?.includeAssets, false);

      const exportRequest: ExportRequestRecord = {
        id: exportRequestId,
        userId: req.user.uid,
        status: 'pending',
        format: 'json',
        includeAssets,
        createdAt: now,
        updatedAt: now,
      };

      await dataAdapter.storeData<ExportRequestRecord>('complianceExportRequests', exportRequestId, exportRequest);

      await recordAuditEvent(dataAdapter, {
        eventType: 'compliance.export.requested',
        actorId: req.user.uid,
        targetId: exportRequestId,
        createdAt: now,
        metadata: {
          format: exportRequest.format,
          includeAssets: exportRequest.includeAssets,
        },
      });

      res.status(201).json({ exportRequest });
    } catch (error) {
      next(error);
    }
  });

  router.get('/exports/:id', async (req, res, next) => {
    try {
      if (!featureConfig.complianceExportsEnabled) {
        sendError(res, 404, 'FEATURE_DISABLED', 'Compliance exports API is disabled');
        return;
      }

      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }

      const exportRequest = await dataAdapter.fetchData<ExportRequestRecord>(
        'complianceExportRequests',
        req.params.id
      );

      if (!exportRequest || exportRequest.userId !== req.user.uid) {
        sendError(res, 404, 'NOT_FOUND', 'Export request not found');
        return;
      }

      res.json({ exportRequest });
    } catch (error) {
      next(error);
    }
  });

  router.get('/audit-events', async (req, res, next) => {
    try {
      if (!featureConfig.complianceExportsEnabled) {
        sendError(res, 404, 'FEATURE_DISABLED', 'Compliance exports API is disabled');
        return;
      }

      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }

      const limit = parseLimit(req.query.limit, 25);

      const auditEvents = await dataAdapter.queryData<AuditEventRecord>('auditEvents', [
        { field: 'actorId', operator: '==', value: req.user.uid },
      ]);

      const sortedEvents = auditEvents
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);

      res.json({
        auditEvents: sortedEvents,
        total: sortedEvents.length,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/audit-events/summary', async (req, res, next) => {
    try {
      if (!featureConfig.complianceExportsEnabled) {
        sendError(res, 404, 'FEATURE_DISABLED', 'Compliance exports API is disabled');
        return;
      }

      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }

      const windowDays = parseWindowDays(req.query.windowDays, 7);
      const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

      const auditEvents = await dataAdapter.queryData<AuditEventRecord>('auditEvents', [
        { field: 'actorId', operator: '==', value: req.user.uid },
        { field: 'createdAt', operator: '>=', value: windowStart },
      ]);

      const byEventType = summarizeAuditEventsByType(auditEvents);
      const uniqueEventTypes = Object.keys(byEventType).length;

      res.json({
        windowDays,
        windowStart,
        total: auditEvents.length,
        uniqueEventTypes,
        byEventType,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
