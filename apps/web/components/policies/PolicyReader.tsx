'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Btn, Icon, Pill } from '@/components/proto'
import { RichView } from '@/components/pm/editor'
import { useToast } from '@/components/ui/use-toast'
import { APIError } from '@/lib/api/client'
import { useAcknowledgePolicy, type PolicyKind } from '@/lib/api/queries/use-policies'
import { formatDate } from '@/lib/utils'

/**
 * Round P (R3) — the employee-facing policy reader shared by the blocking
 * PolicyGate, the /policies page and the self-onboarding step.
 *
 * - Rich text renders through the PM RichView (TipTap, read-only — nothing
 *   user-authored reaches innerHTML).
 * - PDFs embed the 15-minute signed R2 URL in an <iframe>. Production CSP
 *   only allows the frame when NEXT_PUBLIC_FILES_FRAME_SRC names the bucket
 *   host (next.config.ts); when the browser blocks it we hear the
 *   `securitypolicyviolation` event and swap to a prominent "Open PDF"
 *   button instead. An "Open PDF" link (new tab) is ALWAYS visible.
 * - The agree checkbox only arms once the content has actually rendered
 *   (RichView mounted — or, if that chunk never reports in, a plain-text
 *   fallback of the markdown is painted first — / iframe loaded / PDF opened
 *   in the fallback), so a blank reader can never be signed. Known limit: a
 *   cross-origin iframe fires `load` for whatever document R2 answered with,
 *   so an expired/mis-signed URL's XML error page also arms the box; the
 *   always-visible "Open PDF" link and the 13-minute re-sign keep that window
 *   small, and the attestation is the member's, not the browser's.
 * - A PDF policy whose signed URL is unavailable (storage down / unconfigured
 *   → the API sends `file_url: null` rather than failing) can be read
 *   nowhere, so it is never *blocking*: see `isPolicyReadable` — the gate and
 *   the onboarding step skip it until the URL comes back.
 * - Any failure of /acknowledge that means "this policy moved on" (404 after
 *   archive / role change, any other 4xx) re-fetches the pending list so the
 *   caller drops it — a blocking gate must never dead-end on a policy that can
 *   no longer be agreed. A 5xx / network failure re-syncs after a short delay.
 */

export interface PolicyReaderPolicy {
  id: string
  title: string
  kind: PolicyKind
  version: number
  category?: string | null
  published_at?: string | null
  body_md: string | null
  file_url: string | null
}

/**
 * Can the member actually read this policy right now? Rich text always; a
 * PDF only when the API managed to sign its URL. Shared by the gate, the
 * onboarding step and the /policies page so an unreadable PDF never blocks
 * sign-in — it stays listed (and on HR's pending roster) until storage is
 * back and the next fetch carries a URL.
 */
export function isPolicyReadable(p: Pick<PolicyReaderPolicy, 'kind' | 'file_url'>): boolean {
  return !(p.kind === 'pdf' && !p.file_url)
}

export interface PolicyReaderProps {
  policy: PolicyReaderPolicy
  /** When set the agree row is replaced by an "Agreed on …" note. */
  acknowledgedAt?: string | null
  /** Hide the agree row entirely (preview / read-only surfaces). */
  readOnly?: boolean
  /**
   * Re-fetch the policy (fresh signed URL / current version). Called on an
   * iframe error, on a stale-version 409, and ~13 minutes in so the signed
   * URL never expires under an open reader.
   */
  onRefetch?: () => unknown
  /** Fired after the acknowledgement was recorded (or was already on file). */
  onAcknowledged?: (res: { policy_id: string; version: number; acknowledged_at: string }) => void
  /** Frame height for PDFs; rich text grows with its content. */
  frameHeight?: number | string
  /** Extra content above the agree row (e.g. the onboarding step's note). */
  footerNote?: ReactNode
  testId?: string
}

const POLICY_STALE_CODE = 'POLICY_VERSION_STALE'
// Signed URLs live 15 minutes; refresh a little before so "Open PDF" and the
// frame keep working for someone who left the reader open.
const SIGNED_URL_REFRESH_MS = 13 * 60_000
// If neither the RichView chunk nor the iframe reports in within this window:
// rich text paints a plain-text fallback of the markdown (and only THEN arms
// the checkbox); a PDF frame points the reader at the "Open PDF" link. A
// stuck loader must never leave the gate with no way forward — but the box
// never arms over an empty reader either.
const RENDER_FALLBACK_MS = 6_000
// After a 5xx / network failure of /acknowledge, re-sync the pending list a
// moment later so a transient outage heals without a reload.
const ACK_FAILURE_RESYNC_MS = 3_000

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

