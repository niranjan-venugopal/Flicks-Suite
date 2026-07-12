'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Plus, Search, Loader2, Users } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { APIError } from '@/lib/api/client'
import { useContacts, useCreateContact, useCompanies } from '@/lib/api/queries/use-crm'

export default function ContactsPage() {
  const [q, setQ] = useState('')
  const [modal, setModal] = useState(false)
  const { data, isLoading } = useContacts({ q: q || undefined })
  const rows = data?.data ?? []

  return (
    <div style={{ padding: '28px 32px 64px' }}>
      <SectionHead
        title="Contacts"
        sub={data ? `${data.pagination.total} ${data.pagination.total === 1 ? 'contact' : 'contacts'}` : 'People in your directory'}
        right={<Btn kind="primary" size="sm" icon={<Plus size={14} />} onClick={() => setModal(true)}>New contact</Btn>}
      />

      <div style={{ position: 'relative', maxWidth: 320, marginTop: 16 }}>
        <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }} />
        <input className="input" placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', paddingLeft: 34 }} />
      </div>

      <div className="card" style={{ marginTop: 18, padding: 0, overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
            <Loader2 className="animate-spin" style={{ color: 'var(--text-mute)' }} />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '48px 20px', textAlign: 'center' }}>
            <Users size={28} style={{ color: 'var(--text-mute)', marginBottom: 10 }} />
            <div className="t-h3" style={{ marginBottom: 4 }}>No contacts yet</div>
            <p className="t-mute" style={{ fontSize: 13, marginBottom: 14 }}>Add your first contact to build your directory.</p>
            <Btn kind="primary" size="sm" icon={<Plus size={14} />} onClick={() => setModal(true)}>New contact</Btn>
          </div>
        ) : (
          <table className="tbl" style={{ width: '100%' }}>
            <thead><tr><th>Name</th><th>Email</th><th>Title</th><th>Phone</th><th>Source</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/crm/contacts/${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
                      <RowPresenceAvatar name={p.display_name ?? p.email ?? 'Contact'} userId={p.owner_user_id} size={26} />
                      <b>{p.display_name ?? '—'}</b>
                    </Link>
                  </td>
                  <td>{p.email ?? '—'}</td>
                  <td>{p.title ?? '—'}</td>
                  <td>{p.phone ?? '—'}</td>
                  <td>{p.source ? <Pill>{p.source.replace(/_/g, ' ')}</Pill> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <NewContactModal open={modal} onClose={() => setModal(false)} />
    </div>
  )
}

function NewContactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast()
  const create = useCreateContact()
  const { data: companies } = useCompanies()
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [companyId, setCompanyId] = useState('')

  const reset = () => { setFirst(''); setLast(''); setEmail(''); setTitle(''); setCompanyId('') }

  const submit = async () => {
    try {
      await create.mutateAsync({
        first_name: first || undefined,
        last_name: last || undefined,
        email: email || undefined,
        title: title || undefined,
        company_id: companyId || undefined,
      })
      toast({ title: 'Contact created' })
      reset(); onClose()
    } catch (err) {
      if (err instanceof APIError && (err.data as { code?: string })?.code === 'DUPLICATE_EMAIL') {
        const existing = (err.data as { existing?: { display_name: string } }).existing
        toast({ title: 'Duplicate email', description: `Already exists as "${existing?.display_name}".`, variant: 'destructive' })
      } else {
        toast({ title: 'Could not create contact', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
      }
    }
  }

  const canSubmit = (first.trim() || last.trim() || email.trim()) && !create.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => !v && (reset(), onClose())}>
      <DialogContent>
        <DialogHeader><DialogTitle>New contact</DialogTitle></DialogHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div className="label">First name</div>
              <input className="input" value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Asha" style={{ width: '100%' }} autoFocus />
            </div>
            <div style={{ flex: 1 }}>
              <div className="label">Last name</div>
              <input className="input" value={last} onChange={(e) => setLast(e.target.value)} placeholder="Rao" style={{ width: '100%' }} />
            </div>
          </div>
          <div>
            <div className="label">Email</div>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="asha@techcorp.com" style={{ width: '100%' }} />
          </div>
          <div>
            <div className="label">Title</div>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Head of Sales" style={{ width: '100%' }} />
          </div>
          <div>
            <div className="label">Company</div>
            <select className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— none —</option>
              {(companies?.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={() => (reset(), onClose())}>Cancel</Btn>
          <Btn kind="primary" onClick={submit} disabled={!canSubmit}>{create.isPending ? 'Creating…' : 'Create contact'}</Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
