'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { TimelineBoard, ZoomToggle, type TimelineLane } from '@/components/pm/timeline'
import { InitiativeCreateModal } from '@/components/pm/projects'
import { usePm } from '@/lib/pm/PmProvider'
import { useAuthStore } from '@/lib/stores/auth.store'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// P14 — Roadmap: initiative lanes containing project bars (§9.3). Creating
// initiatives is Manager+ (server re-validates; the button hides for
// employees as a UX courtesy).
// ─────────────────────────────────────────────────────────

export default function PmRoadmapPage() {
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
        The roadmap isn’t available in this workspace right now — you’ll find your projects under Projects.
      </div>
    )
  }
  return <Roadmap engine={engine} />
}

const Roadmap = observer(function Roadmap({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const router = useRouter()
  const { currentUser } = useAuthStore()
  const [zoom, setZoom] = useState<'month' | 'quarter'>('quarter')
  const [openNew, setOpenNew] = useState(false)
  const [assignFor, setAssignFor] = useState<string | null>(null)

  const canInit = !['EMPLOYEE', 'AUDITOR'].includes(currentUser?.role ?? '')

  const lanes = useMemo<TimelineLane[]>(
    () =>
      [...store.initiatives.values()]
        .filter((i) => !i.deleted_at)
        .sort((a, b) => (a.target_quarter ?? '') < (b.target_quarter ?? '') ? -1 : 1)
        .map((init) => ({
          key: init.id,
          label: init.name,
          chip: init.status,
          projects: (store.initiativeProjects.get(init.id) ?? [])
            .map((pid) => store.projects.get(pid))
            .filter((p): p is NonNullable<typeof p> => Boolean(p && !p.deleted_at)),
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.initiatives.size, store.initiativeProjects, store.projects.size],
  )

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 1020, margin: '0 auto' }}>
      <SectionHead
        title="Roadmap"
        sub="Initiative lanes containing project bars, quarter columns."
        right={<Pill tone="blue" dot>sync</Pill>}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <ZoomToggle zoom={zoom} setZoom={setZoom} />
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>lane per initiative · drag bars to re-date</span>
        <span style={{ flex: 1 }} />
        {canInit && <Btn kind="secondary" size="sm" icon={<Icon.plus size={12} />} onClick={() => setOpenNew(true)}>New initiative</Btn>}
      </div>

      {lanes.length === 0 ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '56px 24px', gap: 12 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
            <Icon.layers size={20} />
          </div>
          <div className="t-mute" style={{ fontSize: 12.5, textAlign: 'center', maxWidth: 380, lineHeight: 1.6 }}>
            Initiatives are quarter-level lanes of projects — the answer to &quot;where is this all going?&quot;
          </div>
          {canInit && <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setOpenNew(true)}>New initiative</Btn>}
        </div>
      ) : (
        <TimelineBoard
          lanes={lanes}
          milestonesFor={(pid) => store.milestonesForProject(pid)}
          zoomMonths={zoom === 'month' ? 4 : 8}
          onRedate={(pid, patch) => engine.updateProject(pid, patch)}
          onOpenProject={(pid) => router.push(`/pm/projects/${pid}`)}
          emptyLaneCta={(laneKey) => setAssignFor(laneKey)}
        />
      )}

      {/* Attach projects to a lane */}
      {assignFor && (
        <div onClick={() => setAssignFor(null)} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(1,1,13,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: 380, maxHeight: 420, overflowY: 'auto' }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 10 }}>Add projects to this initiative</div>
            {store.projectList().map((p) => {
              const inLane = (store.initiativeProjects.get(assignFor) ?? []).includes(p.id)
              return (
                <button key={p.id}
                  onClick={() => {
                    const cur = store.initiativeProjects.get(assignFor) ?? []
                    engine.setInitiativeProjects(assignFor, inLane ? cur.filter((x) => x !== p.id) : [...cur, p.id])
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', borderRadius: 8, background: inLane ? 'rgba(62,123,250,.08)' : 'transparent', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 12, fontWeight: 700, textAlign: 'left' }}>
                  <span>{p.icon ?? '🎯'}</span>
                  <span style={{ flex: 1 }}>{p.name}</span>
                  {inLane && <Icon.check size={13} style={{ color: 'var(--blue)' }} />}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <InitiativeCreateModal
        open={openNew}
        onClose={() => setOpenNew(false)}
        onCreate={(input) => engine.createInitiative(input)}
      />
    </div>
  )
})
