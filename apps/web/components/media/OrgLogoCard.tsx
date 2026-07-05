'use client'

import { useState } from 'react'
import { Btn, Icon } from '@/components/proto'
import { avBg, initials } from '@/components/proto'
import { MediaCropModal } from './MediaCropModal'
import { useUploadLogo, useRemoveLogo } from '@/lib/api/queries/use-media'
import { useAuthStore } from '@/lib/stores/auth.store'

/**
 * D7 — org-settings logo header (PRD v4 §4.1, Owner/Admin). Circular in-app
 * rendering; the invoice/public logo path is untouched (one upload feeds both
 * via serialization). Camera badge + Change logo open the shared D5 modal.
 */
export function OrgLogoCard() {
  const { currentTenant } = useAuthStore()
  const upload = useUploadLogo()
  const remove = useRemoveLogo()
  const [modalOpen, setModalOpen] = useState(false)
  const logo = currentTenant?.logoUrl

  return (
    <div className="card" style={{ borderColor: 'rgba(155,123,250,.3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ position: 'relative' }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: logo ? 'var(--surf-2)' : avBg(currentTenant?.name),
              color: '#fff',
              fontWeight: 800,
              fontSize: 22,
            }}
          >
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={currentTenant?.name ?? 'Logo'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              initials(currentTenant?.name)
            )}
          </div>
          <button
            onClick={() => setModalOpen(true)}
            title="Change logo"
            style={{
              position: 'absolute',
              bottom: -2,
              right: -2,
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: 'var(--blue)',
              border: '2.5px solid var(--surf-1)',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon.image size={13} />
          </button>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>
            {currentTenant?.name ?? 'Your company'}
          </div>
          <div className="t-mute" style={{ fontSize: 11.5, marginTop: 2 }}>
            PNG/WebP with transparency kept · renders circular in-app · invoice rendering unchanged
          </div>
        </div>
        <Btn kind="secondary" size="sm" icon={<Icon.image size={13} />} onClick={() => setModalOpen(true)}>
          Change logo
        </Btn>
      </div>
      {modalOpen && (
        <MediaCropModal
          kind="logo"
          hasCurrent={!!logo}
          onUpload={async (blob) => {
            await upload.mutateAsync(blob)
          }}
          onRemove={async () => {
            await remove.mutateAsync()
          }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}