export function PolicyReader({
  policy,
  acknowledgedAt,
  readOnly,
  onRefetch,
  onAcknowledged,
  frameHeight = 'min(560px, 62vh)',
  footerNote,
  testId,
}: PolicyReaderProps) {
  const { toast } = useToast()
  const ack = useAcknowledgePolicy()
  const [agree, setAgree] = useState(false)
  const [rendered, setRendered] = useState(false)
  // Rich text only: the RichView chunk never mounted within the grace window
  // → paint the (server-cleaned) markdown as plain text instead, so the
  // checkbox arms over visible content, never over an empty box.
  const [richFallback, setRichFallback] = useState(false)
  // PDF only: the browser refused the frame (CSP) or the frame errored →
  // the frame is replaced by the prominent "Open PDF" fallback.
  const [frameBlocked, setFrameBlocked] = useState(false)
  // PDF only: no load within the grace window → keep the frame, but point at
  // the link so a slow preview never strands the reader.
  const [frameSlow, setFrameSlow] = useState(false)
  // PDF: the reader opened the file in a new tab → content "seen".
  const [openedExternally, setOpenedExternally] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const frameBlockedRef = useRef(false)
  const onRefetchRef = useRef(onRefetch)
  onRefetchRef.current = onRefetch
  const resyncTimerRef = useRef<number | null>(null)

  const isPdf = policy.kind === 'pdf'
  const fileUrl = policy.file_url
  const bodyMd = policy.body_md ?? ''
  const pdfUnavailable = isPdf && !fileUrl

  // Never leave a pending re-sync timer behind an unmounted reader.
  useEffect(
    () => () => {
      if (resyncTimerRef.current !== null) window.clearTimeout(resyncTimerRef.current)
    },
    [],
  )

  const markBlocked = () => {
    frameBlockedRef.current = true
    setFrameBlocked(true)
    // A CSP-refused frame still fires `load` (on its error page) in Chromium;
    // never let that count as the document having rendered.
    setRendered(false)
  }

  // A new version / a different policy resets everything: the previous
  // agreement never carries over.
  useEffect(() => {
    setAgree(false)
    setRendered(false)
    setRichFallback(false)
    setFrameSlow(false)
    setOpenedExternally(false)
    frameBlockedRef.current = false
    setFrameBlocked(false)
  }, [policy.id, policy.version])

  // Rich text: "rendered" = the RichView chunk mounted its `.pm-rich` root
  // (the dynamic import loads on first use). Observe the wrapper until it
  // appears; an empty body counts as rendered (nothing to wait for). If the
  // chunk never reports in, switch to the plain-text fallback — which is
  // visible content — and arm from there.
  useEffect(() => {
    if (isPdf || richFallback) return
    if (!bodyMd.trim()) {
      setRendered(true)
      return
    }
    const host = bodyRef.current
    if (!host) return
    if (host.querySelector('.pm-rich')) {
      setRendered(true)
      return
    }
    const observer = new MutationObserver(() => {
      if (host.querySelector('.pm-rich')) {
        setRendered(true)
        observer.disconnect()
      }
    })
    observer.observe(host, { childList: true, subtree: true })
    const fallback = window.setTimeout(() => {
      setRichFallback(true)
      setRendered(true)
    }, RENDER_FALLBACK_MS)
    return () => {
      observer.disconnect()
      window.clearTimeout(fallback)
    }
  }, [isPdf, richFallback, bodyMd, policy.id, policy.version])

  // PDF: a CSP frame-src refusal never reaches the iframe's onError — the
  // document-level violation event is the only reliable signal.
  useEffect(() => {
    if (!isPdf || !fileUrl) return
    const handler = (e: SecurityPolicyViolationEvent) => {
      const directive = e.effectiveDirective || e.violatedDirective || ''
      if (!directive.startsWith('frame-src') && !directive.startsWith('child-src')) return
      if (e.blockedURI && !sameOrigin(e.blockedURI, fileUrl) && e.blockedURI !== fileUrl) return
      markBlocked()
    }
    document.addEventListener('securitypolicyviolation', handler)
    return () => document.removeEventListener('securitypolicyviolation', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPdf, fileUrl])

  // PDF: nothing reported within the grace window → keep the frame but make
  // the link the obvious path (opening it counts as having read the policy).
  useEffect(() => {
    if (!isPdf || !fileUrl || rendered || frameBlocked) return
    const t = window.setTimeout(() => setFrameSlow(true), RENDER_FALLBACK_MS)
    return () => window.clearTimeout(t)
  }, [isPdf, fileUrl, rendered, frameBlocked])

  // Keep the signed URL fresh while the reader stays open.
  useEffect(() => {
    if (!isPdf || !fileUrl || !onRefetchRef.current) return
    const t = window.setTimeout(() => void onRefetchRef.current?.(), SIGNED_URL_REFRESH_MS)
    return () => window.clearTimeout(t)
  }, [isPdf, fileUrl])

  // Opening the PDF in a new tab always counts as having seen it — whether
  // the frame was blocked, slow, or simply ignored in favour of the tab.
  const contentSeen = isPdf ? rendered || openedExternally : rendered
  const canAgree = contentSeen && agree && !ack.isPending

  const submit = async () => {
    if (!canAgree) return
    try {
      const res = await ack.mutateAsync({ id: policy.id, version: policy.version })
      onAcknowledged?.(res.data)
    } catch (err) {
      const status = err instanceof APIError ? err.status : 0
      const code =
        err instanceof APIError && err.data && typeof err.data === 'object'
          ? (err.data as { code?: string }).code
          : undefined
      // 409 from /acknowledge only ever means "version moved on"; honour the
      // code when the body parsed, fall back to the status when it didn't.
      if (status === 409 && (!code || code === POLICY_STALE_CODE)) {
        toast({
          title: 'This policy was updated',
          description: 'Please read the new version and agree again.',
          variant: 'destructive',
        })
        setAgree(false)
        void onRefetchRef.current?.()
        return
      }
      // 404 = archived, un-published, re-targeted to other roles, or the
      // seat was deactivated while the reader was open. Nothing left to
      // agree to — re-sync so the gate / list drops it instead of showing
      // an "Agree" that can never succeed.
      if (status === 404) {
        toast({
          title: 'This policy is no longer active',
          description: 'It was archived or no longer applies to you — nothing more to agree to.',
        })
        setAgree(false)
        void onRefetchRef.current?.()
        return
      }
      // Any other 4xx (400 validation, 403): the pending list moved on in a
      // way we did not anticipate — re-sync it rather than freeze.
      if (status >= 400 && status < 500) {
        toast({
          title: 'Could not record your agreement',
          description: err instanceof Error ? err.message : 'Please try again',
          variant: 'destructive',
        })
        setAgree(false)
        void onRefetchRef.current?.()
        return
      }
      // 5xx / network: keep the reader as it is (the member can retry) and
      // re-sync a moment later so a brief outage heals without a reload.
      toast({
        title: 'Could not record your agreement',
        description: err instanceof Error ? err.message : 'Please try again',
        variant: 'destructive',
      })
      if (onRefetchRef.current) {
        if (resyncTimerRef.current !== null) window.clearTimeout(resyncTimerRef.current)
        resyncTimerRef.current = window.setTimeout(() => {
          resyncTimerRef.current = null
          void onRefetchRef.current?.()
        }, ACK_FAILURE_RESYNC_MS)
      }
    }
  }

  const openPdf = () => setOpenedExternally(true)

  return (
    <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header: title + meta + the always-visible Open PDF link */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.25 }}>
            {policy.title}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8,
              marginTop: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--text-mute)',
            }}
          >
            <Pill tone={isPdf ? 'purple' : 'blue'}>{isPdf ? 'PDF' : 'Policy'}</Pill>
            <span style={{ fontFamily: 'var(--font-mono)' }}>v{policy.version}</span>
            {policy.category && <span>· {policy.category}</span>}
            {policy.published_at && <span>· Published {formatDate(policy.published_at)}</span>}
          </div>
        </div>
        {isPdf && fileUrl && (
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={openPdf}
            data-testid="policy-open-pdf"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--blue)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              marginTop: 2,
            }}
          >
            <Icon.out size={13} /> Open PDF
          </a>
        )}
      </div>

      {/* Body */}
      <div
        ref={bodyRef}
        style={{
          border: '1px solid var(--bord)',
          borderRadius: 12,
          background: 'var(--surf-1)',
          overflow: 'hidden',
        }}
      >
        {isPdf ? (
          !fileUrl ? (
            <EmptyBody>
              <div style={{ color: 'var(--text-2)', fontWeight: 800 }}>
                The PDF for this policy isn&apos;t available right now.
              </div>
              <div style={{ marginTop: 4 }}>
                You can&apos;t agree to a policy you can&apos;t read — try again in a moment, or
                ask HR to re-upload the file. It stays listed under Policies until then.
              </div>
              {onRefetch && (
                <div style={{ marginTop: 10 }}>
                  <Btn size="sm" icon={<Icon.refresh size={12} />} onClick={() => void onRefetch()}>
                    Try again
                  </Btn>
                </div>
              )}
            </EmptyBody>
          ) : frameBlocked ? (
            <div
              style={{
                padding: '34px 20px',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: 'var(--surf-2)',
                  color: 'var(--text-mute)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon.file size={20} />
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 800 }}>Open the PDF to read this policy</div>
              <div className="t-mute" style={{ fontSize: 12, maxWidth: 380, lineHeight: 1.55 }}>
                This browser can&apos;t preview the document inline. It opens in a new tab —
                come back here to agree once you&apos;ve read it.
              </div>
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={openPdf}
                className="btn btn-primary"
                data-testid="policy-open-pdf-fallback"
                style={{ marginTop: 4, textDecoration: 'none' }}
              >
                <Icon.out size={14} /> Open PDF
              </a>
              {openedExternally && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: 'var(--green)',
                  }}
                >
                  <Icon.check size={12} /> Opened — you can agree below
                </div>
              )}
            </div>
          ) : (
            <>
              <iframe
                key={fileUrl}
                src={fileUrl}
                title={policy.title}
                referrerPolicy="no-referrer"
                onLoad={() => {
                  if (!frameBlockedRef.current) setRendered(true)
                }}
                onError={() => {
                  markBlocked()
                  void onRefetchRef.current?.()
                }}
                data-testid="policy-pdf-frame"
                style={{
                  display: 'block',
                  width: '100%',
                  height: frameHeight,
                  border: 'none',
                  background: '#fff',
                }}
              />
              {frameSlow && !rendered && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '10px 14px',
                    borderTop: '1px solid var(--bord)',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-mute)',
                  }}
                >
                  <span>Preview taking a while? Open the PDF in a new tab instead.</span>
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={openPdf}
                    className="btn btn-secondary btn-sm"
                    style={{ textDecoration: 'none', flexShrink: 0 }}
                  >
                    <Icon.out size={12} /> Open PDF
                  </a>
                </div>
              )}
            </>
          )
        ) : richFallback ? (
          // The RichView chunk never mounted: show the server-cleaned
          // markdown as plain text so the member still reads the actual
          // policy before the checkbox arms.
          <pre
            data-testid="policy-body-fallback"
            style={{
              margin: 0,
              padding: '18px 20px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--text-2)',
            }}
          >
            {bodyMd}
          </pre>
        ) : (
          <div style={{ padding: '18px 20px' }}>
            <RichView
              value={bodyMd}
              testId="policy-body"
              empty={<span className="t-mute">This policy has no content yet.</span>}
            />
          </div>
        )}
      </div>

      {footerNote}

      {/* Agree row */}
      {!readOnly && (
        acknowledgedAt ? (
          <div
            data-testid="policy-agreed"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 13px',
              borderRadius: 10,
              background: 'rgb(var(--green-rgb) / 0.07)',
              border: '1px solid rgb(var(--green-rgb) / 0.25)',
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--text-2)',
            }}
          >
            <Icon.check size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
            Agreed on {formatDate(acknowledgedAt)}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                fontSize: 12.5,
                color: contentSeen ? 'var(--text-2)' : 'var(--text-mute)',
                lineHeight: 1.5,
                cursor: contentSeen ? 'pointer' : 'not-allowed',
                padding: '11px 13px',
                borderRadius: 10,
                background: 'var(--surf-1)',
                border: '1px solid var(--bord)',
                opacity: contentSeen ? 1 : 0.7,
              }}
            >
              <input
                type="checkbox"
                checked={agree}
                disabled={!contentSeen}
                onChange={(e) => setAgree(e.target.checked)}
                data-testid="policy-agree-checkbox"
                style={{ marginTop: 2, accentColor: 'var(--blue)', flexShrink: 0 }}
              />
              <span>
                I have read and agree to <strong style={{ color: 'var(--text)' }}>{policy.title}</strong>{' '}
                (v{policy.version})
              </span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Btn
                kind="primary"
                onClick={submit}
                disabled={!canAgree}
                data-testid="policy-agree-btn"
                icon={<Icon.check size={14} />}
              >
                {ack.isPending ? 'Saving…' : 'Agree'}
              </Btn>
              {!contentSeen && (
                <span className="t-mute" style={{ fontSize: 11.5 }} data-testid="policy-agree-hint">
                  {pdfUnavailable
                    ? 'The PDF is temporarily unavailable — try again, or ask HR.'
                    : isPdf && (frameBlocked || frameSlow)
                      ? 'Open the PDF first, then agree.'
                      : 'Loading the policy…'}
                </span>
              )}
            </div>
          </div>
        )
      )}
    </div>
  )
}

function EmptyBody({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '34px 20px',
        textAlign: 'center',
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--text-mute)',
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  )
}
