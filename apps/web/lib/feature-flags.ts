/**
 * Product-level feature flags. These gate finished-but-parked surfaces behind
 * a "Coming soon" state while the product direction is decided — the code,
 * APIs and tests underneath stay intact, so flipping a flag to `true`
 * restores the full feature instantly.
 */
export const FEATURES = {
  /** Email suite: sequences, templates/signature settings, deal Emails tab. */
  crm_email: false,
  /** Automation: workflow builder, starters, run history. */
  crm_automation: false,
} as const
