'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { create } from 'zustand'
import { Btn, Icon } from '@/components/proto'
import { useSubmitFeedback } from '@/lib/api/queries/use-feedback'

/**
 * D10/D10-R — the approved feedback panel, MENU-TRIGGERED only (no floating
 * pill anywhere). Opens bottom-right from the avatar menu or Settings entry;
 * categories Bug/Idea/Question/Other; ≤4000 chars; contact-ok checkbox;
 * submitting → success states. Absent on public/print (mounted in (app) only).
 */

interface FeedbackUiState {
  open: boolean
  setOpen: (v: boolean) => void
}
export const useFeedbackPanel = create<FeedbackUiState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

const CATS: Array<['bug' | 'idea' | 'question' | 'other', string]> = [
  ['bug', 'Bug'],
  ['idea', 'Idea'],
  ['question', 'Question'],
  ['other', 'Other'],
]

export function FeedbackPanel() {
  const { open, setOpen } = useFeedbackPanel()
  const pathname = usePathname()
  const submit = useSubmitFeedback()
  const [cat, setCat] = useState<'bug' | 'idea' | 'question' | 'other'>('idea')
  const [msg, setMsg] = useState('')
  const [contact, setContact] = useState(true)
  const [state, setState] = useState<'open' | 'submitting' | 'success' | 'error'>('open')
  const [errorText, setErrorText] = useState<string | null>(null)

  // Mounted only inside (app), but the panel state survives navigation — keep
  // it off print/PDF surfaces even if it was left open.
  if (!open || pathname?.includes('/print')) return null

  const doSubmit = async () => {
    setErrorText(null)
    setState('submitting')
    try {
      await submit.mutateAsync({
        category: cat,
        message: msg,
        contact_ok: contact,
        page_path: pathname ?? undefined,
      })
      setState('success')
      setMsg('')
    } catch (err) {
      // Surface the server's message (e.g. the 10/day limit) instead of
      // blaming the connection for every failure.
      setErrorText(err instanceof Error && err.message ? err.message : null)
      setState('error')
    }
  }

  const close = () => {
    setOpen(false)
    setState('open')
  }

  return (
    <div style={{ position: 'fixed', right: 16, bottom: 14, zIndex: 800 }}>
      <div
        style={{
          width: 330,
          background: 'rgba(18,18,30,.98)',
          backdropFilter: 'blur(16px)',
          border: '1px solid var(--bord-2)',
          borderRadius: 14,
          boxShadow: '0 28px 70px rgba(0,0,0,.6)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ color: 'var(--blue)' }}>
            <Icon.mail size={15} />
          </span>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 800 }}>Share feedback</span>
          <button
            onClick={close}
            style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <Icon.x size={12} />
          </button>
        </div>

        {(state === 'open' || state === 'submitting' || state === 'error') && (
          <div
            style={{
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              opacity: state === 'submitting' ? 0.6 : 1,
              pointerEvents: state === 'submitting' ? 'none' : 'auto',
            }}
          >
            {state === 'error' && (
              <div style={{ display: 'flex', gap: 9, padding: '9px 12px', borderRadius: 9, background: 'rgba(248,120,107,.08)', border: '1px solid rgba(248,120,107,.3)' }}>
                <Icon.warn size={14} style={{ color: 'var(--coral)', flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>
                  {errorText ?? 'Couldn’t send — check your connection and try again.'}
                </span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9 }}>
              {CATS.map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setCat(k)}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    borderRadius: 6,
                    border: 'none',
                    cursor: 'pointer',
                    background: cat === k ? 'var(--surf-3)' : 'transparent',
                    color: cat === k ? '#fff' : 'var(--text-2)',
                    fontSize: 11.5,
                    fontWeight: 800,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div>
              <textarea
                className="input"
                style={{ height: 92, padding: 11, resize: 'none', fontSize: 12, lineHeight: 1.55, width: '100%' }}
                placeholder="What's on your mind?"
                value={msg}
                maxLength={4000}
                onChange={(e) => setMsg(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <span style={{ fontSize: 9.5, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                  {msg.length.toLocaleString('en-IN')}/4,000
                </span>
              </div>
            </div>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 11.5, color: 'var(--text-2)', cursor: 'pointer', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={contact}
                onChange={(e) => setContact(e.target.checked)}
                style={{ marginTop: 2, accentColor: 'var(--blue)' }}
              />
              You can email me about this
            </label>
            <Btn
              kind="primary"
              size="sm"
              style={{
                width: '100%',
                justifyContent: 'center',
                ...(msg.trim() ? {} : { opacity: 0.45 }),
              }}
              icon={<Icon.send size={13} />}
              onClick={doSubmit}
              disabled={!msg.trim() || state === 'submitting'}
            >
              {state === 'submitting' ? 'Sending…' : 'Submit feedback'}
            </Btn>
          </div>
        )}

        {state === 'success' && (
          <div style={{ padding: '26px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(39,210,128,.14)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon.check size={20} />
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>Thanks — got it</div>
            <div className="t-mute" style={{ fontSize: 11.5, lineHeight: 1.5, maxWidth: 240 }}>
              Your note went straight to the team — we may follow up by email.
            </div>
            <Btn kind="ghost" size="sm" onClick={close}>
              Close
            </Btn>
          </div>
        )}
      </div>
    </div>
  )
}
