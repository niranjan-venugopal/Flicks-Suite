'use client'

import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Kpi, Pill, SectionHead, Toggle, initials } from '@/components/proto'
import { useFamTenants, type FamTenantRow } from '@/lib/api/queries/use-fam'
import {
  useAuditorRegistry,
  useRevokeAuditorLink,
  useInvoicingMetrics,
  useTenantModules,
  useToggleModule,
} from '@/lib/api/queries/use-inv-settings'
import { useToast } from '@/components/ui/use-toast'

/**
 * FAM → Invoicing (PRD §10): anonymized aggregate metrics, the auditor-link
 * registry (with revoke), and per-tenant module toggles. Hard privacy line —
 * never any invoice content, only enablement + seat/auditor metadata.
 */
export default function FamInvoicingPage() {
  const metrics = useInvoicingMetrics()
  const registry = useAuditorRegistry()
  const tenants = useFamTenants({ limit: 50 })
  const revoke = useRevokeAuditorLink()
  const { toast } = useToast()

  const m = metrics.data?.data

  return (
    <div style={{ padding: '24px 28px 64px' }}>
      <SectionHead
        title="Invoicing — platform view"
        sub="Module access, auditor links and anonymized adoption metrics. No invoice content."
      />

      {/* Anonymized aggregate metrics (§10.4) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 22 }}>
        <Kpi label="Tenants with an auditor" value={m?.tenantsWithAuditor ?? '—'} icon={<Icon.shield size={16} />} accent="purple" />
        <Kpi label="Multi-company auditors" value={m?.multiCompanyAuditors ?? '—'} icon={<Icon.people size={16} />} accent="blue" />
        <Kpi label="Median companies / auditor" value={m?.medianCompaniesPerAuditor ?? '—'} icon={<Icon.grid size={16} />} accent="blue" />
        <Kpi label="Tenants with a bank account" value={m?.tenantsWithBankAccount ?? '—'} icon={<Icon.bank size={16} />} accent="green" />
        <Kpi label="Using foreign currency" value={m?.tenantsUsingForeignCurrency ?? '—'} icon={<Icon.globe size={16} />} accent="yellow" />
        <Kpi label="Tenants invoicing" value={m?.tenantsWithInvoices ?? '—'} icon={<Icon.doc size={16} />} accent="green" />
      </div>

      {/* Auditor-link registry (§10.2) */}
      <div className="t-caption" style={{ marginBottom: 10 }}>Auditor links</div>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 24 }}>
        {registry.isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}>
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-mute)' }} />
          </div>
        ) : (registry.data?.data.length ?? 0) === 0 ? (
          <div className="t-mute" style={{ padding: '18px', fontSize: 12.5 }}>No auditor links across the platform yet.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Auditor</th><th>Company</th><th>Seat</th><th>Window</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {registry.data!.data.flatMap((a) =>
                a.companies.map((c, idx) => (
                  <tr key={`${a.userId}-${c.tenantId}`}>
                    <td>
                      {idx === 0 ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Avatar name={a.fullName ?? a.email ?? '?'} size="sm" />
                          <div>
                            <div style={{ fontWeight: 800 }}>{a.fullName ?? '—'}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-mute)' }}>{a.email}</div>
                          </div>
                        </div>
                      ) : (
                        <span className="t-mute" style={{ fontSize: 11, paddingLeft: 42 }}>↳ same auditor</span>
                      )}
                    </td>
                    <td>{c.tenantName}</td>
                    <td>{c.isExternal ? <Pill tone="purple">External CA</Pill> : <Pill>Internal</Pill>}</td>
                    <td>
                      {c.accessExpiresAt ? (
                        <span className="t-mute" style={{ fontSize: 12 }}>
                          until {new Date(c.accessExpiresAt).toLocaleDateString('en-IN')}
                        </span>
                      ) : '—'}
                    </td>
                    <td>
                      {c.status === 'active' ? <Pill tone="green" dot>Active</Pill>
                        : c.status === 'invited' ? <Pill tone="yellow" dot>Invited</Pill>
                        : <Pill tone="coral">Revoked</Pill>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {c.status !== 'deactivated' && (
                        <Btn
                          kind="danger"
                          size="sm"
                          disabled={revoke.isPending}
                          onClick={async () => {
                            try {
                              await revoke.mutateAsync({ userId: a.userId, tenantId: c.tenantId })
                              toast({ title: 'Auditor link revoked', description: `${a.email} · ${c.tenantName}` })
                            } catch (err) {
                              toast({ title: 'Could not revoke', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
                            }
                          }}
                        >
                          Revoke
                        </Btn>
                      )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Per-tenant module access (§10.1) */}
      <div className="t-caption" style={{ marginBottom: 10 }}>Module access · toggle wins over grants</div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {tenants.isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}>
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-mute)' }} />
          </div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Company</th><th>Status</th><th style={{ textAlign: 'right' }}>Invoicing</th></tr></thead>
            <tbody>
              {(tenants.data?.data ?? []).map((t) => (
                <TenantInvoicingRow key={t.id} tenant={t} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function TenantInvoicingRow({ tenant }: { tenant: FamTenantRow }) {
  const modules = useTenantModules(tenant.id)
  const toggle = useToggleModule(tenant.id)
  const { toast } = useToast()
  const invoicing = modules.data?.data.find((x) => x.module === 'invoicing')

  return (
    <tr>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={tenant.name} size="sm" />
          <div style={{ fontWeight: 800 }}>{tenant.name}</div>
        </div>
      </td>
      <td><span className="t-mute" style={{ fontSize: 12 }}>{tenant.status}</span></td>
      <td style={{ textAlign: 'right' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="t-mute" style={{ fontSize: 11.5 }}>
            {invoicing ? (invoicing.enabled ? 'Enabled' : 'Disabled') : '…'}
          </span>
          <Toggle
            on={!!invoicing?.enabled}
            onChange={async (v) => {
              try {
                await toggle.mutateAsync({ module: 'invoicing', enabled: v })
                toast({ title: v ? 'Invoicing enabled' : 'Invoicing disabled', description: tenant.name })
              } catch (err) {
                toast({ title: 'Could not change module', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
              }
            }}
          />
        </div>
      </td>
    </tr>
  )
}
