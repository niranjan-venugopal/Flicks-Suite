/**
 * Log-flood guard (2026-08-24 incident): with the DB unreachable, every
 * failed request logged TWO full stack traces and Railway's 500 logs/sec cap
 * started dropping messages. The exception filter now logs a given error
 * signature's stack at most once per 30s window (repeats get one stackless
 * line), and the request-context 5xx line no longer duplicates the stack of
 * plain Errors.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../core/common/filters/http-exception.filter';

function hostFor(url: string): ArgumentsHost {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const request = { url, method: 'GET', headers: {} };
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
}

describe('HttpExceptionFilter log suppression', () => {
  it('logs the stack once per window, then stackless repeat lines', () => {
    const filter = new HttpExceptionFilter();
    const calls: Array<[string, string?]> = [];
    (filter as unknown as { logger: { error: (m: string, s?: string) => void } }).logger = {
      error: (m: string, s?: string) => calls.push([m, s]),
    };

    const boom = () =>
      filter.catch(new Error('write CONNECT_TIMEOUT pooler:5432'), hostFor('/api/v1/x'));

    boom();
    boom();
    boom();

    const unhandled = calls.filter(([m]) => m.startsWith('Unhandled exception'));
    expect(unhandled).toHaveLength(3);
    // First occurrence carries the stack…
    expect(unhandled[0]![1]).toBeTruthy();
    // …repeats within the window do not, and say so.
    expect(unhandled[1]![1]).toBeUndefined();
    expect(unhandled[1]![0]).toMatch(/stack suppressed/);
    expect(unhandled[2]![0]).toMatch(/×3/);

    // The request-context 500 line never re-logs a plain Error's stack.
    const requestLines = calls.filter(([m]) => m.includes('GET /api/v1/x 500'));
    expect(requestLines).toHaveLength(3);
    expect(requestLines.every(([, s]) => s === undefined)).toBe(true);
  });

  it('different signatures each get their own stack; HttpExceptions are untouched', () => {
    const filter = new HttpExceptionFilter();
    const calls: Array<[string, string?]> = [];
    (filter as unknown as { logger: { error: (m: string, s?: string) => void } }).logger = {
      error: (m: string, s?: string) => calls.push([m, s]),
    };

    filter.catch(new Error('first failure'), hostFor('/a'));
    filter.catch(new Error('second failure'), hostFor('/b'));
    const withStacks = calls.filter(([m, s]) => m.startsWith('Unhandled') && s);
    expect(withStacks).toHaveLength(2);

    // A 4xx HttpException logs nothing at error level at all.
    calls.length = 0;
    filter.catch(new HttpException('nope', HttpStatus.BAD_REQUEST), hostFor('/c'));
    expect(calls).toHaveLength(0);
  });
});
