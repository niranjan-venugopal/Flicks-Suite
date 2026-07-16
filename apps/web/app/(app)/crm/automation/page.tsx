'use client'

import { useState } from 'react'
import { Btn, Icon, Modal, Pill, SectionHead, Toggle } from '@/components/proto'
import { EmptyState } from '@/components/crm/kit'
import { useToast } from '@/components/ui/use-toast'
import {
  useWorkflows,
  useWorkflowTriggers,
  useCreateWorkflow,
  useSetWorkflowActive,
  useWorkflowRuns,
  useEmailTemplates,
  type Workflow,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C12 — Workflows: trigger → conditions → actions with a
// run history. Guards: idempotent runs, loop protection,
// 20 active / 2,000 runs/day beta limits. Manager+ edits.
// ─────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<string, string> = {
  'crm.lead.created': 'Lead created',
  'crm.form.submitted': 'Form submitted',
  'crm.deal.created': 'Deal created',
  'crm.deal.stage_changed': 'Deal stage changed',
  'crm.deal.won': 'Deal won',
  'crm.deal.lost': 'Deal lost',
  'crm.activity.overdue': 'Activity overdue',
  'crm.email.bounced': 'Email bounced',
  'crm.email.replied': 'Email replied',
}

const ACTION_LABELS: Record<string, string> = {
  create_activity: 'Create task',
  notify: 'Notify (in-app)',
  assign_owner_round_robin: 'Assign owner — round-robin',
  send_template_email: 'Send template email',
  move_stage: 'Move deal stage',
}

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'is_set', 'not_set']

// Appendix B starters — one click prefills the builder.
const STARTERS: Array<{ title: string; sub: string; wf: { name: string; trigger: string; conditions: Array<{ field: string; op: string; value?: string | number }>; actions: Array<Record<string, unknown>> } }> = [
  {
    title: 'New form lead → assign + call task',
    sub: 'on form lead created → round-robin, task "Call within 1h"',
    wf: {
      name: 'New form lead → assign + call task',
      trigger: 'crm.lead.created',
      conditions: [{ field: 'source', op: 'starts_with', value: 'form:' }],
      actions: [
        { type: 'assign_owner_round_robin' },
        { type: 'create_activity', activity_type: 'call', subject: 'Call within 1h', due_in_hours: 1, assign_to: 'owner' },
        { type: 'notify', target: 'owner', message: 'New form lead assigned to you — call within the hour' },
      ],
    },
  },
  {
    title: 'Hot lead → ping the owner',
    sub: 'on lead created, score ≥ 30 → in-app notification',
    wf: {
      name: 'Hot lead → ping the owner',
      trigger: 'crm.lead.created',
      conditions: [{ field: 'score', op: 'gte', value: 30 }],
      actions: [{ type: 'notify', target: 'owner', message: 'Hot lead (score 30+) just landed' }],
    },
  },
  {
    title: 'Deal won → invoice task',
    sub: 'on deal won → task "Raise the invoice" for the owner',
    wf: {
      name: 'Deal won → invoice task',
      trigger: 'crm.deal.won',
      conditions: [],
      actions: [
        { type: 'create_activity', activity_type: 'task', subject: 'Raise the invoice', due_in_hours: 24, assign_to: 'owner' },
        { type: 'notify', target: 'owner', message: 'Deal won 🏆 — invoice task created' },
      ],
    },
  },
  {
    title: 'Email bounced → notify owner',
    sub: 'on bounce → the contact was auto-flagged do-not-contact; tell the owner',
    wf: {
      name: 'Email bounced → notify owner',
      trigger: 'crm.email.bounced',
      conditions: [],
      actions: [{ type: 'notify', target: 'owner', message: 'An email bounced — the contact is now do-not-contact' }],
    },
  },
]

