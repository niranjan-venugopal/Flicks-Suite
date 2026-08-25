import type { Metadata } from 'next'

// The employee self-onboarding wizard nests under /onboarding and would
// otherwise inherit the signup SEO — it's an authed internal surface, so
// keep crawlers out and give it its own title.
export const metadata: Metadata = {
  title: 'Complete your profile',
  robots: { index: false },
}

export default function EmployeeOnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
