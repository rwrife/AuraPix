import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errorHandler.js';

const API_VERSION_HEADER = 'X-API-Version';
const SUPPORTED_MAJOR_VERSION = 1;

function parseMajorVersion(raw: string): number {
  const normalized = raw.trim();

  // Accept "1", "1.0", or semver-ish "1.2.3".
  const match = normalized.match(/^(\d+)(?:\.\d+){0,2}$/);
  if (!match) {
    throw new AppError(
      400,
      'INVALID_API_VERSION',
      `Invalid ${API_VERSION_HEADER} format. Expected "${SUPPORTED_MAJOR_VERSION}" or "${SUPPORTED_MAJOR_VERSION}.x"`
    );
  }

  return Number(match[1]);
}

/**
 * Compatibility/version policy baseline for multi-client API usage.
 *
 * - No header => treat as current stable major version.
 * - Header present => enforce supported major version.
 * - Always emit the negotiated/stable version on responses.
 */
export function apiVersionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestedVersion = req.header(API_VERSION_HEADER);

  if (requestedVersion) {
    const major = parseMajorVersion(requestedVersion);
    if (major !== SUPPORTED_MAJOR_VERSION) {
      throw new AppError(
        400,
        'UNSUPPORTED_API_VERSION',
        `Unsupported ${API_VERSION_HEADER} "${requestedVersion}". Supported major version: ${SUPPORTED_MAJOR_VERSION}`
      );
    }
  }

  res.setHeader(API_VERSION_HEADER, `${SUPPORTED_MAJOR_VERSION}`);
  res.setHeader('Vary', API_VERSION_HEADER);

  next();
}
