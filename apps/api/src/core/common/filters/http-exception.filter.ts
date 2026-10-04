import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';

interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path: string;
  requestId?: string;
  /** Machine-readable code some errors carry (e.g. BILLING_REQUIRED). */
  code?: string;
  /**
   * Short reference for an unexpected 500 — the same id is printed in the
   * server log line, so support can find the stack from what the user sees.
   */
  errorId?: string;
}

/** Postgres SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Friendly copy for the unique constraints a user can realistically hit from
 * a form (Round P R1.2). Anything else gets the generic DUPLICATE message —
 * never the raw `duplicate key value violates unique constraint …` text.
 */
const DUPLICATE_MESSAGES: Record<string, string> = {
  employees_tenant_work_email_unique: 'An employee with this work email already exists',
  employees_tenant_code_unique: 'Employee code already in use',
};
const GENERIC_DUPLICATE_MESSAGE = 'A record with the same value already exists.';
const MASKED_SERVER_ERROR_MESSAGE = 'Something went wrong. Please try again.';

interface PgErrorLike {
  code?: string;
  /** node-postgres spelling. */
  constraint?: string;
  /** postgres.js spelling (what @flicks/db uses). */
  constraint_name?: string;
  cause?: unknown;
}

/**
 * Finds a Postgres unique violation on the thrown value or anywhere up its
 * `cause` chain (drizzle and our own wrappers re-throw with `cause`).
 */
function findUniqueViolation(exception: unknown): PgErrorLike | null {
  let current: unknown = exception;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const candidate = current as PgErrorLike;
    if (candidate.code === PG_UNIQUE_VIOLATION) return candidate;
    current = candidate.cause;
  }
  return null;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  /**
   * `nodeEnv` overrides the environment lookup (specs). Left unset, the
   * filter reads process.env.NODE_ENV at catch time — the same value
   * main.ts hands ConfigService — so `new HttpExceptionFilter()` keeps
   * working unchanged.
   */
  constructor(private readonly options: { nodeEnv?: string } = {}) {}

  private isProduction(): boolean {
    return (this.options.nodeEnv ?? process.env.NODE_ENV) === 'production';
  }

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
    let errorId: string | undefined;
    // What the server log line says — in production this keeps the raw
    // message while the response body carries the masked one.
    let logMessage: string | string[] = message;

    const uniqueViolation =
      exception instanceof HttpException ? null : findUniqueViolation(exception);

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
      logMessage = message;
    } else if (uniqueViolation) {
      // Round P R1.2: a unique violation that escaped a service's own
      // pre-check is a user-facing conflict, not a server fault. Map it to
      // 409 DUPLICATE with friendly copy keyed on the constraint name.
      const constraint =
        uniqueViolation.constraint ?? uniqueViolation.constraint_name;
      status = HttpStatus.CONFLICT;
      error = 'Conflict';
      code = 'DUPLICATE';
      message =
        (constraint && DUPLICATE_MESSAGES[constraint]) ||
        GENERIC_DUPLICATE_MESSAGE;
      logMessage = message;
      // One stackless line so the missing pre-check is findable.
      this.logger.warn(
        `Unique violation mapped to 409 DUPLICATE (${constraint ?? 'unknown constraint'}) on ${request.method} ${request.url}`,
      );
    } else if (exception instanceof Error) {
      // Short reference id shared by the log line and the response body.
      errorId = crypto.randomBytes(4).toString('hex');
      error = exception.name;
      logMessage = exception.message;

      // Log unexpected errors (stack at most once per 30s per signature)
      this.logWithStackOncePerWindow(
        `${error}:${exception.message}`,
        `Unhandled exception [ref ${errorId}]: ${exception.message}`,
        exception.stack,
      );

      if (this.isProduction()) {
        // Never leak internals (SQL text, hostnames, driver names) to a
        // customer; the ref id is enough to find the stack above.
        message = MASKED_SERVER_ERROR_MESSAGE;
        error = 'InternalServerError';
      } else {
        message = exception.message;
      }
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      error,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(code ? { code } : {}),
      ...(errorId ? { errorId } : {}),
    };

    // Log 5xx errors with request context. The stack for a non-Http Error
    // was already handled (suppressed-per-window) above — repeating it here
    // doubled every outage's log volume, so this line stays stackless for
    // that case and only carries a stack for HttpException-derived 500s.
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${status} - ${logMessage}${errorId ? ` [ref ${errorId}]` : ''}`,
        exception instanceof HttpException ? exception.stack : undefined,
      );
    }

    response.status(status).json(errorResponse);
  }
}
