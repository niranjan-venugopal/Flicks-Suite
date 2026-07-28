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
  /**
   * GitHub integration (P16): install/repo mapping, branch→PR→merge
   * automations, git chips on issues, the ⌘⇧B branch action.
   *
   * Parked while the connection model moves from a GitHub *App* installation
   * to per-user OAuth — the App flow authorises an org-wide installation,
   * whereas OAuth ties the link to the signed-in user's own GitHub account.
   * Everything underneath (service, webhook pipeline, RS256 App JWT, fixture
   * test-suite) is untouched; flip to `true` to restore it as-is.
   */
  pm_github: false,
} as const
