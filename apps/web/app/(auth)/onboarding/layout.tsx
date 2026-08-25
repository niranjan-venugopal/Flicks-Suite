import type { Metadata } from 'next'

// SEO for the signup/workspace-creation wizard (round 7). /signup 301s here
// (next.config redirect). The nested employee wizard opts out via its own
// layout (robots noindex).
export const metadata: Metadata = {
  title: { absolute: 'Create your workspace — Flicks Suite by Specflicks' },
  description:
    'Create your Flicks Suite workspace by Specflicks — HRMS, CRM, invoicing and project management for your team, with a free trial.',
  keywords: [
    'Specflicks Flicks Suite signup',
    'create Flicks Suite workspace',
    'Flicks Suite onboarding',
    'Flicks Suite free trial',
    'Specflicks',
  ],
  alternates: { canonical: '/onboarding' },
}

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return children
}
