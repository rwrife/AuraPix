import { logger } from '../../utils/logger.js';

export interface UploadPolicyPayload {
  userId: string;
  libraryId: string;
  sizeBytes: number;
  mimeType: string;
  originalName: string;
}

export interface UploadPolicyDecision {
  allow: boolean;
  reason?: string;
}

interface UploadPolicyConfig {
  webhookUrl?: string;
  timeoutMs: number;
}

export async function evaluateUploadPolicy(
  payload: UploadPolicyPayload,
  config: UploadPolicyConfig
): Promise<UploadPolicyDecision> {
  if (!config.webhookUrl) {
    return { allow: true, reason: 'host-policy-disabled' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        {
          status: response.status,
          webhookUrl: config.webhookUrl,
        },
        'Host upload policy webhook returned non-2xx; allowing upload for compatibility'
      );
      return { allow: true, reason: 'host-policy-webhook-non-2xx' };
    }

    const data = (await response.json()) as Partial<UploadPolicyDecision>;
    if (typeof data.allow !== 'boolean') {
      logger.warn(
        { webhookUrl: config.webhookUrl, data },
        'Host upload policy webhook returned invalid payload; allowing upload for compatibility'
      );
      return { allow: true, reason: 'host-policy-webhook-invalid-payload' };
    }

    return {
      allow: data.allow,
      reason: data.reason,
    };
  } catch (error) {
    logger.warn(
      { err: error, webhookUrl: config.webhookUrl },
      'Host upload policy webhook unavailable; allowing upload for compatibility'
    );
    return { allow: true, reason: 'host-policy-webhook-unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
