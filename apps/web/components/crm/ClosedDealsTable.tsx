'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Btn, Icon, Pill } from '@/components/proto'
import { Sk } from '@/components/states'
import { useToast } from '@/components/ui/use-toast'
import { OwnerAv, EmptyState, fmtCur } from '@/components/crm/kit'
import { OutcomeDialog, ReopenDialog, type OutcomeMode } from '@/components/crm/outcome-dialogs'
import {
  useClosedDeals,
  useReopenDeal,
  useSetDealOutcome,
  usePipelines,
  useLostReasons,
  type ClosedDealRow,
  type DealOutcomeBody,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// Round I — the "Closed" view on the deals page. The kanban only ever
// renders open deals, so a deal vanished from the CRM the moment it was
// won or lost. This table lists won + lost deals with the outcome, the
// close date and the lost reason, filtered by the page's owner/search/
// pipeline. Round R R3: a closed deal is editable straight from the row —
// reopen into a chosen stage, flip the verdict, edit the lost reason
// (manager and above, mirroring the API's @Roles).
// ─────────────────────────────────────────────────────────

export type ClosedOutcome = 'closed' | 'won' | 'lost'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function ClosedDealsTable({ pipelineId, ownerUserId, search, canReopen, onOpen }: {
  pipelineId?: string
  ownerUserId?: string | null
  search: string
  /** Manager and above — reopen / outcome routes are @Roles('owner','admin','manager'). */
  canReopen: boolean
  onOpen: (id: string) => void
}) {
  const { toast } = useToast()
  const [outcome, setOutcome] = useState<ClosedOutcome>('closed')
  const [page, setPage] = useState(1)
  const limit = 25
  const list = useClosedDeals({
    status: outcome,
    pipeline_id: pipelineId,
    owner_user_id: ownerUserId ?? undefined,
    q: search.trim() || undefined,
    page,
    limit,
  })
  const reopen = useReopenDeal()
  const setDealOutcome = useSetDealOutcome()
  const pipelines = usePipelines()
  const lostReasons = useLostReasons()
  const [reopenFor, setReopenFor] = useState<ClosedDealRow | null>(null)
  const [outcomeFor, setOutcomeFor] = useState<{ row: ClosedDealRow; mode: OutcomeMode } | null>(null)
  const rows = list.data?.data ?? []
  const base = list.data?.base_currency ?? 'INR'
  const pagination = list.data?.pagination
  const total = pagination?.total ?? 0
  const totalPages = pagination?.totalPages ?? 1

  const pick = (o: ClosedOutcome) => { setOutcome(o); setPage(1) }
  const openStagesFor = (row: ClosedDealRow) =>
    (pipelines.data?.data.find((p) => p.id === row.pipeline_id)?.stages ?? [])
      .filter((s) => s.stage_type === 'open')
      .slice()
      .sort((a, b) => a.display_order - b.display_order)

  const doReopen = async (d: ClosedDealRow, stageId: string) => {
    try {
      await reopen.mutateAsync({ id: d.id, stageId })
      toast({ title: 'Deal reopened', description: `${d.title} is back on the board in ${openStagesFor(d).find((s) => s.id === stageId)?.name ?? 'its stage'}.` })
      setReopenFor(null)
    } catch (err) {
      toast({ title: 'Could not reopen', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }
  const doOutcome = async (d: ClosedDealRow, mode: OutcomeMode, body: DealOutcomeBody) => {
    try {
      await setDealOutcome.mutateAsync({ id: d.id, body })
      toast({ title: mode === 'to-won' ? `${d.title} marked as won` : mode === 'to-lost' ? `${d.title} marked as lost` : mode === 'edit-reason' ? 'Lost reason updated' : 'Date updated' })
      setOutcomeFor(null)
    } catch (err) {
      toast({ title: 'Could not change the outcome', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const emptyLine =
    outcome === 'won' ? 'No won deals yet — drag a deal onto “Drop to mark WON” or press Won on a deal page.'
    : outcome === 'lost' ? 'No lost deals. When a deal is marked lost it shows up here with the reason.'
    : 'No closed deals yet. Won and lost deals move here so you can keep tracking them.'

  return (
    <div>
      {/* Outcome chips + count */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9 }} data-testid="closed-outcome-chips">
          {([['closed', 'All closed'], ['won', '🏆 Won'], ['lost', 'Lost']] as Array<[ClosedOutcome, string]>).map(([id, label]) => (
            <button key={id} type="button" onClick={() => pick(id)} data-testid={`closed-chip-${id}`} style={{
              padding: '7px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap',
              background: outcome === id ? 'var(--surf-3)' : 'transparent',
              color: outcome === id ? 'var(--text)' : 'var(--text-2)',
            }}>{label}</button>
          ))}
        </div>
        <span className="t-caption" data-testid="closed-total">
          {list.isLoading ? 'Loading…' : `${total} deal${total === 1 ? '' : 's'}`}
        </span>
        {list.isFetching && !list.isLoading && <Icon.refresh size={12} className="animate-spin" style={{ color: 'var(--text-faint)' }} />}
      </div>

      {list.isLoading ? (
        <div className="card" style={{ padding: 14 }}>
          {[0, 1, 2, 3].map((r) => (
            <div key={r} style={{ display: 'flex', gap: 14, padding: '10px 0', borderTop: r ? '1px solid var(--bord)' : 'none' }}>
              <Sk w="28%" h={11} /><Sk w="16%" h={11} /><Sk w="12%" h={11} /><Sk w="10%" h={11} /><Sk w="14%" h={11} />
            </div>
          ))}
        </div>
      ) : list.isError ? (
        <EmptyState
          icon={<Icon.warn size={22} />}
          line="Couldn’t load closed deals."
          secondary={<Btn kind="secondary" size="sm" onClick={() => void list.refetch()}>Retry</Btn>}
        />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Icon.kanban size={22} />} line={emptyLine} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }} data-testid="closed-deals-table">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                  <th style={th}>Deal</th>
                  <th style={th}>Company</th>
                  <th style={th}>Owner</th>
                  <th style={{ ...th, textAlign: 'right' }}>Value</th>
                  <th style={th}>Stage</th>
                  <th style={th}>Closed on</th>
                  <th style={th}>Outcome</th>
                  <th style={th}>Reason</th>
                  {canReopen && <th style={{ ...th, textAlign: 'right' }}></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((d, i) => (
                  <tr key={d.id} data-testid={`closed-row-${d.id}`} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none' }}>
                    <td style={td}>
                      <Link href={`/crm/deals/${d.id}`} onClick={(e) => { e.preventDefault(); onOpen(d.id) }} style={{ color: 'var(--text)', textDecoration: 'none', fontWeight: 800, fontSize: 12.5 }}>
                        {d.title}
                      </Link>
                    </td>
                    <td style={td}>{d.company_name ?? <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <OwnerAv name={d.owner_name ?? null} src={d.owner_avatar_url} size={18} />{d.owner_name ?? '—'}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <span className="t-num" style={{ fontWeight: 800 }}>{fmtCur(parseFloat(d.value_amount), d.currency)}</span>
                      {d.currency !== base && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-faint)', fontWeight: 700 }}>≈ {fmtCur(parseFloat(d.value_base_amount), base)}</span>}
                    </td>
                    <td style={td}>{d.stage_name ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{fmtDate(d.closed_at)}</td>
                    <td style={td}>
                      <Pill tone={d.status === 'won' ? 'green' : 'coral'}>{d.status === 'won' ? '🏆 Won' : 'Lost'}</Pill>
                    </td>
                    <td style={{ ...td, maxWidth: 240 }} title={d.lost_reason_note ?? undefined}>
                      {d.status === 'lost' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ fontWeight: 700 }}>{d.lost_reason_label ?? (d.lost_reason_note ? 'Other' : '—')}</span>
                          {d.lost_reason_note && (
                            <span style={{ color: 'var(--text-mute)', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>· {d.lost_reason_note}</span>
                          )}
                        </span>
                      ) : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                    </td>
                    {canReopen && (
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Btn kind="ghost" size="sm" icon={<Icon.swap size={12} />} disabled={setDealOutcome.isPending} onClick={() => setOutcomeFor({ row: d, mode: d.status === 'won' ? 'to-lost' : 'to-won' })}
                          title={d.status === 'won' ? 'Mark as lost instead' : 'Mark as won instead'} data-testid={`closed-outcome-${d.id}`}>
                          {d.status === 'won' ? 'Mark lost' : 'Mark won'}
                        </Btn>
                        {d.status === 'lost' && (
                          <Btn kind="ghost" size="sm" icon={<Icon.edit size={12} />} onClick={() => setOutcomeFor({ row: d, mode: 'edit-reason' })} title="Edit the lost reason" data-testid={`closed-reason-${d.id}`} />
                        )}
                        <Btn kind="ghost" size="sm" icon={<Icon.refresh size={12} />} disabled={reopen.isPending} onClick={() => setReopenFor(d)} title="Reopen into a stage you choose" data-testid={`closed-reopen-${d.id}`}>
                          Reopen…
                        </Btn>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--bord)' }}>
              <span className="t-caption">Page {page} of {totalPages}</span>
              <Btn kind="ghost" size="sm" icon={<Icon.chevL size={13} />} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} />
              <Btn kind="ghost" size="sm" icon={<Icon.chevR size={13} />} disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} />
            </div>
          )}
        </div>
      )}

      {reopenFor && (
        <ReopenDialog open deal={reopenFor} stages={openStagesFor(reopenFor)} busy={reopen.isPending}
          onClose={() => setReopenFor(null)} onConfirm={(sid) => void doReopen(reopenFor, sid)} />
      )}
      {outcomeFor && (
        <OutcomeDialog open mode={outcomeFor.mode} deal={outcomeFor.row} reasons={lostReasons.data?.data ?? []} busy={setDealOutcome.isPending}
          onClose={() => setOutcomeFor(null)} onConfirm={(body) => void doOutcome(outcomeFor.row, outcomeFor.mode, body)} />
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 800,
  textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-mute)',
}
const td: React.CSSProperties = { padding: '11px 14px', fontSize: 12.5, color: 'var(--text-2)', verticalAlign: 'middle' }
