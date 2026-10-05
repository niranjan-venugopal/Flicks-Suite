'use client'

import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Modal, Pill, Toggle } from '@/components/proto'
import { RichEditor } from '@/components/pm/editor'
import { useToast } from '@/components/ui/use-toast'
import { api } from '@/lib/api/client'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  formatFileSize,
  policyAudienceLabel,
  useArchivePolicy,
  usePublishPolicy,
  useUpdatePolicy,
  useUploadPolicyFile,
  type PolicyDetail,
  type PolicyKind,
  type PolicyTargetRole,
  type UpdatePolicyPayload,
} from '@/lib/api/queries/use-policies'

// ─────────────────────────────────────────────────────────
// Round P R3 — the policy editor card (Settings → Policies → one policy).
// Title · category · kind toggle ("Write it here" | "Upload a PDF") · the PM
// RichEditor (markdown in / markdown out) or a PDF drop zone · "Employees
// must agree" Toggle · applies-to role chips · Save (PATCH) / Publish
// (confirm Modal; "Ask everyone to agree again" when already published) /
// Archive (confirm). A view-only grant renders every control disabled;
// an archived policy is read-only for everyone.
// ─────────────────────────────────────────────────────────

export const PDF_MAX_BYTES = 10 * 1024 * 1024

/**
 * The audience chips. Each chip is a role SET so "Admins + HR admins" is one
 * click; "All" clears the selection (null = every standard role server-side).
 * Labels follow POLICY_TARGET_ROLE_LABELS (the owner role is displayed as
 * "Admin" app-wide) so the chip and the captions it produces agree.
 */
const AUDIENCE_CHIPS: Array<{ key: string; label: string; roles: PolicyTargetRole[] }> = [
  { key: 'managers', label: 'Managers', roles: ['manager'] },
  { key: 'employees', label: 'Employees', roles: ['employee'] },
  { key: 'finance', label: 'Finance', roles: ['finance'] },
  { key: 'owners-hr', label: 'Admins + HR admins', roles: ['owner', 'admin'] },
]

/** Web (UPPERCASE) role → the API membership role a policy targets. */
const WEB_ROLE_TO_TARGET: Partial<Record<string, PolicyTargetRole>> = {
  OWNER: 'owner',
  HR_ADMIN: 'admin',
  MANAGER: 'manager',
  FINANCE: 'finance',
  EMPLOYEE: 'employee',
}

interface FormState {
  title: string
  category: string
  kind: PolicyKind
  body_md: string
  requires_acknowledgement: boolean
  /** Sorted, de-duplicated; [] = everyone. */
  applies_to_roles: PolicyTargetRole[]
}

function normaliseRoles(roles: string[] | null | undefined): PolicyTargetRole[] {
  const allowed: PolicyTargetRole[] = ['owner', 'admin', 'manager', 'finance', 'employee']
  return allowed.filter((r) => (roles ?? []).includes(r))
}

function toForm(p: PolicyDetail): FormState {
  return {
    title: p.title ?? '',
    category: p.category ?? '',
    kind: p.kind,
    body_md: p.body_md ?? '',
    requires_acknowledgement: p.requires_acknowledgement,
    applies_to_roles: normaliseRoles(p.applies_to_roles),
  }
}

function sameRoles(a: PolicyTargetRole[], b: PolicyTargetRole[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i])
}

function isDirty(form: FormState, base: FormState): boolean {
  return (
    form.title !== base.title ||
    form.category !== base.category ||
    form.kind !== base.kind ||
    form.body_md !== base.body_md ||
    form.requires_acknowledgement !== base.requires_acknowledgement ||
    !sameRoles(form.applies_to_roles, base.applies_to_roles)
  )
}

