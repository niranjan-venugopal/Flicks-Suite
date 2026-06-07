/**
 * Public route group — chrome-less (no app sidebar/topbar). Used for the hosted
 * invoice/quote pages a tenant's customers see on the branded subdomain
 * (PRD §9.3). The root layout already provides <html>/<body> + providers, so
 * this layout only constrains the public surface.
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="min-h-screen">{children}</div>
}
