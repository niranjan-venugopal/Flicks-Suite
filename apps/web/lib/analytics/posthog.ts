'use client'

import posthog from 'posthog-js'

// Critical-path events (PRD §12.3 "events firing for all critical user
// actions"). Centralised so names stay consistent and typo-free across
// the app — call track('...') with one of these keys only.
export const EVENTS = {
  TENANT_SIGNUP_COMPLETED: 'tenant_signup_completed',
  EMPLOYEE_ONBOARDING_SUBMITTED: 'employee_onboarding_submitted',
  ATTENDANCE_CLOCKED_IN: 'attendance_clocked_in',
  ATTENDANCE_CLOCKED_OUT: 'attendance_clocked_out',
  LEAVE_SUBMITTED: 'leave_submitted',
  LEAVE_REVIEWED: 'leave_reviewed',
  TIMESHEET_SUBMITTED: 'timesheet_submitted',
  TIMESHEET_REVIEWED: 'timesheet_reviewed',
  EMPLOYEE_INVITED: 'employee_invited',
  IMPERSONATION_STARTED: 'impersonation_started',
} as const

export type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS]

let initialised = false

export function isPostHogEnabled(): boolean {
  return typeof window !== 'undefined' && !!process.env.NEXT_PUBLIC_POSTHOG_KEY
}

/** Initialise posthog-js exactly once. No-op without a key. */
export function initPostHog(): void {
  if (initialised || !isPostHogEnabled()) return
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://app.posthog.com',
    // We capture pageviews + key events manually so SPA navigations and
    // server actions are attributed correctly.
    capture_pageview: false,
    capture_pageleave: true,
    person_profiles: 'identified_only',
    autocapture: false,
  })
  initialised = true
}

/** Fire a typed critical-path event. No-op without a key. */
export function track(event: AnalyticsEvent, props?: Record<string, unknown>): void {
  if (!isPostHogEnabled()) return
  posthog.capture(event, props)
}

/** Associate subsequent events with a user + tenant. */
export function identify(
  userId: string,
  traits: { email?: string; role?: string; tenantId?: string },
): void {
  if (!isPostHogEnabled()) return
  posthog.identify(userId, traits)
  if (traits.tenantId) {
    posthog.group('tenant', traits.tenantId)
  }
}

export function resetAnalytics(): void {
  if (!isPostHogEnabled()) return
  posthog.reset()
}

export function capturePageview(url: string): void {
  if (!isPostHogEnabled()) return
  posthog.capture('$pageview', { $current_url: url })
}
