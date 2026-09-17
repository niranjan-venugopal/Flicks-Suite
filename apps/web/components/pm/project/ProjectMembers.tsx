'use client'

import { ProjectGuestsCard } from '@/components/pm/ProjectGuestsCard'
import { ProjectMembersCard } from '@/components/pm/ProjectMembersCard'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// Project page — the Members + Guests rail cards. Split out of the page in
// Round M (verbatim move); a fragment, so the rail's flex column still lays
// the two cards out exactly as before.
// ─────────────────────────────────────────────────────────

export interface ProjectMembersProps {
  projectId: string
  leadUserId: string | null
  isPrivate: boolean
  engine: PmSyncEngine | null
}

export function ProjectMembers({ projectId, leadUserId, isPrivate, engine }: ProjectMembersProps) {
  return (
    <>
      {/* Round E — internal members + the Private switch */}
      <ProjectMembersCard
        projectId={projectId}
        leadUserId={leadUserId}
        isPrivate={isPrivate}
        engine={engine}
      />

      {/* Round 7 guest seats; round A: lead + manager-and-above */}
      <ProjectGuestsCard projectId={projectId} leadUserId={leadUserId} />
    </>
  )
}
