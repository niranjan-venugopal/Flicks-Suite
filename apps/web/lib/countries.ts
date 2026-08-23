// Shared country list (ISO-3166 alpha-2) used by Settings → General and
// Settings → Locations. Country drives which statutory/state UI applies:
// India gets the GST state dropdown; everywhere else state is free text.
export const COUNTRIES = [
  ['IN', 'India'],
  ['AE', 'United Arab Emirates'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['SG', 'Singapore'],
  ['AU', 'Australia'],
  ['CA', 'Canada'],
  ['SA', 'Saudi Arabia'],
  ['QA', 'Qatar'],
  ['KW', 'Kuwait'],
  ['BH', 'Bahrain'],
  ['OM', 'Oman'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['LK', 'Sri Lanka'],
  ['BD', 'Bangladesh'],
  ['NP', 'Nepal'],
  ['ID', 'Indonesia'],
  ['PH', 'Philippines'],
  ['MY', 'Malaysia'],
  ['NZ', 'New Zealand'],
] as const

export const countryName = (code?: string | null): string =>
  COUNTRIES.find(([c]) => c === code)?.[1] ?? (code || '—')

// Indian two-letter GST state codes (dropdown when country is IN).
export const IN_STATE_CODES = [
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN',
  'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD',
  'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OR', 'PB', 'PY', 'RJ',
  'SK', 'TN', 'TR', 'TS', 'UK', 'UP', 'WB',
] as const

// Common office timezones (IANA) for the location form.
export const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Jakarta',
  'Asia/Manila',
  'Asia/Dhaka',
  'Asia/Colombo',
  'Asia/Kathmandu',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Amsterdam',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Australia/Sydney',
  'Pacific/Auckland',
] as const
