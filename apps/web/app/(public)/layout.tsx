/**
 * Public route group — chrome-less (no app sidebar/topbar). Used for the hosted
 * invoice/quote pages a tenant's customers see on the branded subdomain
 * (PRD §9.3). The root layout already provides <html>/<body> + providers, so
 * this layout only constrains the public surface.
 *
 * Round O: customer-facing pages are pinned to the dark token set regardless
 * of the signed-in user's theme — the wrapper's data-theme re-scopes every
 * CSS token for the subtree (and the pre-paint script forces <html> dark on
 * these routes too). The hosted invoice / mandate / form pages keep their own
 * customer-facing light/dark toggles: those paint literal palettes
 * (components/invoicing/invo.tsx) and are untouched by the app theme.
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div
      data-theme="dark"
      className="min-h-screen"
      style={{ background: 'var(--bg)', color: 'var(--text)' }}
    >
      {children}
    </div>
  )
}
