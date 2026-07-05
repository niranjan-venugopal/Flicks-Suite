import { NextRequest, NextResponse } from 'next/server'

/**
 * Region detection for the consent banner (PRD v4 §3.3). On Vercel the edge
 * injects x-vercel-ip-country; local dev falls back to IN (the strictest
 * opt-in variant, so dev always exercises the explicit-consent path).
 */
export function GET(req: NextRequest) {
  const country =
    req.headers.get('x-vercel-ip-country') ??
    req.headers.get('cf-ipcountry') ??
    'IN'
  return NextResponse.json({ region: country.toUpperCase() })
}
