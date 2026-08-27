'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Plus, Loader2, Trash2 } from 'lucide-react'
import { Btn, Pill, SectionHead, Avatar, Icon } from '@/components/proto'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { APIError } from '@/lib/api/client'
import { FilterBar, BulkBar, EmptyState } from '@/components/crm/kit'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useCompanies, useCreateCompany, useDeleteCompany, type DirectoryCompany } from '@/lib/api/queries/use-crm'

export default function CompaniesPage() {
  const [q, setQ] = useState('')
  const [modal, setModal] = useState(false)
  const [sel, setSel] = useState<string[]>([])
  const [deleting, setDeleting] = useState<DirectoryCompany | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const { data, isLoading } = useCompanies(q || undefined)
  const del = useDeleteCompany()
  const rows = data?.data ?? []

  const bulkDelete = async () => {
    setBulkBusy(true)
    for (const id of sel) { try { await del.mutateAsync(id) } catch { /* server enforces */ } }
    setBulkBusy(false)
    setSel([])
    setBulkOpen(false)
  }

  return (
    <div style={{ padding: '28px 32px 64px' }}>
      <SectionHead
        title="Companies"
        sub={data ? `${data.pagination.total} ${data.pagination.total === 1 ? 'company' : 'companies'}` : 'Organisations in your directory'}
        right={<Btn kind="primary" size="sm" icon={<Plus size={14} />} onClick={() => setModal(true)}>New company</Btn>}
      />

      <FilterBar search={q} onSearch={setQ} searchPlaceholder="Search companies…" />

      <div className="card" style={{ marginTop: 4, padding: 0, overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
            <Loader2 className="animate-spin" style={{ color: 'var(--text-mute)' }} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Icon.building size={22} />} line="No companies yet. Add your first company to start tracking accounts — deals and billing link straight to it." cta="New company" onCta={() => setModal(true)} />
        ) : (
          <table className="tbl" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: 34 }} /><th>Company</th><th>Domain</th><th>Industry</th><th>Location</th><th>Source</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} style={{ background: sel.includes(c.id) ? 'rgba(62,123,250,.08)' : undefined }}>
                  <td>
                    <input type="checkbox" checked={sel.includes(c.id)} onChange={() => setSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))} />
                  </td>
                  <td>
                    <Link href={`/crm/companies/${c.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
                      <Avatar name={c.name} size="sm" />
                      <b>{c.name}</b>
                    </Link>
                  </td>
                  <td>{c.domain ?? '—'}</td>
                  <td>{c.industry ?? '—'}</td>
                  <td>{[c.city, c.country_code].filter(Boolean).join(', ') || '—'}</td>
                  <td>{c.source ? <Pill>{c.source.replace(/_/g, ' ')}</Pill> : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Btn kind="ghost" size="sm" icon={<Icon.trash size={13} />} title="Delete — Manager and above"
                      disabled={del.isPending} onClick={() => setDeleting(c)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <BulkBar count={sel.length} onClear={() => setSel([])} actions={[
        { icon: <Trash2 size={13} />, label: 'Delete', danger: true, onClick: () => setBulkOpen(true) },
      ]} />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete company"
        danger
        body={deleting ? `Delete ${deleting.name}? Its contacts, deals and history are kept — and the domain is freed for a fresh record.` : null}
        confirmLabel="Delete company"
        loading={del.isPending && !bulkBusy}
        loadingLabel="Deleting…"
        onConfirm={() => deleting && del.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
      />
      <ConfirmDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Delete companies"
        danger
        body={`Delete ${sel.length} compan${sel.length === 1 ? 'y' : 'ies'}?`}
        confirmLabel={`Delete ${sel.length}`}
        loading={bulkBusy}
        loadingLabel="Deleting…"
        onConfirm={() => void bulkDelete()}
      />

      <NewCompanyModal open={modal} onClose={() => setModal(false)} />
    </div>
  )
}

function NewCompanyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast()
  const create = useCreateCompany()
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [industry, setIndustry] = useState('')
  const [forceCreate, setForceCreate] = useState(false)
  const [warnings, setWarnings] = useState<Array<{ candidate: { name: string } }>>([])

  const reset = () => { setName(''); setDomain(''); setIndustry(''); setForceCreate(false); setWarnings([]) }

  const submit = async () => {
    try {
      const res = await create.mutateAsync({ name, domain: domain || undefined, industry: industry || undefined, force_create: forceCreate })
      const w = (res.meta?.warnings ?? []) as Array<{ candidate: { name: string } }>
      if (w.length && !forceCreate) {
        // Created, but surface the similar-name warning so the user can react.
        setWarnings(w)
        toast({ title: 'Company created', description: `Heads up: similar to "${w[0].candidate.name}".` })
      } else {
        toast({ title: 'Company created' })
      }
      reset(); onClose()
    } catch (err) {
      if (err instanceof APIError && (err.data as { code?: string })?.code === 'DUPLICATE_DOMAIN') {
        const existing = (err.data as { existing?: { name: string } }).existing
        toast({ title: 'Duplicate domain', description: `Already exists as "${existing?.name}".`, variant: 'destructive' })
      } else {
        toast({ title: 'Could not create company', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && (reset(), onClose())}>
      <DialogContent>
        <DialogHeader><DialogTitle>New company</DialogTitle></DialogHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
          <div>
            <div className="label">Name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" style={{ width: '100%' }} autoFocus />
          </div>
          <div>
            <div className="label">Domain</div>
            <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" style={{ width: '100%' }} />
          </div>
          <div>
            <div className="label">Industry</div>
            <input className="input" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Software" style={{ width: '100%' }} />
          </div>
          {warnings.length > 0 && (
            <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(254,216,0,.1)', border: '1px solid rgba(254,216,0,.3)', fontSize: 12.5 }}>
              Similar company already exists: <b>{warnings[0].candidate.name}</b>. Tick below to create anyway.
              <label style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={forceCreate} onChange={(e) => setForceCreate(e.target.checked)} />
                Create anyway
              </label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={() => (reset(), onClose())}>Cancel</Btn>
          <Btn kind="primary" onClick={submit} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create company'}
          </Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
