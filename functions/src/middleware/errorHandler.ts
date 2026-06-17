import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export class AppError extends Error {
  public details?: Record<string, unknown>;

  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    detailsOrIsOperational?: Record<string, unknown> | boolean,
    public isOperational = true
  ) {
    super(message);
    this.name = code;
    if (typeof detailsOrIsOperational === 'object' && detailsOrIsOperational !== null) {
      this.details = detailsOrIsOperational;
    } else if (typeof detailsOrIsOperational === 'boolean') {
      this.isOperational = detailsOrIsOperational;
    }
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  if (err instanceof AppError) {
    logger.warn({ err, path: req.path }, 'Application error');
    const body: Record<string, unknown> = {
      error: err.message,
      code: err.code,
      statusCode: err.statusCode,
    };
    if (err.details) {
      body.details = err.details;
    }
    res.status(err.statusCode).json(body);
    return;
  }

  // Unexpected errors
  logger.error({ err, path: req.path }, 'Unexpected error');
  res.status(500).json({
    error: 'Internal server error',
    statusCode: 500,
  });
}

export function notFoundHandler(
  req: Request,
  res: Response
): void {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
}