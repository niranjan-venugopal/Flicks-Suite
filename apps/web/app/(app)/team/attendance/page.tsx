import { redirect } from 'next/navigation'

// Round 14 (founder): the team view lives INSIDE the Attendance page behind
// the My/Team toggle — this route survives only so old links keep working.
export default function TeamAttendanceRedirect() {
  redirect('/attendance')
}
