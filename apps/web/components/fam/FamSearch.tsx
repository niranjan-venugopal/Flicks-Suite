'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Avatar, Icon, Pill } from '@/components/proto'
import { useFamSearch } from '@/lib/api/queries/use-fam'

/**
 * Round R R2 — "find anyone": the FAM topbar search. Type two characters and
 * people (email / name) and companies (name / slug / GSTIN) drop down
 * underneath; ⌘K / Ctrl-K focuses it, Esc closes, Enter opens the first hit.
 */
export function FamSearch() {
  const router = useRouter()
  const [raw, setRaw] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setTimeout(() => setQ(raw), 180)
    return () => clearTimeout(id)
  }, [raw])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      } else if (e.key === 'Escape') {
        setOpen(false)
        inputRef.current?.blur()
      }
    }
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [])

  const { data, isFetching } = useFamSearch(open ? q : '')
  const users = data?.users ?? []
  const tenants = data?.tenants ?? []
  const ready = q.trim().length >= 2
  const firstHref = users[0] ? `/fam/users/${users[0].id}` : tenants[0] ? `/fam/tenants/${tenants[0].id}` : null

  const go = (href: string) => {
    setOpen(false)
    setRaw('')
    setQ('')
    router.push(href)
  }

  return (
    <div ref={boxRef} style={{ position: 'relative', width: 320 }} data-testid="fam-search">
      <Icon.search
        size={15}
        style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)', pointerEvents: 'none' }}
      />
      <input
        ref={inputRef}
        className="input with-icon"
        placeholder="Find a person or company…"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && firstHref) go(firstHref)
        }}
        style={{ height: 36, fontSize: 12.5, paddingLeft: 35, width: '100%' }}
        aria-label="Find a person or company"
        data-testid="fam-search-input"
      />
      <div
        style={{
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', padding: '2px 6px',
          background: 'var(--surf-2)', border: '1px solid var(--bord)', borderRadius: 5, fontSize: 10,
          fontWeight: 700, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)', pointerEvents: 'none',
        }}
      >
        ⌘K
      </div>

      {open && raw.trim().length > 0 && (
        <div
          className="card"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 90, padding: 6,
            maxHeight: '60vh', overflowY: 'auto', boxShadow: '0 12px 32px rgba(0,0,0,.18)',
          }}
          data-testid="fam-search-results"
        >
          {!ready && (
            <div className="t-mute" style={{ padding: 14, fontSize: 12.5, textAlign: 'center' }}>Type at least 2 characters.</div>
          )}
          {ready && !isFetching && users.length === 0 && tenants.length === 0 && (
            <div className="t-mute" style={{ padding: 14, fontSize: 12.5, textAlign: 'center' }}>No person or company matches “{q}”.</div>
          )}
          {users.length > 0 && (
            <Group label="People" icon={<Icon.user size={13} />}>
              {users.map((u) => (
                <Row
                  key={u.id}
                  onClick={() => go(`/fam/users/${u.id}`)}
                  avatar={<Avatar name={u.fullName ?? u.email} size="sm" src={u.avatarUrl ?? undefined} />}
                  primary={u.fullName ?? u.email}
                  secondary={`${u.email} · ${u.companies} ${u.companies === 1 ? 'company' : 'companies'}`}
                  right={u.isPlatformAdmin ? <Pill tone="purple">platform</Pill> : u.status !== 'active' ? <Pill tone="coral">{u.status}</Pill> : null}
                />
              ))}
            </Group>
          )}
          {tenants.length > 0 && (
            <Group label="Companies" icon={<Icon.building size={13} />}>
              {tenants.map((t) => (
                <Row
                  key={t.id}
                  onClick={() => go(`/fam/tenants/${t.id}`)}
                  avatar={<Avatar name={t.name} size="sm" src={t.logoUrl ?? undefined} />}
                  primary={t.name}
                  secondary={`${t.slug}${t.gstin ? ` · ${t.gstin}` : ''} · ${t.members} active`}
                  right={<Pill tone={t.status === 'suspended' ? 'coral' : t.status === 'active' ? 'green' : 'blue'} dot>{t.status.replace('_', ' ')}</Pill>}
                />
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  )
}

function Group({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div className="t-caption" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 4px', color: 'var(--text-mute)' }}>
        {icon} {label}
      </div>
      {children}
    </div>
  )
}

function Row({
  onClick, avatar, primary, secondary, right,
}: {
  onClick: () => void
  avatar: React.ReactNode
  primary: string
  secondary: string
  right?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surf-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {avatar}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{primary}</span>
        <span className="t-mute" style={{ display: 'block', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{secondary}</span>
      </span>
      {right}
    </button>
  )
}
