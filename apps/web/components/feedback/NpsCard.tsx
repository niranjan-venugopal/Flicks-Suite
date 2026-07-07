'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { useNpsEligibility, useNpsRespond } from '@/lib/api/queries/use-feedback'
import { useAuthStore } from '@/lib/stores/auth.store'

/**
 * D11 — NPS micro-card (PRD v4 §7.2). Shows only when the server says the
 * user is eligible (age/activity/tenant gates; one response per survey key).
 * 0–10 → optional comment → thanks. Later = 14-day snooze; × = permanent
 * dismiss. Bottom-left so it never collides with the feedback panel.
 */
export function NpsCard() {
  const { currentUser } = useAuthStore()
  const { toast } = useToast()
  const pathname = usePathname()
  const eligibility = useNpsEligibility(!!currentUser?.id)
  const respond = useNpsRespond()
  const [step, setStep] = useState<'prompt' | 'comment' | 'thanks' | 'hidden'>('prompt')
  const [score, setScore] = useState<number | null>(null)
  const [comment, setComment] = useState('')

  // The answer invalidates eligibility (now false) — the thanks step must
  // survive that refetch, then auto-hide.
  useEffect(() => {
    if (step !== 'thanks') return
    const t = setTimeout(() => setStep('hidden'), 4000)
    return () => clearTimeout(t)
  }, [step])

  const dismissed = step === 'hidden'
  const showThanks = step === 'thanks'
  if (dismissed || pathname?.includes('/print')) return null
  if (!showThanks && !eligibility.data?.data?.eligible) return null

  const finish = async (action: 'answer' | 'snooze' | 'dismiss') => {
    try {
      await respond.mutateAsync({
        action,
        score: action === 'answer' ? (score ?? undefined) : undefined,
        comment: action === 'answer' && comment.trim() ? comment : undefined,
      })
      // Only claim success when the server actually recorded it.
      if (action === 'answer') setStep('thanks')
      else setStep('hidden')
    } catch (err) {
      if (action === 'answer') {
        // Keep the card so the response isn't silently lost.
        toast({
          title: 'Could not record your response',
          description: err instanceof Error ? err.message : 'Please try again.',
          variant: 'destructive',
        })
      } else {
        // Snooze/dismiss failures still hide for this session — never trap
        // the user with a card they tried to close.
        setStep('hidden')
      }
    }
  }

  return (
    <div style={{ position: 'fixed', left: 16, bottom: 14, zIndex: 790 }}>
      <div
        style={{
          width: 352,
          background: 'rgba(18,18,30,.98)',
          border: '1px solid var(--bord-2)',
          borderRadius: 14,
          boxShadow: '0 28px 70px rgba(0,0,0,.6)',
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
          <span style={{ color: 'var(--purple)', marginTop: 1 }}>
            <Icon.star size={16} />
          </span>
          <div style={{ flex: 1, fontSize: 12.5, fontWeight: 800, lineHeight: 1.45 }}>
            How likely are you to recommend Flicks Suite to a colleague?
          </div>
          <button
            onClick={() => finish('dismiss')}
            title="Dismiss — never asks again"
            style={{ width: 22, height: 22, borderRadius: 6, background: 'transparent', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <Icon.x size={13} />
          </button>
        </div>

        {step === 'prompt' && (
          <>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              {[...Array(11)].map((_, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setScore(i)
                    setStep('comment')
                  }}
                  style={{
                    flex: 1,
                    height: 30,
                    borderRadius: 7,
                    border: '1px solid var(--bord)',
                    background: 'var(--surf-1)',
                    color: 'var(--text-2)',
                    fontSize: 11.5,
                    fontWeight: 800,
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {i}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)', marginBottom: 12 }}>
              <span>Not likely</span>
              <span>Extremely likely</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => finish('snooze')}
                style={{ background: 'none', border: 'none', color: 'var(--text-mute)', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }}
              >
                Later
              </button>
            </div>
          </>
        )}

        {step === 'comment' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--blue)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                {score ?? 0}
              </span>
              <span className="t-mute" style={{ fontSize: 11.5, fontWeight: 700 }}>
                Thanks! One optional question —
              </span>
            </div>
            <textarea
              className="input"
              style={{ height: 70, padding: 10, resize: 'none', fontSize: 12, marginBottom: 10, width: '100%' }}
              placeholder="What's the main reason for your score?"
              value={comment}
              maxLength={2000}
              onChange={(e) => setComment(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn kind="ghost" size="sm" onClick={() => finish('answer')} disabled={respond.isPending}>
                Skip
              </Btn>
              <Btn kind="primary" size="sm" onClick={() => finish('answer')} disabled={respond.isPending}>
                {respond.isPending ? 'Sending…' : 'Send'}
              </Btn>
            </div>
          </>
        )}

        {step === 'thanks' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '10px 0 4px', textAlign: 'center' }}>
            <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'rgba(39,210,128,.14)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon.check size={18} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>Thank you!</div>
            <div className="t-mute" style={{ fontSize: 11 }}>
              Your response shapes what we build next.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
