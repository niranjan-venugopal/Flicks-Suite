'use client'

import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useOrgChart, type OrgNode } from '@/lib/api/queries/use-employees'

function nodeName(n: OrgNode): string {
  return (n.fullName ?? '').trim() || n.email || n.employeeCode || 'Employee'
}

function NodeCard({ node }: { node: OrgNode }) {
  return (
    <Link
      href={`/employees/${node.id}`}
      className="card-glass"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '10px 14px',
        borderRadius: 12,
        minWidth: 230,
        textDecoration: 'none',
      }}
    >
      <Avatar name={nodeName(node)} size="sm" src={node.avatarUrl ?? undefined} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {nodeName(node)}
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {[node.designationTitle, node.departmentName].filter(Boolean).join(' · ') || node.employeeCode || '—'}
        </div>
      </div>
    </Link>
  )
}

/** Vertical, indented tree. Each level nests under its manager with a guide rail. */
function TreeNode({ node, depth }: { node: OrgNode; depth: number }) {
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 22 }}>
      <div
        style={{
          position: 'relative',
          paddingLeft: depth === 0 ? 0 : 18,
          marginBottom: 10,
        }}
      >
        {depth > 0 && (
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 20,
              width: 14,
              height: 1,
              background: 'var(--bord)',
            }}
          />
        )}
        <NodeCard node={node} />
      </div>
      {node.children.length > 0 && (
        <div
          style={{
            borderLeft: '1px solid var(--bord)',
            marginLeft: depth === 0 ? 18 : 18,
          }}
        >
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function OrgChartPage() {
  const { data, isLoading, error } = useOrgChart()
  const tree = data?.tree ?? []

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1100, margin: '0 auto' }}>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {tree.length > 1 && (
                <Pill tone="blue">{tree.length} top-level (no manager assigned)</Pill>
              )}
              {tree.map((root) => (
                <TreeNode key={root.id} node={root} depth={0} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
