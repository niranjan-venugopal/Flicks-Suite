import type { MetadataRoute } from 'next'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.flickssuite.com'

// Public pages for Google (round 7): sign-in + signup first, legal pages as
// good citizens. Everything else is behind auth.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${APP_URL}/login`, changeFrequency: 'monthly', priority: 1 },
    { url: `${APP_URL}/onboarding`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${APP_URL}/terms`, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${APP_URL}/privacy`, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${APP_URL}/contact`, changeFrequency: 'monthly', priority: 0.3 },
  ]
}
