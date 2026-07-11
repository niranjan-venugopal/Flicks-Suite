// App-Router transition fallback for every (app) route. The shell (sidebar,
// topbar) stays mounted across navigations, so this only silhouettes the
// content pane — it paints instantly while the target route's JS/data load,
// instead of leaving the previous page frozen.
export default function AppRouteLoading() {
  return (
    <div style={{ flex: 1, padding: '32px 48px' }}>
      <div
        style={{
          width: 220,
          height: 26,
          borderRadius: 8,
          background: 'var(--surf-2)',
          marginBottom: 10,
        }}
      />
      <div
        style={{
          width: 340,
          height: 14,
          borderRadius: 6,
          background: 'var(--surf-1)',
          marginBottom: 28,
        }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: 84,
              borderRadius: 12,
              background: 'var(--surf-1)',
              border: '1px solid var(--bord)',
            }}
          />
        ))}
      </div>
      <div
        style={{
          height: 320,
          borderRadius: 12,
          background: 'var(--surf-1)',
          border: '1px solid var(--bord)',
        }}
      />
    </div>
  )
}
