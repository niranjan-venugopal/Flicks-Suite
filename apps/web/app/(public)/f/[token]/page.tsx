'use client'

import { use, useEffect, useState } from 'react'

// ─────────────────────────────────────────────────────────
// C13 — Hosted public form (§5.2): dark, brandable capture
// page at /f/:token. Carries the signed render timestamp
// (min-fill-time), a honeypot field, and UTM params.
// ─────────────────────────────────────────────────────────

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

interface PublicForm {
  title: string
  intro: string | null
  fields: Array<{ key: string; label: string; type: string; required?: boolean }>
  tenant_name: string
  ts: string
  sig: string
}

export default function HostedFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [form, setForm] = useState<PublicForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [website, setWebsite] = useState('') // honeypot — humans never see it
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API}/api/v1/public/forms/${token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('This form is not available')
        const j = (await r.json()) as { data: PublicForm }
        setForm(j.data)
      })
      .catch((e: Error) => setError(e.message))
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form || busy) return
    setBusy(true)
    setError(null)
    try {
      const utm: Record<string, string> = {}
      new URLSearchParams(window.location.search).forEach((v, k) => {
        if (k.startsWith('utm_')) utm[k] = v
      })
      const r = await fetch(`${API}/api/v1/public/forms/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values, ts: form.ts, sig: form.sig, website, utm }),
      })
      const j = (await r.json()) as { data?: { ok: boolean; message: string; redirect_url: string | null }; message?: string }
      if (!r.ok) throw new Error(j.message ?? 'Something went wrong — try again')
      if (j.data?.redirect_url) {
        window.location.href = j.data.redirect_url
        return
      }
      setSuccess(j.data?.message ?? "Thanks — we'll be in touch")
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#01010D', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '44px 16px', fontFamily: 'var(--font-sans, system-ui)' }}>
      <div style={{ width: '100%', maxWidth: 460, borderRadius: 18, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.14)', padding: '30px 28px', boxShadow: '0 20px 50px rgba(0,0,0,.4)' }}>
        {error && !form ? (
          <div style={{ textAlign: 'center', padding: '26px 0 10px' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>Form unavailable</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,.5)' }}>{error}</div>
          </div>
        ) : !form ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'rgba(255,255,255,.5)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: '#3E7BFA', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 14 }}>
                {form.tenant_name.slice(0, 1).toUpperCase()}
              </div>
              <span style={{ fontSize: 15, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>{form.tenant_name}</span>
            </div>
            {success ? (
              <div style={{ textAlign: 'center', padding: '26px 0 10px' }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(39,210,128,.15)', color: '#27D280', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: 22 }}>✓</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>{success}</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,.5)', lineHeight: 1.6 }}>Someone from our team replies within one business day.</div>
              </div>
            ) : (
              <form onSubmit={(e) => void submit(e)}>
                <div style={{ fontSize: 19, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', marginBottom: 4 }}>{form.title}</div>
                {form.intro && <div style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,.5)', marginBottom: 18, lineHeight: 1.5 }}>{form.intro}</div>}
                {form.fields.map((f) => (
                  <div key={f.key} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'rgba(255,255,255,.5)', letterSpacing: '.04em', textTransform: 'uppercase', marginBottom: 5 }}>
                      {f.label}{f.required ? ' *' : ''}
                    </div>
                    {f.type === 'textarea' ? (
                      <textarea
                        required={f.required}
                        value={values[f.key] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        style={{ width: '100%', height: 84, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)', color: '#fff', padding: '10px 12px', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }}
                      />
                    ) : (
                      <input
                        type={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}
                        required={f.required}
                        value={values[f.key] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        style={{ width: '100%', height: 40, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)', color: '#fff', padding: '0 12px', fontSize: 13, fontFamily: 'inherit' }}
                      />
                    )}
                  </div>
                ))}
                {/* Honeypot — off-screen; bots fill it, humans never see it. */}
                <input
                  type="text"
                  name="website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
                />
                {error && <div style={{ fontSize: 12, fontWeight: 700, color: '#F8786B', marginBottom: 10 }}>{error}</div>}
                <button type="submit" disabled={busy}
                  style={{ width: '100%', height: 44, borderRadius: 10, background: '#3E7BFA', color: '#fff', border: 'none', fontSize: 13.5, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4, boxShadow: '0 8px 22px rgba(62,123,250,.35)', opacity: busy ? 0.7 : 1 }}>
                  {busy ? 'Sending…' : 'Submit'}
                </button>
                <div style={{ fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,.5)', textAlign: 'center', marginTop: 12 }}>
                  Protected against spam · powered by <b>Flicks Suite</b>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  )
}
