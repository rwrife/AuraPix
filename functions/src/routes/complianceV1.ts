import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { featureConfig } from '../config/index.js';

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

      await dataAdapter.storeData('auditEvents', randomUUID(), {
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

  return router;
}