export default function AutomationPage() {
  const [mode, setMode] = useState<'list' | 'runs'>('list')
  const { data, isLoading } = useWorkflows()
  const setActive = useSetWorkflowActive()
  const create = useCreateWorkflow()
  const { toast } = useToast()
  const [builderOpen, setBuilderOpen] = useState(false)
  const [prefill, setPrefill] = useState<typeof STARTERS[number]['wf'] | null>(null)
  const rows = data?.data ?? []
  const limits = data?.limits

  const enableStarter = async (wf: typeof STARTERS[number]['wf']) => {
    try {
      await create.mutateAsync(wf)
      toast({ title: 'Workflow enabled', description: wf.name })
    } catch (err) {
      toast({ title: 'Could not enable', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 980, margin: '0 auto' }}>
      <SectionHead
        title="Automation"
        sub="Automate the busywork — trigger → conditions → actions, loop-protected."
        right={<Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={() => { setPrefill(null); setBuilderOpen(true) }}>New workflow</Btn>}
      />
      <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 10, marginBottom: 16, width: 'fit-content' }}>
        {([['list', 'Workflows'], ['runs', 'Run history']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setMode(k)} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: mode === k ? 'var(--surf-3)' : 'transparent', color: mode === k ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800 }}>{l}</button>
        ))}
      </div>

      {mode === 'list' && (
        <>
          {limits && (
            <div className="t-caption" style={{ marginBottom: 12 }}>
              Limits: {limits.max_active} active workflows · {limits.runs_per_day.toLocaleString()} runs/day · chain depth {limits.chain_depth} (loop-protected)
            </div>
          )}
          {isLoading ? (
            <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Icon.zap size={22} />}
              line="Automate the busywork — start from a proven recipe below or build your own trigger → conditions → actions flow."
              cta="New workflow"
              onCta={() => { setPrefill(null); setBuilderOpen(true) }}
            />
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 18 }}>
              <table className="tbl">
                <thead><tr><th>Workflow</th><th>Trigger</th><th style={{ textAlign: 'right' }}>Runs</th><th>Last run</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {rows.map((w) => (
                    <tr key={w.id}>
                      <td style={{ fontWeight: 800 }}>{w.name}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{TRIGGER_LABELS[w.trigger] ?? w.trigger}</td>
                      <td className="t-num" style={{ textAlign: 'right' }}>{w.runs_count}</td>
                      <td className="t-mute" style={{ fontSize: 11.5 }}>{w.last_run_at ? new Date(w.last_run_at).toLocaleString() : '—'}</td>
                      <td>{w.active ? <Pill tone="green" dot>Active</Pill> : <Pill tone="yellow" dot>Paused</Pill>}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Toggle on={w.active} onChange={(v: boolean) => setActive.mutate({ id: w.id, active: v })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="t-caption" style={{ marginBottom: 10 }}>Starter gallery — one-click enable (Appendix B)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 12 }}>
            {STARTERS.map((s) => (
              <div key={s.title} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: 'rgba(155,123,250,.14)', color: 'var(--purple, #9b7bfa)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon.zap size={14} /></div>
                <div style={{ fontSize: 12.5, fontWeight: 800, lineHeight: 1.4 }}>{s.title}</div>
                <div className="t-caption">{s.sub}</div>
                <Btn kind="secondary" size="sm" style={{ marginTop: 'auto', justifyContent: 'center' }} icon={<Icon.plus size={12} />} disabled={create.isPending}
                  onClick={() => void enableStarter(s.wf)}>
                  Enable
                </Btn>
              </div>
            ))}
          </div>
        </>
      )}

      {mode === 'runs' && <RunHistory />}
      {builderOpen && <BuilderModal prefill={prefill} onClose={() => setBuilderOpen(false)} />}
    </div>
  )
}

