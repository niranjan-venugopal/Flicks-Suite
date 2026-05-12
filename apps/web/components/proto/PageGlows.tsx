'use client'

/**
 * Decorative ambient glow blobs behind page content.
 * Ported from prototype `_components.jsx`.
 */
export function PageGlows() {
  return (
    <>
      <div className="glow glow-blue" style={{ top: -150, left: -100, width: 500, height: 500 }} />
      <div
        className="glow glow-coral"
        style={{ bottom: -200, right: -100, width: 500, height: 500 }}
      />
      <div
        className="glow glow-yellow"
        style={{ top: '40%', right: '30%', width: 300, height: 300 }}
      />
    </>
  )
}
