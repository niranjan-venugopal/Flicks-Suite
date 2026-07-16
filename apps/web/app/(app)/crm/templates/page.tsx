'use client'

import { useEffect, useState } from 'react'
import { Btn, Icon, Modal, Pill, SectionHead } from '@/components/proto'
import { FEATURES } from '@/lib/feature-flags'
import { ComingSoon } from '@/components/crm/ComingSoon'
import { useToast } from '@/components/ui/use-toast'
import {
  useArchiveEmailTemplate,
  useCreateEmailTemplate,
  useEmailTemplates,
  useInboundAddress,
  useSetSignature,
  useSignature,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// Email settings — C9 templates manager, §19.4 signature,
// BCC dropbox (Phase A) and the C21 connected-accounts
// scaffold (Phase B, gated off until OAuth verifications).
// ─────────────────────────────────────────────────────────

// Phase B flips this per tenant once Google/Microsoft verifications clear.
const FEATURE_EMAIL_SYNC = false

export default function EmailTemplatesPage() {
  if (!FEATURES.crm_email) {
    return (
      <ComingSoon
        title="Email"
        line="Sending email from the CRM is being reimagined — templates, signatures and tracked sends return here in a new shape soon."
        icon={<Icon.mail size={24} />}
        bullets={['Compose from a deal with variables and your signature', 'Open/click tracking with do-not-contact protection', 'A BCC dropbox that files mail onto the right deal']}
      />
    )
  }
  return <EmailSettingsLive />
}

function EmailSettingsLive() {
  const [createOpen, setCreateOpen] = useState(false)
  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 760, margin: '0 auto' }}>
      <SectionHead
        title="Email settings"
        sub="Templates, your signature and how email flows into the CRM."
        right={<Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={() => setCreateOpen(true)}>New template</Btn>}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TemplatesCard />
        <SignatureCard />
        <BccCard />
        <ConnectedAccountsCard />
      </div>
      {createOpen && <CreateTemplateModal onClose={() => setCreateOpen(false)} />}
    </div>
  )
}

function TemplatesCard() {
  const { data, isLoading } = useEmailTemplates()
  const archive = useArchiveEmailTemplate()
  const { toast } = useToast()
  const rows = data?.data ?? []
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon.doc size={15} style={{ color: 'var(--blue)' }} />
        <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>Templates</span>
        <span className="t-mute" style={{ fontSize: 10.5 }}>{rows.length} saved</span>
      </div>
      {isLoading ? (
        <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={18} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <div className="t-mute" style={{ padding: '18px', fontSize: 12.5 }}>
          No templates yet — save one and it appears in the compose modal and in sequence steps.
        </div>
      ) : (
        <table className="tbl">
          <thead><tr><th>Template</th><th>Subject</th><th></th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td style={{ fontWeight: 800 }}>{t.name}</td>
                <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{t.subject}</td>
                <td style={{ textAlign: 'right' }}>
                  <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} disabled={archive.isPending}
                    onClick={() => archive.mutate(t.id, { onSuccess: () => toast({ title: 'Template archived' }) })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="t-caption" style={{ padding: '10px 18px', borderTop: '1px solid var(--bord)' }}>
        Variables resolve per recipient — {'{{first_name}}, {{company}}, {{deal_title}}, {{sender_name}}, {{unsubscribe_link}}'}
      </div>
    </div>
  )
}

function CreateTemplateModal({ onClose }: { onClose: () => void }) {
  const create = useCreateEmailTemplate()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('<p>Hi {{first_name}},</p>')
  const submit = async () => {
    try {
      await create.mutateAsync({ name, subject, body_html: body })
      toast({ title: 'Template saved' })
      onClose()
    } catch (err) {
      toast({ title: 'Could not save template', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }
  return (
    <Modal open onClose={onClose} width={620} title="New template" sub="Available in the compose modal and sequence steps"
      footer={<>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} disabled={!name.trim() || !subject.trim() || !body.trim() || create.isPending} onClick={() => void submit()}>
          {create.isPending ? 'Saving…' : 'Save template'}
        </Btn>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div><div className="label">Name</div><input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Intro — first touch" style={{ width: '100%' }} /></div>
        <div><div className="label">Subject</div><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Quick intro, {{first_name}}?" style={{ width: '100%' }} /></div>
        <div>
          <div className="label">Body (HTML)</div>
          <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)}
            style={{ width: '100%', height: 140, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 11.5, resize: 'vertical' }} />
        </div>
      </div>
    </Modal>
  )
}

function SignatureCard() {
  const { data, isLoading } = useSignature()
  const save = useSetSignature()
  const { toast } = useToast()
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)
  const remote = data?.data.signature ?? ''
  useEffect(() => {
    if (!isLoading && !loaded) { setDraft(remote); setLoaded(true) }
  }, [isLoading, loaded, remote])
  const dirty = loaded && draft !== remote
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
        <Icon.edit size={15} style={{ color: 'var(--purple, #a78bfa)' }} />
        <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>Your signature</span>
        <Pill tone="">§19.4</Pill>
      </div>
      <textarea className="input" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={isLoading}
        placeholder={'<p>—<br/>Sara · Flicks Suite<br/>+91 …</p>'}
        style={{ width: '100%', height: 100, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 11.5, resize: 'vertical' }} />
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 10, gap: 10 }}>
        <span className="t-caption" style={{ flex: 1 }}>Appended to every email you compose or send through sequences (HTML)</span>
        <Btn kind="primary" size="sm" icon={<Icon.check size={13} />} disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draft.trim() ? draft : null, { onSuccess: () => toast({ title: 'Signature saved' }) })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </div>
  )
}

function BccCard() {
  const { data } = useInboundAddress()
  const [copied, setCopied] = useState(false)
  const address = data?.data.address ?? ''
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
        <Icon.inbox size={15} style={{ color: 'var(--blue)' }} />
        <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>BCC dropbox — live today</span>
        <Pill tone="green" dot>Phase A</Pill>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" readOnly value={address} style={{ flex: 1, height: 38, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
        <Btn kind={copied ? 'secondary' : 'primary'} size="sm" icon={copied ? <Icon.check size={13} /> : <Icon.copy size={13} />}
          onClick={() => { void navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
          {copied ? 'Copied' : 'Copy'}
        </Btn>
      </div>
      <div className="t-caption" style={{ marginTop: 8 }}>
        Add it as an auto-BCC rule in Gmail/Outlook — every sent email files itself onto the matching contact & deal
      </div>
    </div>
  )
}

function ConnectedAccountsCard() {
  if (FEATURE_EMAIL_SYNC) return null // Phase B replaces this with the connect flow
  return (
    <div className="card" style={{ position: 'relative', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--surf-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
          <Icon.refresh size={17} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800 }}>Two-way Gmail & Outlook sync</div>
          <div className="t-mute" style={{ fontSize: 11.5 }}>Full conversation history, reply detection, send-as your own address</div>
        </div>
        <Pill tone="yellow">Coming soon</Pill>
      </div>
      <div className="t-caption" style={{ marginTop: 10 }}>
        Google & Microsoft verifications are in review — this switches on per tenant the moment they clear. BCC keeps everything logged meanwhile.
      </div>
    </div>
  )
}
