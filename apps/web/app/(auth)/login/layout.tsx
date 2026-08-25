import type { Metadata } from 'next'

// SEO for the sign-in page (round 7): the login page itself is a client
// component, so its metadata lives on this server layout.
export const metadata: Metadata = {
  title: { absolute: 'Sign in — Flicks Suite by Specflicks' },
  description:
    'Sign in to Flicks Suite by Specflicks — HRMS, CRM, invoicing and project management for Indian startups.',
  keywords: [
    'Specflicks Flicks Suite login',
    'Flicks Suite sign in',
    'Specflicks HRMS login',
    'Flicks Suite',
    'Specflicks',
  ],
  alternates: { canonical: '/login' },
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
