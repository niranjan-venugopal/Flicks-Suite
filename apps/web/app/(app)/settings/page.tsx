'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Btn, SectionHead, SkeletonCard } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import {
  useOrganization,
  useUpdateOrganization,
} from '@/lib/api/queries/use-settings'
import { useToast } from '@/components/ui/use-toast'
import { TIMEZONES } from '@/lib/countries'

// Settings → General (round 13, founder decision): ONLY the workspace-wide
// preferences live here — Default timezone, Financial year, Week starts on.
// Identity / tax / address moved to Settings → Company profile.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const

function fyLabel(startMonth: number): string {
  const endMonth = ((startMonth + 10) % 12) // startMonth is 1-based; 11 months later
  return `${MONTHS[startMonth - 1]} – ${MONTHS[endMonth]}`
}

interface Prefs {
  timezone: string
  fiscalYearStartMonth: number
  weekStartsOn: number
}

export default function GeneralSettingsPage() {
  const { data: org, isLoading } = useOrganization()
  const update = useUpdateOrganization()
  const { toast } = useToast()

  const [form, setForm] = useState<Prefs>({ timezone: 'Asia/Kolkata', fiscalYearStartMonth: 4, weekStartsOn: 1 })
  const [baseline, setBaseline] = useState<Prefs>(form)

  useEffect(() => {
    if (org) {
      const next: Prefs = {
        timezone: org.timezone,
        fiscalYearStartMonth: org.fiscalYearStartMonth,
        weekStartsOn: org.weekStartsOn ?? 1,
      }
      setForm(next)
      setBaseline(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org])

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [form, baseline],
  )

  // The stored timezone may predate the curated list — keep it selectable.
  const tzOptions = useMemo(
    () => (TIMEZONES as readonly string[]).includes(form.timezone)
      ? (TIMEZONES as readonly string[])
      : [form.timezone, ...TIMEZONES],
    [form.timezone],
  )

  const save = async () => {
    try {
      await update.mutateAsync({
        ...(form.timezone !== baseline.timezone && { timezone: form.timezone }),
        ...(form.fiscalYearStartMonth !== baseline.fiscalYearStartMonth && {
          fiscalYearStartMonth: form.fiscalYearStartMonth,
        }),
        ...(form.weekStartsOn !== baseline.weekStartsOn && { weekStartsOn: form.weekStartsOn }),
      })
      toast({ title: 'Preferences saved', description: 'Your changes are live across the workspace.' })
    } catch (err: any) {
      toast({ title: 'Save failed', description: err?.message ?? 'Please try again.', variant: 'destructive' })
    }
  }

  if (isLoading || !org) {
    return (
      <SettingsLayout>
        <SkeletonCard lines={4} />
      </SettingsLayout>
    )
  }

  return (
    <SettingsLayout>
      <SectionHead
        title="General"
        sub="Workspace-wide defaults. Company identity, tax IDs and address live in Company profile."
      />

      <section className="card p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="label">Default timezone</label>
            <select
              className="input"
              value={form.timezone}
              onChange={(e) => setForm((p) => ({ ...p, timezone: e.target.value }))}
            >
              {tzOptions.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
            <p className="text-xs text-brand-muted">
              The workspace default. Individual offices can override it under
              Locations &amp; geofence.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="label">Financial year starts</label>
            <select
              className="input"
              value={form.fiscalYearStartMonth}
              onChange={(e) => setForm((p) => ({ ...p, fiscalYearStartMonth: Number(e.target.value) }))}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <p className="text-xs text-brand-muted">
              {fyLabel(form.fiscalYearStartMonth)}. Invoice numbering follows
              this financial year — changing it mid-year starts a new series.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="label">Week starts on</label>
            <select
              className="input"
              value={form.weekStartsOn}
              onChange={(e) => setForm((p) => ({ ...p, weekStartsOn: Number(e.target.value) }))}
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
            <p className="text-xs text-brand-muted">
              Timesheet weeks begin on this day. A mid-week change applies
              from the next week — the current draft keeps its dates.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between mt-6">
          <p className="t-mute text-sm">
            {dirty
              ? <span className="text-brand-yellow">You have unsaved changes.</span>
              : <span>Up to date.</span>}
          </p>
          <div className="flex gap-3">
            <Btn kind="ghost" onClick={() => setForm(baseline)} disabled={!dirty || update.isPending}>
              Discard
            </Btn>
            <Btn kind="primary" onClick={save} disabled={!dirty || update.isPending}>
              {update.isPending ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                </span>
              ) : (
                'Save changes'
              )}
            </Btn>
          </div>
        </div>
      </section>
    </SettingsLayout>
  )
}
