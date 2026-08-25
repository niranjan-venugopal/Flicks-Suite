import type { MetadataRoute } from 'next'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.flickssuite.com'

// Crawler policy (round 7): the public surfaces are login, the signup
// wizard, and the legal pages; the API is off-limits. Authed app routes
// return the login redirect to crawlers anyway.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }],
    sitemap: `${APP_URL}/sitemap.xml`,
  }
}
