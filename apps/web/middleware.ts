import { NextResponse, type NextRequest } from 'next/server'

// The Specflicks platform console is served from admin.flickssuite.com. The
// FAM pages live under /fam/* in the same Next app, so when a request arrives
// on the admin host we rewrite it into the /fam tree. Everything else (the
// customer app on app.flickssuite.com / localhost) passes through untouched.
const ADMIN_HOSTS = new Set([
  'admin.flickssuite.com',
  'admin.localhost:3000',
])

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').toLowerCase()
  if (!ADMIN_HOSTS.has(host)) {
    return NextResponse.next()
  }

  const { pathname, search } = req.nextUrl

  // Already pointed at the FAM tree — leave it alone.
  if (pathname === '/fam' || pathname.startsWith('/fam/')) {
    return NextResponse.next()
  }

  // Auth routes stay shared (FAM signs in through the same login flow).
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/verify') ||
    pathname.startsWith('/totp-setup')
  ) {
    return NextResponse.next()
  }

  const url = req.nextUrl.clone()
  url.pathname = pathname === '/' ? '/fam/overview' : `/fam${pathname}`
  url.search = search
  return NextResponse.rewrite(url)
}

// Skip static assets, API tunnels, and image optimisation.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|monitoring|.*\\..*).*)'],
}
