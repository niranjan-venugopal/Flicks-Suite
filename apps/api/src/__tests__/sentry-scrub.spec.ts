import { redactPii } from '../sentry-scrub';

/**
 * PRD v4 §9 — beforeSend PII scrubbing. Email-shaped strings must never leave
 * the app in messages, exception values, or breadcrumbs; breadcrumb URLs must
 * lose their query strings (magic-link / unsubscribe tokens).
 */

describe('Sentry beforeSend scrubber (PRD v4 §9)', () => {
  it('redacts emails from message and exception values', () => {
    const event = redactPii({
      message: 'login failed for priya@demo.co, retrying',
      exception: {
        values: [{ value: 'User niranjan@demo.co not found' }, { value: 'plain error' }],
      },
    });
    expect(event.message).toBe('login failed for [redacted-email], retrying');
    const values = (event.exception as { values: Array<{ value: string }> }).values;
    expect(values[0]!.value).toBe('User [redacted-email] not found');
    expect(values[1]!.value).toBe('plain error');
  });

  it('redacts breadcrumb messages and strips query strings from breadcrumb URLs', () => {
    const event = redactPii({
      breadcrumbs: [
        {
          message: 'fetch ok for sarah@demo.co',
          data: {
            url: 'https://app.test/unsubscribe?token=SECRET',
            method: 'GET',
            note: 'sent to alice@demo.co',
          },
        },
      ],
    });
    const crumb = (event.breadcrumbs as Array<{ message: string; data: Record<string, string> }>)[0]!;
    expect(crumb.message).toBe('fetch ok for [redacted-email]');
    expect(crumb.data.url).toBe('https://app.test/unsubscribe');
    expect(crumb.data.note).toBe('sent to [redacted-email]');
    expect(crumb.data.method).toBe('GET');
  });

  it('leaves events without strings untouched', () => {
    const event = redactPii({ level: 'error', extra: undefined });
    expect(event.level).toBe('error');
  });
});
