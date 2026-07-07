'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Toggle } from '@/components/proto/Toggle'

/**
 * D14c — public mandate authorization page (PRD v4 §8A). The customer lands
 * here from the D15 email: plan summary → Authorize on the Razorpay-hosted
 * page. Public-invoice pattern: tokenized, unauthenticated, light/dark,
 * mobile-first (single ~420px column).
 */

interface PublicMandate {
  seller_name: string | null
  seller_logo_url: string | null
  customer_name: string | null
  subscription_name: string
  amount: string
  currency: string
  billing_period: string
  next_billing_date: string | null
  mandate_status: string
  authorize_url: string | null
}

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

export default function PublicMandatePage() {
  const params = useParams<{ token: string }>()
  const [data, setData] = useState<PublicMandate | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [light, setLight] = useState(false)

  useEffect(() => {
    if (!params?.token) return
    fetch(`${API}/api/v1/public/sub/${params.token}`)
      .then(async (r) => {
        const json = await r.json().catch(() => ({}))
        if (!r.ok) {
          setError({ status: r.status, message: json?.message ?? 'Something went wrong' })
          return
        }
        setData(json.data as PublicMandate)
      })
      .catch(() => setError({ status: 0, message: 'Could not reach the server — try again.' }))
  }, [params?.token])

  const bg = light ? '#f4f5f7' : '#01010D'
  const cardBg = light ? '#ffffff' : 'rgba(18,18,30,.98)'
  const text = light ? '#111827' : '#ffffff'
  const mute = light ? '#6b7280' : 'rgba(255,255,255,.55)'
  const bord = light ? '#e5e7eb' : 'rgba(255,255,255,.1)'

  const symbol = data?.currency === 'INR' ? '₹' : `${data?.currency ?? ''} `
  const cadence =
    data?.billing_period === 'annually'
      ? 'per year'
      : data?.billing_period === 'quarterly'
        ? 'per quarter'
        : 'per month'

  const statusView = (() => {
    if (!data) return null
    switch (data.mandate_status) {
      case 'pending_authorization':
        return null // the CTA below is the state
      case 'authorized':
      case 'active':
        return {
          icon: '✓',
          color: '#27D280',
          title: 'Auto-pay is active',
          body: 'This subscription is authorized — charges happen automatically, with an email notice at least 24 hours before each one.',
        }
      case 'revoked':
        return {
          icon: '✕',
          color: '#F8786B',
          title: 'This mandate was revoked',
          body: 'Automatic payments are off. The sender can issue a fresh authorization request if needed.',
        }
      default:
        return {
          icon: '·',
          color: mute,
          title: 'Nothing to authorize',
          body: 'This subscription is not collecting via auto-debit right now.',
        }
    }
  })()

  return (
    <div style={{ minHeight: '100vh', background: bg, color: text, padding: '0 0 64px', transition: 'background .2s' }}>
      {/* Slim top bar */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '14px 20px', maxWidth: 520, margin: '0 auto' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: mute }}>{light ? 'Light' : 'Dark'}</span>
        <Toggle on={light} onChange={setLight} />
      </div>

      <div style={{ maxWidth: 440, margin: '4vh auto 0', padding: '0 16px' }}>
        {error && (
          <div style={{ background: cardBg, border: `1px solid ${bord}`, borderRadius: 16, padding: '36px 28px', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>{error.status === 410 ? '⌛' : '🔍'}</div>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>
              {error.status === 410 ? 'Link expired' : error.status === 404 ? 'Link not found' : 'Something went wrong'}
            </div>
            <p style={{ fontSize: 13, color: mute, lineHeight: 1.6 }}>{error.message}</p>
          </div>
        )}

        {!error && !data && (
          <div style={{ background: cardBg, border: `1px solid ${bord}`, borderRadius: 16, padding: '48px 28px', textAlign: 'center', color: mute, fontSize: 13 }}>
            Loading…
          </div>
        )}

        {data && (
          <div style={{ background: cardBg, border: `1px solid ${bord}`, borderRadius: 16, overflow: 'hidden' }}>
            {/* Seller header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 24px', borderBottom: `1px solid ${bord}` }}>
              {data.seller_logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={data.seller_logo_url} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg,#3E7BFA,#9B7BFA)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800 }}>
                  {(data.seller_name ?? 'S')[0]}
                </div>
              )}
              <div>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{data.seller_name ?? 'Subscription'}</div>
                <div style={{ fontSize: 11, color: mute }}>requests automatic payments</div>
              </div>
            </div>

            {/* Plan summary */}
            <div style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: mute, marginBottom: 4 }}>
                  Subscription
                </div>
                <div style={{ fontSize: 17, fontWeight: 800 }}>{data.subscription_name}</div>
                {data.customer_name && (
                  <div style={{ fontSize: 12, color: mute, marginTop: 2 }}>for {data.customer_name}</div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em' }}>
                  {symbol}
                  {Number(data.amount).toLocaleString('en-IN')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: mute }}>{cadence}</span>
              </div>
              {data.next_billing_date && (
                <div style={{ fontSize: 12.5, color: mute }}>
                  First/next charge:{' '}
                  <strong style={{ color: text }}>
                    {new Date(`${data.next_billing_date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </strong>
                </div>
              )}

              {statusView ? (
                <div style={{ textAlign: 'center', padding: '18px 0 6px' }}>
                  <div style={{ width: 44, height: 44, borderRadius: '50%', margin: '0 auto 10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 800, color: statusView.color, border: `2px solid ${statusView.color}` }}>
                    {statusView.icon}
                  </div>
                  <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 4 }}>{statusView.title}</div>
                  <p style={{ fontSize: 12.5, color: mute, lineHeight: 1.6, margin: 0 }}>{statusView.body}</p>
                </div>
              ) : (
                <>
                  <a
                    href={data.authorize_url ?? '#'}
                    style={{
                      display: 'block',
                      textAlign: 'center',
                      padding: '13px 16px',
                      borderRadius: 12,
                      background: '#3E7BFA',
                      color: '#fff',
                      fontWeight: 800,
                      fontSize: 14,
                      textDecoration: 'none',
                      opacity: data.authorize_url ? 1 : 0.5,
                      pointerEvents: data.authorize_url ? 'auto' : 'none',
                    }}
                  >
                    Authorize with Razorpay
                  </a>
                  <p style={{ fontSize: 11.5, color: mute, lineHeight: 1.6, margin: 0, textAlign: 'center' }}>
                    One-time approval via UPI AutoPay or card. You'll get an email at least 24 hours
                    before every charge, and you can revoke anytime from your UPI/banking app.
                  </p>
                </>
              )}
            </div>

            <div style={{ padding: '12px 24px', borderTop: `1px solid ${bord}`, textAlign: 'center', fontSize: 11, color: mute }}>
              Powered by Flicks Suite · secured by Razorpay
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
