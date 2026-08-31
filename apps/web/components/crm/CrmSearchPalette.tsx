'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Building2, Users, Kanban, CornerDownLeft } from 'lucide-react'
import { useGlobalSearch } from '@/lib/api/queries/use-crm'

/**
 * CRM global search palette (PRD v5 §19.8). ⌘K / Ctrl-K opens it anywhere in the
 * CRM area; typing ≥2 chars searches companies, people and deals; Enter or click
 * navigates. Debounced so we don't hammer the API on every keystroke.
 */
export function CrmSearchPalette() {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [q, setQ] = useState('')
  const router = useRouter()

  // ⌘K / Ctrl-K toggles; "/" opens (prototype keymap §19.8); Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      const t = e.target as HTMLElement
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
      if (e.key === '/' && !typing) {
        e.preventDefault()
        setOpen(true)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Debounce the query fed to the API.
  useEffect(() => {
    const id = setTimeout(() => setQ(raw), 180)
    return () => clearTimeout(id)
  }, [raw])

  const { data, isFetching } = useGlobalSearch(open ? q : '')
  const r = data?.data
  const total = (r?.companies.length ?? 0) + (r?.people.length ?? 0) + (r?.deals.length ?? 0)

  const go = (href: string) => {
    setOpen(false)
    setRaw('')
    setQ('')
    router.push(href)
  }

  // First result → Enter target.
  const firstHref = useMemo(() => {
    if (!r) return null
    if (r.companies[0]) return `/crm/companies?focus=${r.companies[0].id}`
    if (r.people[0]) return `/crm/contacts?focus=${r.people[0].id}`
    if (r.deals[0]) return `/crm/deals/${r.deals[0].id}`
    return null
  }, [r])

  if (!open) return null

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, display: 'flex', justifyContent: 'center',
        alignItems: 'flex-start', paddingTop: '12vh', background: 'rgba(1,1,13,.6)', backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card modal-card"
        style={{ width: 'min(620px, 92vw)', padding: 0, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,.5)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--bord)' }}>
          <Search size={16} style={{ color: 'var(--text-mute)' }} />
          <input
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && firstHref) go(firstHref) }}
            placeholder="Search contacts, companies, deals…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-1)', fontSize: 15 }}
          />
          <kbd style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)', border: '1px solid var(--bord)', borderRadius: 5, padding: '2px 6px' }}>ESC</kbd>
        </div>

        <div style={{ maxHeight: '52vh', overflowY: 'auto', padding: 6 }}>
          {q.trim().length < 2 && (
            <div className="t-mute" style={{ padding: 22, textAlign: 'center', fontSize: 13 }}>Type at least 2 characters to search.</div>
          )}
          {q.trim().length >= 2 && total === 0 && !isFetching && (
            <div className="t-mute" style={{ padding: 22, textAlign: 'center', fontSize: 13 }}>No matches for “{q}”.</div>
          )}
          {r && (
            <>
              <Group label="Companies" icon={<Building2 size={14} />} items={r.companies.map((c) => ({ id: c.id, primary: c.name, secondary: c.domain ?? undefined, href: `/crm/companies?focus=${c.id}` }))} onPick={go} />
              <Group label="Contacts" icon={<Users size={14} />} items={r.people.map((p) => ({ id: p.id, primary: p.display_name ?? p.email ?? 'Unnamed', secondary: p.email ?? undefined, href: `/crm/contacts?focus=${p.id}` }))} onPick={go} />
              <Group label="Deals" icon={<Kanban size={14} />} items={r.deals.map((d) => ({ id: d.id, primary: d.title, secondary: d.status, href: `/crm/deals/${d.id}` }))} onPick={go} />
            </>
          )}
        </div>

        {firstHref && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderTop: '1px solid var(--bord)', fontSize: 11 }} className="t-mute">
            <CornerDownLeft size={12} /> Enter to open the top result
          </div>
        )}
      </div>
    </div>
  )
}

function Group({
  label, icon, items, onPick,
}: {
  label: string
  icon: React.ReactNode
  items: Array<{ id: string; primary: string; secondary?: string; href: string }>
  onPick: (href: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div style={{ marginBottom: 4 }}>
      <div className="t-caption" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px 4px', color: 'var(--text-mute)' }}>
        {icon} {label}
      </div>
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onPick(it.href)}
          style={{
            width: '100%', textAlign: 'left', display: 'flex', alignItems: 'baseline', gap: 8,
            padding: '9px 12px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surf-2)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{it.primary}</span>
          {it.secondary && <span className="t-mute" style={{ fontSize: 12 }}>{it.secondary}</span>}
        </button>
      ))}
    </div>
  )
}
