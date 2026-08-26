'use client'

import { useState } from 'react'
import { Btn, Icon, Modal, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useDealEmails,
  useSendEmail,
  useEmailTemplates,
  useInboundAddress,
  type DealDetail,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C9/C11 — deal Emails tab: thread with open/click badges,
// compose with templates + variables + tracking toggle, and
// the tenant BCC dropbox address for filing external mail.
// ─────────────────────────────────────────────────────────

const VARIABLES = ['{{first_name}}', '{{name}}', '{{company}}', '{{deal_title}}', '{{sender_name}}', '{{unsubscribe_link}}']

export function EmailsTab({ deal }: { deal: DealDetail }) {
  const emails = useDealEmails(deal.id)
  const inbound = useInboundAddress()
  const { toast } = useToast()
  const [composeOpen, setComposeOpen] = useState(false)
  const rows = emails.data?.data ?? []

  const copyBcc = async () => {
    if (!inbound.data) return
    await navigator.clipboard.writeText(inbound.data.data.address)
    toast({ title: 'BCC address copied', description: 'BCC it on any email — the conversation files itself here.' })
  }

  const dncBlocked = false // server enforces; compose surfaces the error toast

  return (
    <>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {rows.map((m, i) => (
          <div key={m.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '13px 18px', borderBottom: '1px solid var(--bord)' }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: m.direction === 'in' ? 'rgba(39,210,128,.13)' : 'rgba(62,123,250,.13)', color: m.direction === 'in' ? 'var(--green)' : 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {m.direction === 'in' ? <Icon.download size={13} /> : <Icon.send size={13} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.subject}</div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                {m.direction === 'in' ? `from ${m.from_email ?? '—'} · inbound via BCC` : `${m.sender_name ?? 'You'} → ${m.to_email} · via Resend`}
                {m.status !== 'sent' && m.status !== 'received' && ` · ${m.status}`}
              </div>
            </div>
            {m.direction === 'out' && m.tracking && (
              <>
                <Pill tone="blue" icon={<Icon.eye size={10} />}>{m.open_count}</Pill>
                {m.click_count > 0 && <Pill tone="purple" icon={<Icon.link size={10} />}>{m.click_count}</Pill>}
              </>
            )}
            {(m.status === 'bounced' || m.status === 'complained') && <Pill tone="coral">{m.status}</Pill>}
            <span className="t-caption" style={{ whiteSpace: 'nowrap' }}>{new Date(m.created_at).toLocaleDateString()}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>
            No email on this deal yet — compose one, or BCC the dropbox address on mail you send from your own inbox.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 18px', flexWrap: 'wrap' }}>
          <Btn kind="primary" size="sm" icon={<Icon.send size={13} />} onClick={() => setComposeOpen(true)} disabled={dncBlocked}>Compose</Btn>
          <div style={{ flex: 1 }} />
          {inbound.data && (
            <button onClick={() => void copyBcc()} title="Copy the BCC dropbox address" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, background: 'var(--surf-1)', border: '1px solid var(--bord)', color: 'var(--text-2)', fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', cursor: 'pointer' }}>
              <Icon.copy size={11} /> {inbound.data.data.address}
            </button>
          )}
        </div>
      </div>
      {composeOpen && <ComposeModal deal={deal} onClose={() => setComposeOpen(false)} />}
    </>
  )
}

function ComposeModal({ deal, onClose }: { deal: DealDetail; onClose: () => void }) {
  const { toast } = useToast()
  const send = useSendEmail()
  const templates = useEmailTemplates()
  const contact = deal.people.find((p) => p.person_id === deal.primary_person_id) ?? deal.people[0]
  const [subject, setSubject] = useState(`About ${deal.title}`)
  const [body, setBody] = useState('<p>Hi {{first_name}},</p>\n<p></p>\n<p>Best,<br/>{{sender_name}}</p>')
  const [tracking, setTracking] = useState(true)

  const applyTemplate = (id: string) => {
    const tpl = templates.data?.data.find((t) => t.id === id)
    if (!tpl) return
    setSubject(tpl.subject)
    setBody(tpl.body_html)
  }

  const submit = async () => {
    try {
      const res = await send.mutateAsync({ deal_id: deal.id, subject, body_html: body, tracking })
      toast({ title: 'Email sent', description: `To ${res.data.to} — opens and clicks will show on the thread.` })
      onClose()
    } catch (err) {
      toast({ title: 'Could not send', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <Modal open onClose={onClose} width={640} title="Compose" sub={`To the deal's primary contact${contact?.email ? ` · ${contact.email}` : deal.company?.name ? ` at ${deal.company.name}` : ''}`}
      footer={<>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginRight: 'auto', fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} /> Track opens & clicks
        </label>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.send size={14} />} onClick={() => void submit()} disabled={!subject.trim() || !body.trim() || send.isPending}>
          {send.isPending ? 'Sending…' : 'Send'}
        </Btn>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(templates.data?.data.length ?? 0) > 0 && (
          <div>
            <div className="label">Template</div>
            <select className="input" defaultValue="" onChange={(e) => applyTemplate(e.target.value)} style={{ width: '100%', height: 36 }}>
              <option value="">— start from scratch —</option>
              {templates.data!.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <div className="label">Subject</div>
          <input autoFocus className="input" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div>
          <div className="label">Body <span style={{ color: 'var(--text-faint)' }}>· HTML, your signature is appended automatically</span></div>
          <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} style={{ width: '100%', height: 180, padding: 12, fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="t-caption">Variables:</span>
          {VARIABLES.map((v) => (
            <button key={v} onClick={() => setBody((b) => b + ' ' + v)} style={{ padding: '3px 8px', borderRadius: 7, background: 'var(--surf-1)', border: '1px solid var(--bord)', color: 'var(--text-2)', fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', cursor: 'pointer' }}>
              {v}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
