'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useFamVerificationQueue, useVerifyTenant } from '@/lib/api/queries/use-fam'
import { timeAgo } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'

export default function FamVerifyPage() {
  const queue = useFamVerificationQueue()
  const verify = useVerifyTenant()
  const { toast } = useToast()

  const rows = queue.data?.data ?? []

  const handleVerify = async (id: string, name: string) => {
    try {
      await verify.mutateAsync(id)
      toast({ title: 'Verified', description: `${name} is now verified.` })
    } catch (e) {
      toast({
        title: 'Could not verify',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Verification queue"
          sub={`${rows.length} tenant${rows.length === 1 ? '' : 's'} awaiting GST + PAN verification.`}
          right={<Pill tone="purple" dot>Sprint 3 · C5</Pill>}
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {queue.isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
              <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center' }}>
              <Icon.success size={28} style={{ opacity: 0.55 }} />
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 10 }}>All caught up.</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 4 }}>
                No tenants pending verification.
              </div>
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Legal name</th>
                  <th>GSTIN</th>
                  <th>PAN</th>
                  <th>Industry</th>
                  <th>Signed up</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/fam/tenants/${t.id}`} style={{ display: 'flex', gap: 11, textDecoration: 'none', color: 'inherit', alignItems: 'center' }}>
                        <Avatar name={t.name} size="sm" />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>{t.name}</div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>{t.slug}</div>
                        </div>
                      </Link>
                    </td>
                    <td style={{ fontSize: 12, fontWeight: 600 }}>{t.legalName ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>{t.gstin ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>{t.pan ?? '—'}</td>
                    <td style={{ fontSize: 12, fontWeight: 600 }}>{t.industry ?? '—'}</td>
                    <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>{timeAgo(t.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Btn
                        kind="primary"
                        size="sm"
                        icon={<Icon.check size={12} />}
                        onClick={() => handleVerify(t.id, t.name)}
                        disabled={verify.isPending}
                      >
                        {verify.isPending ? 'Verifying…' : 'Verify'}
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, fontSize: 11.5, color: 'var(--text-mute)' }}>
          <Icon.info size={12} style={{ display: 'inline-block', marginRight: 6, verticalAlign: '-1px' }} />
          Verifying sets tenants.verified_at and unlocks plan limits / billing actions for the workspace.
        </div>
      </div>
    </div>
  )
}
