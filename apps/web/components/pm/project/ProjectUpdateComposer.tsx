'use client'

import { useState } from 'react'
import { Btn, Modal } from '@/components/proto'
import { Kbd, PM_HEALTH } from '@/components/pm/glyphs'
import { RichEditor } from '@/components/pm/editor'
import { api } from '@/lib/api/client'
import { useAttachmentsEnabled } from '@/lib/api/queries/use-pm-files'
import { modKey } from '@/lib/pm/files'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmUpdateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// Round M — the project-update composer (Linear's "New update" dialog):
// health picker seeded from the project's current health, the rich editor
// (plain textarea while the pm_attachments flag is off), Mod+Enter posts.
// Dual-mode like every project write: the engine mints an optimistic row
// (snapshot: null — the diff block appears on the ack) or REST posts and the
// caller refetches the detail.
// ─────────────────────────────────────────────────────────

type Health = PmUpdateRow['health']
const HEALTH_ORDER: Health[] = ['on_track', 'at_risk', 'off_track']

export interface ProjectUpdateComposerProps {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string
  engine: PmSyncEngine | null
  /** The project's current health — the picker's default. */
  currentHealth: Health
  /** REST mode: refetch the lazy detail after the POST lands. */
  invalidate: () => void
}

export function ProjectUpdateComposer({
  open,
  onClose,
  projectId,
  projectName,
  engine,
  currentHealth,
  invalidate,
}: ProjectUpdateComposerProps) {
  const [health, setHealth] = useState<Health>(currentHealth)
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)
  // REST mode: the server's reason when it refuses the post (400 on a body
  // that is empty once HTML is stripped, 403 for a guest seat, …). Shown
  // INLINE under the editor rather than as a toast: a toast sits behind the
  // modal scrim and fades, leaving the user in the dialog with no idea why
  // nothing happened. Cleared on the next keystroke.
  const [error, setError] = useState<string | null>(null)
  const { rich } = useAttachmentsEnabled()
  const mod = modKey()
  if (!open) return null

  const edit = (next: string) => {
    setBody(next)
    if (error) setError(null)
  }
  const canPost = body.trim().length > 0 && !posting
  const post = async () => {
    const md = body.trim()
    if (!md || posting) return
    if (engine) {
      engine.postProjectUpdate(projectId, health, md) // the page's onFlushed refetches on ack
      onClose()
      return
    }
    setPosting(true)
    setError(null)
    try {
      await api.post(`/api/v1/pm/projects/${projectId}/updates`, { health, body_md: md })
      invalidate()
      onClose()
    } catch (err) {
      // Keep the dialog and the text — a failed post must not be a silent
      // dead end (house rule 8).
      setError(err instanceof Error && err.message ? err.message : 'Could not post the update. Please try again.')
    } finally {
      setPosting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      title="Project update"
      sub={projectName}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" data-testid="update-submit" onClick={() => void post()} disabled={!canPost}>
            {posting ? 'Posting…' : 'Post update'}
            <Kbd style={{ marginLeft: 6, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>{mod}↵</Kbd>
          </Btn>
        </>
      }
    >
      {/* The proto Modal has no Escape handling of its own (IssueComposer wires
          it too); keydown from the textarea / ProseMirror bubbles to here. */}
      <div data-testid="update-composer" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
        <div className="label" style={{ marginBottom: 6 }}>Health</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {HEALTH_ORDER.map((k) => {
            const s = PM_HEALTH[k]!
            const active = health === k
            return (
              <button
                key={k}
                type="button"
                data-health={k}
                aria-pressed={active}
                onClick={() => setHealth(k)}
                style={{
                  flex: 1, height: 34, padding: '0 8px', borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  background: active ? s.bg : 'var(--surf-1)',
                  border: `1px solid ${active ? s.border : 'var(--bord)'}`,
                  color: active ? s.color : 'var(--text-2)',
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color, opacity: active ? 1 : 0.5 }} />
                {s.label}
              </button>
            )
          })}
        </div>
        <div className="label" style={{ marginBottom: 6 }}>Update</div>
        {rich ? (
          <RichEditor
            value={body}
            onChange={edit}
            onSubmit={() => void post()}
            placeholder="What changed, what's next, what's in the way…"
            minHeight={160}
            autoFocus
            testId="update-editor"
          />
        ) : (
          <textarea
            autoFocus
            className="input"
            data-testid="update-editor"
            value={body}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void post() }}
            placeholder="What changed, what's next, what's in the way…"
            style={{ width: '100%', minHeight: 160, resize: 'vertical', fontSize: 12.5, lineHeight: 1.6, padding: 10 }}
          />
        )}
        {error && (
          <div role="alert" data-testid="update-error" style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(248,120,107,.1)', border: '1px solid rgba(248,120,107,.35)', fontSize: 12, fontWeight: 700, color: 'var(--coral)' }}>
            {error}
          </div>
        )}
        <div className="pm-rich-hint" style={{ marginTop: 8 }}>
          Project members and the lead are notified in their Inbox. What changed since the last update is added automatically.
        </div>
      </div>
    </Modal>
  )
}
