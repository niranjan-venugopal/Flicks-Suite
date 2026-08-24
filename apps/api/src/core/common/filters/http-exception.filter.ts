import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path: string;
  requestId?: string;
  /** Machine-readable code some errors carry (e.g. BILLING_REQUIRED). */
  code?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  // During an infra outage (e.g. the DB unreachable) every request used to
  // emit full stack traces, tripping Railway's 500 logs/sec cap and DROPPING
  // messages (2026-08-24 incident) — the one line that matters gets lost in
  // the flood. Log a given error signature's stack at most once per window;
  // repeats within the window get a single stackless line.
  private static readonly SUPPRESS_WINDOW_MS = 30_000;
  private static readonly MAX_TRACKED_SIGNATURES = 200;
  private readonly errorLogWindow = new Map<
    string,
    { count: number; windowStart: number }
  >();

  private logWithStackOncePerWindow(
    signature: string,
    headline: string,
    stack?: string,
  ): void {
    const now = Date.now();
    if (this.errorLogWindow.size > HttpExceptionFilter.MAX_TRACKED_SIGNATURES) {
      this.errorLogWindow.clear(); // bounded memory; worst case = one extra stack
    }
    const entry = this.errorLogWindow.get(signature);
    if (
      !entry ||
      now - entry.windowStart > HttpExceptionFilter.SUPPRESS_WINDOW_MS
    ) {
      this.errorLogWindow.set(signature, { count: 1, windowStart: now });
      this.logger.error(headline, stack);
      return;
    }
    entry.count += 1;
    this.logger.error(
      `${headline} (repeat ×${entry.count} in 30s — stack suppressed)`,
    );
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'InternalServerError';
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = exception.name;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const resp = exceptionResponse as {
          message?: string | string[];
          error?: string;
          code?: string;
        };
        message = resp.message ?? exception.message;
        error = resp.error ?? exception.name;
        if (resp.code) code = resp.code;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name;

      // Log unexpected errors (stack at most once per 30s per signature)
      this.logWithStackOncePerWindow(
        `${error}:${exception.message}`,
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      error,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(code ? { code } : {}),
    };

    // Log 5xx errors with request context. The stack for a non-Http Error
    // was already handled (suppressed-per-window) above — repeating it here
    // doubled every outage's log volume, so this line stays stackless for
    // that case and only carries a stack for HttpException-derived 500s.
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${status} - ${message}`,
        exception instanceof HttpException ? exception.stack : undefined,
      );
    }

    response.status(status).json(errorResponse);
  }
}