/** Only the fields that changed — the API audit log diffs before/after. */
function diffPayload(form: FormState, base: FormState): UpdatePolicyPayload {
  const out: UpdatePolicyPayload = {}
  if (form.title !== base.title) out.title = form.title.trim()
  if (form.category !== base.category) out.category = form.category.trim() || null
  if (form.kind !== base.kind) out.kind = form.kind
  if (form.body_md !== base.body_md) out.body_md = form.body_md
  if (form.requires_acknowledgement !== base.requires_acknowledgement)
    out.requires_acknowledgement = form.requires_acknowledgement
  if (!sameRoles(form.applies_to_roles, base.applies_to_roles))
    out.applies_to_roles = form.applies_to_roles.length ? form.applies_to_roles : null
  return out
}

export function policyStatusPill(status: PolicyDetail['status']) {
  if (status === 'published') return <Pill tone="green" dot>Published</Pill>
  if (status === 'archived') return <Pill tone="purple" dot>Archived</Pill>
  return <Pill dot>Draft</Pill>
}

export function policyKindPill(kind: PolicyKind) {
  return kind === 'pdf' ? (
    <Pill tone="coral" icon={<Icon.file size={11} />}>PDF</Pill>
  ) : (
    <Pill tone="blue" icon={<Icon.edit size={11} />}>Rich text</Pill>
  )
}

export interface PolicyEditorProps {
  policy: PolicyDetail
  canEdit: boolean
}

