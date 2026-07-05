'use client'

import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useOrgChart, type OrgNode } from '@/lib/api/queries/use-employees'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { usePresence } from '@/lib/api/queries/use-presence'

function nodeName(n: OrgNode): string {
  return (n.fullName ?? '').trim() || n.email || n.employeeCode || 'Employee'
}

const TONE_BORDER: Record<string, string> = {
  blue: 'var(--blue)',
  purple: 'var(--purple)',
  coral: 'var(--coral)',
  green: 'var(--green)',
  yellow: 'var(--yellow)',
}
const BRANCH_TONES = ['purple', 'coral', 'green', 'blue', 'yellow'] as const

function NodeCard({
  node,
  big = false,
  tone,
}: {
  node: OrgNode
  big?: boolean
  tone?: string
}) {
  const pending = node.status !== 'active'
  const reports = node.children.length
  const border = pending
    ? 'rgba(254,216,0,.45)'
    : big
      ? 'var(--blue)'
      : tone
        ? TONE_BORDER[tone]
        : 'var(--bord-2)'
  return (
    <Link
      href={`/employees/${node.id}`}
      style={{
        position: 'relative',
        background: big
          ? 'linear-gradient(180deg, rgba(62,123,250,.18), rgba(62,123,250,.06))'
          : 'var(--surf-2)',
        border: `1.5px solid ${border}`,
        borderRadius: 12,
        padding: big ? '14px 18px' : '10px 14px',
        minWidth: big ? 220 : 168,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      {pending && (
        <Pill tone="yellow" style={{ position: 'absolute', top: -9, right: -6 }}>
          Pending
        </Pill>
      )}
      <RowPresenceAvatar name={nodeName(node)} size={big ? 38 : 28} src={node.avatarUrl ?? undefined} userId={node.userId} ring={big ? '#0b1428' : 'var(--surf-2)'} />
      <div style={{ minWidth: 0, maxWidth: big ? 200 : 150 }}>
        <div style={{ fontSize: big ? 13 : 11.5, fontWeight: 800, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {nodeName(node)}
        </div>
        <div style={{ fontSize: big ? 11.5 : 10.5, fontWeight: 600, color: 'var(--text-mute)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {[node.designationTitle, node.departmentName].filter(Boolean).join(' · ') || node.employeeCode || '—'}
        </div>
        {reports > 0 && (
          <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--blue)', marginTop: 2 }}>
            {reports} {reports === 1 ? 'report' : 'reports'}
          </div>
        )}
      </div>
    </Link>
  )
}

const Connector = ({ h = 24 }: { h?: number }) => (
  <div style={{ width: 1.5, height: h, background: 'var(--bord-2)' }} />
)

/** Recursive top-down tree: node on top, a vertical drop, then children in a row. */
function TreeNode({ node, depth }: { node: OrgNode; depth: number }) {
  const tone = depth === 1 ? BRANCH_TONES[0] : undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
      <NodeCard node={node} big={depth === 0} tone={tone} />
      {node.children.length > 0 && (
        <>
          <Connector h={depth === 0 ? 24 : 20} />
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', justifyContent: 'center' }}>
            {node.children.map((child, i) => (
              <BranchNode key={child.id} node={child} depth={depth + 1} branchIndex={i} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Like TreeNode but colours the branch head by its sibling index. */
function BranchNode({ node, depth, branchIndex }: { node: OrgNode; depth: number; branchIndex: number }) {
  const tone = depth === 1 ? BRANCH_TONES[branchIndex % BRANCH_TONES.length] : undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
      <NodeCard node={node} tone={tone} />
      {node.children.length > 0 && (
        <>
          <Connector h={20} />
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', justifyContent: 'center' }}>
            {node.children.map((child) => (
              <BranchNode key={child.id} node={child} depth={depth + 1} branchIndex={branchIndex} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function OrgChartPage() {
  const { data, isLoading, error } = useOrgChart()
  const tree = data?.tree ?? []
  // D9 (PRD v4 §5) — seed batched presence for every node in the tree.
  const flat: string[] = []
  const walk = (nodes: OrgNode[]) => nodes.forEach((n) => { if (n.userId) flat.push(n.userId); walk(n.children) })
  walk(tree)
  usePresence(flat)

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Org chart"
          sub={
            data
              ? `${data.total} ${data.total === 1 ? 'person' : 'people'} across your reporting structure`
              : 'Reporting lines across your organisation'
          }
          right={
            <Link href="/employees">
              <Btn kind="secondary" size="sm" icon={<Icon.people size={13} />}>
                All employees
              </Btn>
            </Link>
          }
        />

        <div className="card" style={{ marginTop: 18, padding: 24, overflowX: 'auto' }}>
          {isLoading ? (
            <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--text-mute)' }} />
            </div>
          ) : error ? (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div className="t-h3" style={{ marginBottom: 4 }}>Could not load the org chart</div>
              <p className="t-mute" style={{ fontSize: 13 }}>Please try again in a moment.</p>
            </div>
          ) : tree.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                <Icon.people size={28} />
              </div>
              <div className="t-h3" style={{ marginBottom: 4 }}>No reporting lines yet</div>
              <p className="t-mute" style={{ fontSize: 13 }}>
                Set a reporting manager on employees to see them nested here.
              </p>
            </div>
          ) : (
            <div style={{ minWidth: 'min-content', margin: '0 auto', padding: '12px 8px' }}>
              {tree.length > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
                  <Pill tone="blue">{tree.length} top-level (no manager assigned)</Pill>
                </div>
              )}
              <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start', justifyContent: 'center' }}>
                {tree.map((root) => (
                  <TreeNode key={root.id} node={root} depth={0} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