function RunHistory() {
  const { data, isLoading } = useWorkflowRuns()
  const [open, setOpen] = useState<string | null>(null)
  const rows = data?.data ?? []
  if (isLoading) return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  if (rows.length === 0) return <div className="t-mute" style={{ fontSize: 12.5 }}>No runs yet — runs appear the moment a trigger fires.</div>
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', maxWidth: 760 }}>
      {rows.map((r) => (
        <div key={r.id} style={{ borderBottom: '1px solid var(--bord)' }}>
          <button onClick={() => setOpen((o) => (o === r.id ? null : r.id))} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '13px 18px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
            {r.status === 'ok'
              ? <Icon.success size={15} style={{ color: 'var(--green)', flexShrink: 0 }} />
              : r.status === 'skipped'
                ? <Icon.info size={15} style={{ color: 'var(--yellow)', flexShrink: 0 }} />
                : <Icon.warn size={15} style={{ color: 'var(--coral)', flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: '#fff' }}>{r.workflow_name}</div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>{new Date(r.created_at).toLocaleString()} · {r.steps.length} steps</div>
            </div>
            {r.status === 'error' && <Pill tone="coral">{r.steps.filter((s) => s.status === 'error').length} step failed</Pill>}
            {r.status === 'skipped' && <Pill tone="yellow">loop guard</Pill>}
            <Icon.chevD size={13} style={{ color: 'var(--text-faint)', transform: open === r.id ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
          </button>
          {open === r.id && (
            <div style={{ padding: '0 18px 14px 44px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {r.steps.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {s.status === 'ok'
                    ? <Icon.check size={12} style={{ color: 'var(--green)', flexShrink: 0 }} />
                    : s.status === 'skipped'
                      ? <Icon.info size={12} style={{ color: 'var(--yellow)', flexShrink: 0 }} />
                      : <Icon.x size={12} style={{ color: 'var(--coral)', flexShrink: 0 }} />}
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: s.status === 'error' ? 'var(--coral)' : 'var(--text-2)' }}>
                    {s.label}{s.error ? ` — ${s.error}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

type DraftCondition = { field: string; op: string; value: string }
type DraftAction = { type: string; subject?: string; message?: string; due_in_hours?: number; template_id?: string; stage_id?: string }

function BuilderModal({ prefill, onClose }: { prefill: typeof STARTERS[number]['wf'] | null; onClose: () => void }) {
  const create = useCreateWorkflow()
  const triggers = useWorkflowTriggers()
  const templates = useEmailTemplates()
  const { toast } = useToast()
  const [name, setName] = useState(prefill?.name ?? '')
  const [trigger, setTrigger] = useState(prefill?.trigger ?? 'crm.lead.created')
  const [conditions, setConditions] = useState<DraftCondition[]>(
    (prefill?.conditions ?? []).map((c) => ({ field: c.field, op: c.op, value: String(c.value ?? '') })),
  )
  const [actions, setActions] = useState<DraftAction[]>(
    (prefill?.actions as DraftAction[] | undefined) ?? [{ type: 'notify', message: '' }],
  )

  const submit = async () => {
    try {
      await create.mutateAsync({
        name,
        trigger,
        conditions: conditions.filter((c) => c.field.trim()).map((c) => ({ field: c.field.trim(), op: c.op, value: c.op.endsWith('_set') ? undefined : c.value })),
        actions,
      })
      toast({ title: 'Workflow created' })
      onClose()
    } catch (err) {
      toast({ title: 'Could not create workflow', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <Modal open onClose={onClose} width={680} title="New workflow" sub="Runs are idempotent, loop-protected, and email actions respect do-not-contact + daily throttles"
      footer={<>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} disabled={!name.trim() || actions.length === 0 || create.isPending} onClick={() => void submit()}>
          {create.isPending ? 'Creating…' : 'Create workflow'}
        </Btn>
      </>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 12, marginBottom: 14 }}>
        <div><div className="label">Name</div><input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New form lead → call task" style={{ width: '100%' }} /></div>
        <div>
          <div className="label">Trigger</div>
          <select className="input" value={trigger} onChange={(e) => setTrigger(e.target.value)} style={{ width: '100%', height: 36 }}>
            {(triggers.data?.data ?? Object.keys(TRIGGER_LABELS)).map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t] ?? t}</option>)}
          </select>
        </div>
      </div>

      <div className="label" style={{ marginBottom: 6 }}>Conditions <span style={{ color: 'var(--text-faint)' }}>· all must match (fields: source, score, status, stage_id, value_base…)</span></div>
      {conditions.map((c, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 130px 1fr 30px', gap: 8, marginBottom: 6 }}>
          <input className="input" value={c.field} placeholder="source" onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} style={{ height: 34, fontSize: 12 }} />
          <select className="input" value={c.op} onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))} style={{ height: 34, fontSize: 12 }}>
            {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <input className="input" value={c.value} placeholder="form:" disabled={c.op.endsWith('_set')} onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ height: 34, fontSize: 12 }} />
          <Btn kind="ghost" size="sm" icon={<Icon.x size={12} />} onClick={() => setConditions((arr) => arr.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Btn kind="ghost" size="sm" icon={<Icon.plus size={12} />} onClick={() => setConditions((arr) => [...arr, { field: '', op: 'eq', value: '' }])}>Add condition</Btn>

      <div className="label" style={{ margin: '14px 0 6px' }}>Actions <span style={{ color: 'var(--text-faint)' }}>· run in order, failures don&apos;t stop later steps</span></div>
      {actions.map((a, i) => (
        <div key={i} style={{ border: '1px solid var(--bord)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: a.type === 'assign_owner_round_robin' ? 0 : 8 }}>
            <Pill tone="blue">Action {i + 1}</Pill>
            <select className="input" value={a.type} onChange={(e) => setActions((arr) => arr.map((x, j) => (j === i ? { type: e.target.value } : x)))} style={{ height: 32, fontSize: 12, flex: 1 }}>
              {Object.entries(ACTION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {actions.length > 1 && <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} onClick={() => setActions((arr) => arr.filter((_, j) => j !== i))} />}
          </div>
          {a.type === 'create_activity' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 }}>
              <input className="input" value={a.subject ?? ''} placeholder='Task subject, e.g. "Call within 1h"' onChange={(e) => setActions((arr) => arr.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))} style={{ height: 32, fontSize: 12 }} />
              <input className="input t-num" type="number" min={1} value={a.due_in_hours ?? 24} title="Due in hours" onChange={(e) => setActions((arr) => arr.map((x, j) => (j === i ? { ...x, due_in_hours: parseInt(e.target.value || '24', 10) } : x)))} style={{ height: 32, fontSize: 12 }} />
            </div>
          )}
          {a.type === 'notify' && (
            <input className="input" value={a.message ?? ''} placeholder="Notification message (goes to the record owner)" onChange={(e) => setActions((arr) => arr.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))} style={{ height: 32, fontSize: 12, width: '100%' }} />
          )}
          {a.type === 'send_template_email' && (
            <select className="input" value={a.template_id ?? ''} onChange={(e) => setActions((arr) => arr.map((x, j) => (j === i ? { ...x, template_id: e.target.value } : x)))} style={{ height: 32, fontSize: 12, width: '100%' }}>
              <option value="">Pick a template…</option>
              {(templates.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          {a.type === 'move_stage' && (
            <input className="input" value={a.stage_id ?? ''} placeholder="Target stage id (from your pipeline settings)" onChange={(e) => setActions((arr) => arr.map((x, j) => (j === i ? { ...x, stage_id: e.target.value } : x)))} style={{ height: 32, fontSize: 12, width: '100%' }} />
          )}
        </div>
      ))}
      <Btn kind="ghost" size="sm" icon={<Icon.plus size={12} />} disabled={actions.length >= 5} onClick={() => setActions((arr) => [...arr, { type: 'notify', message: '' }])}>Add action</Btn>
    </Modal>
  )
}
