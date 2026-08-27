'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Btn, Icon, Modal, Pill, SectionHead, Toggle } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/crm/kit'
import { useToast } from '@/components/ui/use-toast'
import {
  useForms,
  useCreateForm,
  useDeleteForm,
  useSetFormActive,
  useFormSubmissions,
  type WebForm,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C13 — Web forms: hosted lead capture at /f/:token (plus a
// plain link to embed). Spam defense: honeypot + min-fill-
// time + 10/hr/IP — no CAPTCHAs, no third parties.
// ─────────────────────────────────────────────────────────

export default function FormsPage() {
  const { data, isLoading } = useForms()
  const setActive = useSetFormActive()
  const deleteForm = useDeleteForm()
  const [createOpen, setCreateOpen] = useState(false)
  const [subsFor, setSubsFor] = useState<WebForm | null>(null)
  const [deleting, setDeleting] = useState<WebForm | null>(null)
  const { toast } = useToast()
  const rows = data?.data ?? []
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 900, margin: '0 auto' }}>
      <SectionHead
        title="Web forms"
        sub="Capture leads from your site with a hosted form — no code, spam-guarded, UTM-aware."
        right={<Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={() => setCreateOpen(true)}>Create form</Btn>}
      />

      {isLoading ? (
        <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon.doc size={22} />}
          line="Capture leads from your site with a hosted form or a shared link — no code, spam-guarded, UTM-aware."
          cta="Create form"
          onCta={() => setCreateOpen(true)}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((f) => (
            <div key={f.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', flexWrap: 'wrap' }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(62,123,250,.14)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.doc size={16} />
              </div>
              <div style={{ flex: 1, minWidth: 150 }}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{f.name}</div>
                <div className="t-mute" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                  /f/{f.token} · source form:{f.source_tag} · {f.fields.length} fields
                </div>
              </div>
              {/* One non-shrinking cluster so the actions never orphan onto a
                  second line — below ~800px the whole cluster wraps together. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <Pill tone="blue">{f.submission_count} submissions</Pill>
                <Btn kind="ghost" size="sm" icon={<Icon.copy size={12} />}
                  onClick={() => { void navigator.clipboard.writeText(`${origin}/f/${f.token}`); toast({ title: 'Hosted link copied' }) }}>
                  Copy link
                </Btn>
                <Link href={`/f/${f.token}`} target="_blank"><Btn kind="ghost" size="sm" icon={<Icon.eye size={12} />}>Preview</Btn></Link>
                <Btn kind="secondary" size="sm" onClick={() => setSubsFor(f)}>Submissions</Btn>
                <Toggle on={f.active} onChange={(v: boolean) => setActive.mutate({ id: f.id, active: v })} />
                <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} disabled={deleteForm.isPending}
                  onClick={() => setDeleting(f)} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="t-caption" style={{ marginTop: 10 }}>
        Spam defense: honeypot + min-fill-time + 10/hr/IP — submissions become leads with round-robin assignment, UTM capture, and an automatic “Call within 1h” follow-up task for the owner.
      </div>

      {createOpen && <CreateFormModal onClose={() => setCreateOpen(false)} />}
      {subsFor && <SubmissionsModal form={subsFor} onClose={() => setSubsFor(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete form"
        danger
        body={deleting ? `Delete “${deleting.name}”? The public link stops working immediately. Past submissions and the leads they created are kept.` : null}
        confirmLabel="Delete form"
        loading={deleteForm.isPending}
        loadingLabel="Deleting…"
        onConfirm={() => deleting && deleteForm.mutate(deleting.id, {
          onSuccess: () => {
            toast({ title: 'Form deleted', description: 'Submissions and leads were kept.' })
            setDeleting(null)
          },
        })}
      />
    </div>
  )
}

const FIELD_PRESETS: Array<{ key: string; label: string; type: 'text' | 'email' | 'phone' | 'textarea' }> = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'email', label: 'Work email', type: 'email' },
  { key: 'company', label: 'Company', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'phone' },
  { key: 'note', label: 'What are you evaluating?', type: 'textarea' },
]

function CreateFormModal({ onClose }: { onClose: () => void }) {
  const create = useCreateForm()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [title, setTitle] = useState('Talk to sales')
  const [intro, setIntro] = useState("Tell us a little about your team — we'll tailor the walkthrough.")
  const [enabled, setEnabled] = useState<Record<string, { on: boolean; required: boolean }>>({
    name: { on: true, required: true },
    email: { on: true, required: true },
    company: { on: true, required: false },
    phone: { on: false, required: false },
    note: { on: false, required: false },
  })

  const submit = async () => {
    const fields = FIELD_PRESETS.filter((f) => enabled[f.key]?.on).map((f) => ({ ...f, required: enabled[f.key]!.required }))
    try {
      await create.mutateAsync({ name, title, intro, fields })
      toast({ title: 'Form created', description: 'Copy the hosted link and put it on your site.' })
      onClose()
    } catch (err) {
      toast({ title: 'Could not create form', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <Modal open onClose={onClose} width={560} title="Create form" sub="Hosted page + link; submissions become leads with the form's source tag"
      footer={<>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} disabled={!name.trim() || create.isPending} onClick={() => void submit()}>
          {create.isPending ? 'Creating…' : 'Create form'}
        </Btn>
      </>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div><div className="label">Internal name</div><input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pricing page" style={{ width: '100%' }} /></div>
        <div><div className="label">Public title</div><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} /></div>
        <div style={{ gridColumn: '1/-1' }}><div className="label">Intro line</div><input className="input" value={intro} onChange={(e) => setIntro(e.target.value)} style={{ width: '100%' }} /></div>
      </div>
      <div className="label" style={{ marginBottom: 8 }}>Fields</div>
      {FIELD_PRESETS.map((f) => (
        <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)', marginBottom: 6 }}>
          <Toggle on={enabled[f.key]!.on} onChange={(v: boolean) => setEnabled((s) => ({ ...s, [f.key]: { ...s[f.key]!, on: v } }))} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{f.label}</span>
          <button
            onClick={() => setEnabled((s) => ({ ...s, [f.key]: { ...s[f.key]!, required: !s[f.key]!.required } }))}
            disabled={!enabled[f.key]!.on}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9.5, fontWeight: 800, color: enabled[f.key]!.required ? 'var(--coral)' : 'var(--text-faint)' }}>
            {enabled[f.key]!.required ? 'required' : 'optional'}
          </button>
        </div>
      ))}
      <div className="t-caption" style={{ marginTop: 10 }}>Spam defense: honeypot + min-fill-time + 10/hr/IP — no CAPTCHAs, no third parties</div>
    </Modal>
  )
}

function SubmissionsModal({ form, onClose }: { form: WebForm; onClose: () => void }) {
  const { data, isLoading } = useFormSubmissions(form.id)
  const rows = data?.data ?? []
  return (
    <Modal open onClose={onClose} width={640} title={`${form.name} — submissions`} sub="Each passing submission became a lead; spam never lands">
      {isLoading ? (
        <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={18} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <div className="t-mute" style={{ fontSize: 12.5 }}>No submissions yet — share the hosted link.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800 }}>{s.payload.name ?? s.payload.email ?? '—'}</div>
                <div className="t-mute" style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>
                  {s.payload.email}{s.utm.utm_source ? ` · ${s.utm.utm_source}${s.utm.utm_medium ? ` / ${s.utm.utm_medium}` : ''}` : ''} · {new Date(s.created_at).toLocaleString()}
                </div>
              </div>
              {s.lead_status && <Pill tone={s.lead_status === 'converted' ? 'green' : s.lead_status === 'discarded' ? '' : 'blue'}>{s.lead_status}</Pill>}
              {s.lead_id && <Link href="/crm/leads" style={{ color: 'var(--blue)', fontSize: 11.5, fontWeight: 800, textDecoration: 'none' }}>Open lead →</Link>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