export function PolicyEditor({ policy, canEdit }: PolicyEditorProps) {
  const router = useRouter()
  const qc = useQueryClient()
  const { toast } = useToast()
  const myRole = useAuthStore((s) => s.currentUser?.role)
  const update = useUpdatePolicy()
  const upload = useUploadPolicyFile(policy.id)
  const publish = usePublishPolicy()
  const archive = useArchivePolicy()

  const archived = policy.status === 'archived'
  const editable = canEdit && !archived

  const [form, setForm] = useState<FormState>(() => toForm(policy))
  const baselineRef = useRef<FormState>(toForm(policy))
  const [baseline, setBaseline] = useState<FormState>(baselineRef.current)

  // Server echo (after Save / upload / publish / a background refetch): the
  // baseline always follows the server; the form follows it only when the
  // person is not mid-edit — a PDF upload that lands while the title is being
  // retyped must not throw those keystrokes away. Save() resets the form to
  // the server's copy itself (cleanMarkdown may normalise the body).
  useEffect(() => {
    const next = toForm(policy)
    const prevBase = baselineRef.current
    baselineRef.current = next
    setBaseline(next)
    setForm((prev) => (isDirty(prev, prevBase) ? prev : next))
  }, [policy])

  const dirty = useMemo(() => isDirty(form, baseline), [form, baseline])
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((p) => ({ ...p, [key]: value }))

  // ── Audience chips ──────────────────────────────────────────────────────
  const everyone = form.applies_to_roles.length === 0
  const chipOn = (roles: PolicyTargetRole[]) => roles.every((r) => form.applies_to_roles.includes(r))
  const toggleChip = (roles: PolicyTargetRole[]) => {
    if (!editable) return
    const on = chipOn(roles)
    const next = on
      ? form.applies_to_roles.filter((r) => !roles.includes(r))
      : [...form.applies_to_roles, ...roles]
    set('applies_to_roles', normaliseRoles(next))
  }

  // ── Content checks (shared by Save-on-published and Publish) ───────────
  // A PDF policy needs its file; a rich-text one needs some body. Publish
  // always checks; Save checks only for a PUBLISHED policy, because saving
  // an empty kind there would leave a live, agreement-required policy with
  // nothing to read (the gate would then present an empty page to sign).
  const contentProblem = (): { title: string; description: string } | null => {
    if (form.kind === 'pdf' && !policy.file_name)
      return { title: 'Upload the PDF first', description: 'A PDF policy needs its file before it can be published.' }
    if (form.kind === 'rich_text' && !form.body_md.trim())
      return { title: 'Write the policy first', description: 'A rich-text policy needs some content before it can be published.' }
    return null
  }

  // ── Save ────────────────────────────────────────────────────────────────
  const save = async (): Promise<PolicyDetail | null> => {
    if (!form.title.trim()) {
      toast({ title: 'Give the policy a title', variant: 'destructive' })
      return null
    }
    if (policy.status === 'published') {
      const problem = contentProblem()
      if (problem) {
        toast({ ...problem, description: `${problem.description} This policy is live, so it cannot be saved without content.`, variant: 'destructive' })
        return null
      }
    }
    const payload = diffPayload(form, baseline)
    if (Object.keys(payload).length === 0) return policy
    try {
      const res = await update.mutateAsync({ id: policy.id, payload })
      // Adopt the server's copy outright: the body comes back through
      // cleanMarkdown, so comparing against what the editor emitted would
      // leave a phantom "Unsaved changes".
      const next = toForm(res.data)
      baselineRef.current = next
      setBaseline(next)
      setForm(next)
      return res.data
    } catch (err) {
      toast({
        title: 'Could not save',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
      return null
    }
  }

  const onSave = async () => {
    const saved = await save()
    if (saved) toast({ title: 'Policy saved', description: saved.title })
  }

  // ── PDF upload ──────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  const pickFile = async (file: File | null | undefined) => {
    if (!file || !editable) return
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    if (!isPdf) {
      toast({ title: 'PDF only', description: 'Pick a .pdf file — other formats are not accepted.', variant: 'destructive' })
      return
    }
    if (file.size > PDF_MAX_BYTES) {
      toast({ title: 'File too large', description: 'The PDF must be 10 MB or smaller.', variant: 'destructive' })
      return
    }
    try {
      const res = await upload.mutateAsync(file)
      // The server flips kind to 'pdf' on upload — mirror it locally so the
      // Save diff never tries to flip it back.
      setForm((p) => ({ ...p, kind: 'pdf' }))
      toast({ title: 'PDF uploaded', description: res.data.file_name ?? file.name })
    } catch (err) {
      toast({
        title: 'Upload failed',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    void pickFile(e.dataTransfer?.files?.[0])
  }

  // "Open" the PDF. The detail's file_url is a 15-minute signed link and the
  // editor is a long-lived page with no focus refetch, so the cached one may
  // have expired. Open the tab synchronously (popup blockers want the user
  // gesture), fetch a fresh detail, then point the tab at the fresh URL.
  const [opening, setOpening] = useState(false)
  const openPdf = async (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (opening) return
    const win = window.open('about:blank', '_blank')
    if (win) win.opener = null
    setOpening(true)
    try {
      const fresh = await api.get<{ data: PolicyDetail }>(`/api/v1/policies/${policy.id}`)
      qc.setQueryData(['policies', 'detail', policy.id], fresh)
      const url = fresh.data.file_url
      if (!url) throw new Error('The PDF link is not available right now — try again in a moment.')
      if (win) win.location.href = url
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      win?.close()
      toast({
        title: 'Could not open the PDF',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setOpening(false)
    }
  }

  // ── Publish ─────────────────────────────────────────────────────────────
  const [publishOpen, setPublishOpen] = useState(false)
  const [reack, setReack] = useState(false)
  const alreadyPublished = policy.status === 'published'
  // The publisher is part of the audience too (the API only leaves them out
  // of the notifications), so the blocking gate appears for them right after
  // Publish — say so, or HR reads it as a bug.
  const myTarget = myRole ? WEB_ROLE_TO_TARGET[myRole] : undefined
  const includesMe =
    form.requires_acknowledgement &&
    !!myTarget &&
    (everyone || form.applies_to_roles.includes(myTarget))

  const openPublish = () => {
    const problem = contentProblem()
    if (problem) {
      toast({ ...problem, variant: 'destructive' })
      return
    }
    setReack(false)
    setPublishOpen(true)
  }

  const confirmPublish = async () => {
    if (dirty) {
      const saved = await save()
      if (!saved) return
    }
    try {
      const res = await publish.mutateAsync({
        id: policy.id,
        ...(alreadyPublished ? { require_reacknowledgement: reack } : {}),
      })
      setPublishOpen(false)
      const who = res.notified === 1 ? '1 person notified' : `${res.notified} people notified`
      toast({
        title: alreadyPublished
          ? reack
            ? `Re-published as v${res.data.version} — everyone must agree again`
            : 'Re-published under the same version'
          : 'Policy published',
        description: res.data.requires_acknowledgement ? who : 'No acknowledgement required.',
      })
    } catch (err) {
      toast({
        title: 'Could not publish',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  // ── Archive ─────────────────────────────────────────────────────────────
  const [archiveOpen, setArchiveOpen] = useState(false)
  const confirmArchive = async () => {
    try {
      await archive.mutateAsync(policy.id)
      setArchiveOpen(false)
      toast({ title: 'Policy archived', description: `${policy.title} no longer appears in anyone's pending list.` })
      router.push('/settings/policies')
    } catch (err) {
      toast({
        title: 'Could not archive',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const busy = update.isPending || publish.isPending || archive.isPending || upload.isPending

  return (
    <>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Title + category */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 14 }}>
          <div>
            <label className="label" htmlFor="policy-title">Title</label>
            <input
              id="policy-title"
              className="input"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Leave & attendance policy"
              maxLength={200}
              disabled={!editable}
              autoFocus={editable && policy.status === 'draft' && policy.title === 'Untitled policy'}
              onFocus={(e) => {
                if (policy.title === 'Untitled policy' && form.title === 'Untitled policy') e.currentTarget.select()
              }}
            />
          </div>
          <div>
            <label className="label" htmlFor="policy-category">Category</label>
            <input
              id="policy-category"
              className="input"
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              placeholder="HR · IT · Conduct"
              maxLength={60}
              disabled={!editable}
            />
          </div>
        </div>

        {/* Kind toggle */}
        <div>
          <div className="label">Content</div>
          <div
            role="tablist"
            aria-label="Policy content type"
            style={{
              display: 'inline-flex',
              gap: 4,
              padding: 3,
              background: 'var(--surf-1)',
              border: '1px solid var(--bord)',
              borderRadius: 10,
            }}
          >
            {(
              [
                ['rich_text', 'Write it here', <Icon.edit key="e" size={13} />],
                ['pdf', 'Upload a PDF', <Icon.file key="f" size={13} />],
              ] as const
            ).map(([k, label, icon]) => {
              const on = form.kind === k
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  disabled={!editable}
                  onClick={() => set('kind', k)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '7px 13px',
                    borderRadius: 7,
                    border: 'none',
                    cursor: editable ? 'pointer' : 'default',
                    background: on ? 'var(--surf-3)' : 'transparent',
                    color: on ? 'var(--text)' : 'var(--text-2)',
                    fontSize: 12,
                    fontWeight: 800,
                    opacity: !editable && !on ? 0.5 : 1,
                  }}
                >
                  {icon}
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Body */}
        {form.kind === 'rich_text' ? (
          <div>
            <RichEditor
              value={form.body_md}
              onChange={(md) => set('body_md', md)}
              placeholder="Write the policy. Headings, lists and links are supported — paste from a document and tidy it here."
              minHeight={320}
              readOnly={!editable}
              testId="policy-editor"
            />
            {policy.file_name && (
              <div className="t-caption" style={{ marginTop: 8, textTransform: 'none', letterSpacing: 0 }}>
                The uploaded PDF ({policy.file_name}) stays attached but is not shown while the
                policy is rich text.
              </div>
            )}
          </div>
        ) : (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              style={{ display: 'none' }}
              onChange={(e) => {
                void pickFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <div
              role={editable ? 'button' : undefined}
              tabIndex={editable ? 0 : -1}
              onClick={() => editable && !policy.file_name && fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (editable && !policy.file_name && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
              onDragOver={(e) => {
                if (!editable) return
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              data-testid="policy-pdf-dropzone"
              style={{
                border: `1.5px dashed ${dragging ? 'var(--blue)' : 'var(--bord-2)'}`,
                borderRadius: 12,
                background: dragging
                  ? 'color-mix(in srgb, var(--blue) 8%, transparent)'
                  : 'var(--surf-1)',
                padding: policy.file_name ? '14px 16px' : '34px 20px',
                textAlign: policy.file_name ? 'left' : 'center',
                cursor: editable && !policy.file_name ? 'pointer' : 'default',
                transition: 'border-color .12s, background .12s',
              }}
            >
              {policy.file_name ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      background: 'color-mix(in srgb, var(--coral) 13%, transparent)',
                      color: 'var(--coral)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon.file size={18} />
                  </div>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, wordBreak: 'break-word' }}>{policy.file_name}</div>
                    <div className="t-mute" style={{ fontSize: 11.5 }}>
                      {formatFileSize(policy.file_size_bytes) || 'PDF'}
                      {upload.isPending && ' · Uploading…'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {policy.file_url && (
                      <a
                        href={policy.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-ghost btn-sm"
                        style={{ textDecoration: 'none', opacity: opening ? 0.6 : 1 }}
                        aria-busy={opening}
                        onClick={(e) => void openPdf(e)}
                      >
                        <Icon.out size={13} /> {opening ? 'Opening…' : 'Open'}
                      </a>
                    )}
                    {editable && (
                      <Btn
                        kind="secondary"
                        size="sm"
                        icon={<Icon.upload size={13} />}
                        disabled={upload.isPending}
                        onClick={(e) => {
                          e.stopPropagation()
                          fileInputRef.current?.click()
                        }}
                      >
                        {upload.isPending ? 'Uploading…' : 'Replace'}
                      </Btn>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <Icon.upload size={22} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
                  <div style={{ fontSize: 13.5, fontWeight: 800 }}>
                    {upload.isPending ? 'Uploading…' : editable ? 'Drop the PDF here, or click to choose' : 'No PDF uploaded yet'}
                  </div>
                  <div className="t-mute" style={{ fontSize: 11.5, marginTop: 4 }}>
                    PDF only · up to 10 MB · employees read it inside the app
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Options */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 16,
            paddingTop: 16,
            borderTop: '1px solid var(--bord)',
          }}
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {/* proto/Toggle has no disabled prop — dim it and swallow clicks
                in view-only / archived mode like every other control here. */}
            <div
              aria-disabled={!editable}
              style={{
                paddingTop: 2,
                display: 'inline-flex',
                pointerEvents: editable ? 'auto' : 'none',
                opacity: editable ? 1 : 0.55,
              }}
            >
              <Toggle
                on={form.requires_acknowledgement}
                onChange={(next) => editable && set('requires_acknowledgement', next)}
              />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800 }}>Employees must agree to this policy</div>
              <div className="t-mute" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 2 }}>
                Everyone it applies to sees it at their next sign-in and in self-onboarding,
                and must tick &ldquo;I have read and agree&rdquo; before continuing.
              </div>
            </div>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Applies to</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <AudienceChip
                label="All"
                on={everyone}
                disabled={!editable}
                onClick={() => editable && set('applies_to_roles', [])}
              />
              {AUDIENCE_CHIPS.map((c) => (
                <AudienceChip
                  key={c.key}
                  label={c.label}
                  on={!everyone && chipOn(c.roles)}
                  disabled={!editable}
                  onClick={() => toggleChip(c.roles)}
                />
              ))}
            </div>
            <div className="t-mute" style={{ fontSize: 11.5, marginTop: 6 }}>
              {everyone
                ? 'Every admin, HR admin, manager, finance and employee seat. Guests and auditors are never asked.'
                : `Only ${policyAudienceLabel(form.applies_to_roles)}.`}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            paddingTop: 16,
            borderTop: '1px solid var(--bord)',
            flexWrap: 'wrap',
          }}
        >
          <span className="t-mute" style={{ fontSize: 12 }}>
            {archived
              ? 'Archived policies are read-only.'
              : !canEdit
                ? 'View only — ask an owner for full access to edit.'
                : dirty
                  ? <span style={{ color: 'var(--yellow)' }}>Unsaved changes</span>
                  : 'Up to date.'}
          </span>
          <div style={{ flex: 1 }} />
          {editable && (
            <>
              <Btn kind="ghost" size="sm" onClick={() => setArchiveOpen(true)} disabled={busy}>
                Archive
              </Btn>
              <Btn kind="secondary" size="sm" onClick={() => void onSave()} disabled={!dirty || busy}>
                {update.isPending ? 'Saving…' : 'Save'}
              </Btn>
              <Btn kind="primary" size="sm" icon={<Icon.send size={13} />} onClick={openPublish} disabled={busy}>
                {alreadyPublished ? 'Re-publish' : 'Publish'}
              </Btn>
            </>
          )}
        </div>
      </div>

      {/* Publish confirm */}
      <Modal
        open={publishOpen}
        onClose={() => !publish.isPending && setPublishOpen(false)}
        title={alreadyPublished ? 'Re-publish this policy?' : 'Publish this policy?'}
        sub={form.title.trim() || policy.title}
        width={480}
        footer={
          <>
            <Btn kind="ghost" onClick={() => setPublishOpen(false)} disabled={publish.isPending || update.isPending}>
              Cancel
            </Btn>
            <Btn kind="primary" onClick={() => void confirmPublish()} disabled={publish.isPending || update.isPending}>
              {publish.isPending || update.isPending ? 'Publishing…' : alreadyPublished ? 'Re-publish' : 'Publish'}
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55 }}>
          <p style={{ margin: 0 }}>
            It becomes visible to{' '}
            <b style={{ color: 'var(--text)' }}>
              {everyone ? 'everyone' : policyAudienceLabel(form.applies_to_roles)}
            </b>
            {form.requires_acknowledgement
              ? '. Everyone it applies to is notified and asked to read and agree at their next sign-in.'
              : '. No acknowledgement is required — people can read it from their Policies page.'}
          </p>
          {includesMe && (
            <p style={{ margin: 0, fontWeight: 700, color: 'var(--text)' }}>
              <Icon.info size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
              This includes you — you will be asked to read and agree right away.
            </p>
          )}
          {alreadyPublished && (
            <label
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid var(--bord)',
                background: 'var(--surf-1)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={reack}
                onChange={(e) => setReack(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ fontWeight: 800, color: 'var(--text)' }}>Ask everyone to agree again</span>
                <span className="t-mute" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
                  Bumps the version to v{policy.version + 1}; earlier agreements no longer count.
                  Leave it off for a typo fix — the content updates under v{policy.version}.
                </span>
              </span>
            </label>
          )}
          {dirty && (
            <div className="t-mute" style={{ fontSize: 11.5 }}>
              <Icon.info size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              Your unsaved changes are saved first.
            </div>
          )}
        </div>
      </Modal>

      {/* Archive confirm */}
      <Modal
        open={archiveOpen}
        onClose={() => !archive.isPending && setArchiveOpen(false)}
        title="Archive this policy?"
        sub={policy.title}
        width={440}
        footer={
          <>
            <Btn kind="ghost" onClick={() => setArchiveOpen(false)} disabled={archive.isPending}>
              Cancel
            </Btn>
            <Btn kind="danger" onClick={() => void confirmArchive()} disabled={archive.isPending}>
              {archive.isPending ? 'Archiving…' : 'Archive'}
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55 }}>
          It disappears from everyone&apos;s pending list and can&apos;t be published again.
          Acknowledgements already recorded stay as history.
        </p>
      </Modal>
    </>
  )
}

function AudienceChip({
  label,
  on,
  disabled,
  onClick,
}: {
  label: string
  on: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '6px 11px',
        borderRadius: 99,
        fontSize: 12,
        fontWeight: 800,
        cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${on ? 'color-mix(in srgb, var(--blue) 45%, transparent)' : 'var(--bord-2)'}`,
        background: on ? 'color-mix(in srgb, var(--blue) 13%, transparent)' : 'var(--surf-2)',
        color: on ? 'var(--blue)' : 'var(--text-2)',
        opacity: disabled && !on ? 0.55 : 1,
        transition: 'all .12s',
      }}
    >
      {label}
    </button>
  )
}
