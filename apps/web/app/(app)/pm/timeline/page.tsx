'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { Icon, Pill, SectionHead } from '@/components/proto'
import { TimelineBoard, ZoomToggle, type TimelineLane } from '@/components/pm/timeline'
import { usePm } from '@/lib/pm/PmProvider'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// P12 — Project timeline: bars grouped by team or initiative, milestone
// diamonds, drag ends to re-date. Sync-engine surface (REST users get the
// projects list — the drag surface needs the local graph).
// ─────────────────────────────────────────────────────────

export default function PmTimelinePage() {
  const { mode, engine } = usePm()
  if (mode === 'loading') {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }
  if (mode === 'rest' || !engine) {
    return (
      <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>
        The timeline isn’t available in this workspace right now — you’ll find your projects under Projects.
      </div>
    )
  }
  return <Timeline engine={engine} />
}

const Timeline = observer(function Timeline({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const router = useRouter()
  const [group, setGroup] = useState<'team' | 'initiative'>('team')
  const [zoom, setZoom] = useState<'month' | 'quarter'>('month')

  const lanes = useMemo<TimelineLane[]>(() => {
    const projects = store.projectList()
    if (group === 'initiative') {
      return [...store.initiatives.values()]
        .filter((i) => !i.deleted_at)
        .map((init) => ({
          key: init.id,
          label: init.name,
          chip: init.status,
          projects: (store.initiativeProjects.get(init.id) ?? [])
            .map((pid) => store.projects.get(pid))
            .filter((p): p is NonNullable<typeof p> => Boolean(p && !p.deleted_at)),
        }))
    }
    return store.teamList().map((t) => ({
      key: t.id,
      label: `${t.key} · ${t.name}`,
      projects: projects.filter((p) => (store.projectTeams.get(p.id) ?? []).includes(t.id)),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, store.projects.size, store.initiatives.size, store.teams.size, store.projectTeams, store.initiativeProjects])

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 1020, margin: '0 auto' }}>
      <SectionHead
        title="Timeline"
        sub="Projects as bars from start to target — drag ends to re-date. Deliberately no task-Gantt."
        right={<Pill tone="blue" dot>sync</Pill>}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8 }}>
          {([['team', 'By team'], ['initiative', 'By initiative']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setGroup(k)}
              style={{ padding: '5px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', background: group === k ? 'var(--surf-3)' : 'transparent', color: group === k ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800 }}>
              {l}
            </button>
          ))}
        </div>
        <ZoomToggle zoom={zoom} setZoom={setZoom} />
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>drag bar ends to re-date · milestone diamonds</span>
      </div>
      <TimelineBoard
        lanes={lanes}
        milestonesFor={(pid) => store.milestonesForProject(pid)}
        zoomMonths={zoom === 'month' ? 4 : 8}
        onRedate={(pid, patch) => engine.updateProject(pid, patch)}
        onOpenProject={(pid) => router.push(`/pm/projects/${pid}`)}
      />
    </div>
  )
})
