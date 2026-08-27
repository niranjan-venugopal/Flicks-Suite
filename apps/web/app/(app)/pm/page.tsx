import { redirect } from 'next/navigation'

// Projects is the PM module's main page (round 12, founder decision) —
// bare /pm lands there instead of 404ing.
export default function PmIndexPage() {
  redirect('/pm/projects')
}
