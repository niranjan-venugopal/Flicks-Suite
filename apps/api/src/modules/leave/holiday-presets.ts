/**
 * Curated public-holiday presets, keyed country → year. These seed the
 * "Import from country list" flow in Settings → Holiday calendar (the Keka /
 * Zoho pattern: pick a country, tick the holidays you observe, assign them to
 * a location). They are SUGGESTIONS the admin confirms — every imported row
 * stays fully editable afterwards.
 *
 * Dates for moon-sighting festivals (Eid, Islamic New Year, …) follow the
 * official announcements/estimates at the time of writing and carry a note in
 * `description`; admins should re-verify them near the date. Years beyond the
 * researched window intentionally ship only fixed-date holidays.
 */

export type HolidayPresetType =
  | 'national'
  | 'regional'
  | 'optional'
  | 'restricted'
  | 'company';

export interface HolidayPreset {
  date: string; // YYYY-MM-DD
  name: string;
  type: HolidayPresetType;
  description?: string;
}

const MOON = 'Date follows moon sighting — confirm near the day.';

export const PRESET_COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'IN', name: 'India' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
];

export const HOLIDAY_PRESETS: Record<string, Record<number, HolidayPreset[]>> = {
  IN: {
    2026: [
      { date: '2026-01-01', name: "New Year's Day", type: 'company' },
      { date: '2026-01-26', name: 'Republic Day', type: 'national' },
      { date: '2026-03-04', name: 'Holi', type: 'national' },
      { date: '2026-03-21', name: 'Eid al-Fitr (Id-ul-Fitr)', type: 'national', description: MOON },
      { date: '2026-03-26', name: 'Ram Navami', type: 'national' },
      { date: '2026-04-03', name: 'Good Friday', type: 'national' },
      { date: '2026-05-01', name: 'Buddha Purnima', type: 'national' },
      { date: '2026-05-27', name: 'Eid al-Adha (Bakrid)', type: 'national', description: MOON },
      { date: '2026-08-15', name: 'Independence Day', type: 'national' },
      { date: '2026-10-02', name: 'Gandhi Jayanti', type: 'national' },
      { date: '2026-10-20', name: 'Dussehra (Vijayadashami)', type: 'national' },
      { date: '2026-11-08', name: 'Diwali (Deepavali)', type: 'national' },
      { date: '2026-12-25', name: 'Christmas Day', type: 'national' },
    ],
    2027: [
      { date: '2027-01-01', name: "New Year's Day", type: 'company' },
      { date: '2027-01-26', name: 'Republic Day', type: 'national' },
      { date: '2027-08-15', name: 'Independence Day', type: 'national' },
      { date: '2027-10-02', name: 'Gandhi Jayanti', type: 'national' },
      { date: '2027-12-25', name: 'Christmas Day', type: 'national' },
      // Festival dates (Holi, Eid, Dussehra, Diwali …) are added manually
      // until the 2027 calendars are announced.
    ],
  },
  AE: {
    2026: [
      { date: '2026-01-01', name: "New Year's Day", type: 'national' },
      { date: '2026-03-19', name: 'Eid al-Fitr', type: 'national', description: MOON },
      { date: '2026-03-20', name: 'Eid al-Fitr holiday', type: 'national', description: MOON },
      { date: '2026-03-21', name: 'Eid al-Fitr holiday', type: 'national', description: `${MOON} A 4th day (22 Mar) applies if Ramadan runs 30 days.` },
      { date: '2026-05-26', name: 'Arafat Day', type: 'national', description: MOON },
      { date: '2026-05-27', name: 'Eid al-Adha', type: 'national', description: MOON },
      { date: '2026-05-28', name: 'Eid al-Adha holiday', type: 'national', description: MOON },
      { date: '2026-06-16', name: 'Islamic New Year', type: 'national', description: MOON },
      { date: '2026-08-25', name: "Prophet Muhammad's Birthday", type: 'national', description: MOON },
      { date: '2026-12-01', name: 'Commemoration Day', type: 'national' },
      { date: '2026-12-02', name: 'UAE National Day', type: 'national' },
      { date: '2026-12-03', name: 'UAE National Day holiday', type: 'national' },
    ],
    2027: [
      { date: '2027-01-01', name: "New Year's Day", type: 'national' },
      { date: '2027-12-01', name: 'Commemoration Day', type: 'national' },
      { date: '2027-12-02', name: 'UAE National Day', type: 'national' },
      { date: '2027-12-03', name: 'UAE National Day holiday', type: 'national' },
      // Islamic-calendar holidays are added manually until announced.
    ],
  },
  US: {
    2026: [
      { date: '2026-01-01', name: "New Year's Day", type: 'national' },
      { date: '2026-01-19', name: 'Martin Luther King Jr. Day', type: 'national' },
      { date: '2026-02-16', name: "Presidents' Day", type: 'national' },
      { date: '2026-05-25', name: 'Memorial Day', type: 'national' },
      { date: '2026-06-19', name: 'Juneteenth', type: 'national' },
      { date: '2026-07-04', name: 'Independence Day', type: 'national', description: 'Falls on a Saturday — commonly observed Friday 3 July.' },
      { date: '2026-09-07', name: 'Labor Day', type: 'national' },
      { date: '2026-10-12', name: 'Columbus Day', type: 'optional', description: 'Federal holiday — often not observed in the private sector.' },
      { date: '2026-11-11', name: 'Veterans Day', type: 'optional', description: 'Federal holiday — often not observed in the private sector.' },
      { date: '2026-11-26', name: 'Thanksgiving Day', type: 'national' },
      { date: '2026-11-27', name: 'Day after Thanksgiving', type: 'company' },
      { date: '2026-12-25', name: 'Christmas Day', type: 'national' },
    ],
    2027: [
      { date: '2027-01-01', name: "New Year's Day", type: 'national' },
      { date: '2027-01-18', name: 'Martin Luther King Jr. Day', type: 'national' },
      { date: '2027-02-15', name: "Presidents' Day", type: 'national' },
      { date: '2027-05-31', name: 'Memorial Day', type: 'national' },
      { date: '2027-06-19', name: 'Juneteenth', type: 'national', description: 'Falls on a Saturday — commonly observed Friday 18 June.' },
      { date: '2027-07-04', name: 'Independence Day', type: 'national', description: 'Falls on a Sunday — commonly observed Monday 5 July.' },
      { date: '2027-09-06', name: 'Labor Day', type: 'national' },
      { date: '2027-10-11', name: 'Columbus Day', type: 'optional', description: 'Federal holiday — often not observed in the private sector.' },
      { date: '2027-11-11', name: 'Veterans Day', type: 'optional', description: 'Federal holiday — often not observed in the private sector.' },
      { date: '2027-11-25', name: 'Thanksgiving Day', type: 'national' },
      { date: '2027-11-26', name: 'Day after Thanksgiving', type: 'company' },
      { date: '2027-12-25', name: 'Christmas Day', type: 'national', description: 'Falls on a Saturday — commonly observed Friday 24 December.' },
    ],
  },
  GB: {
    2026: [
      { date: '2026-01-01', name: "New Year's Day", type: 'national' },
      { date: '2026-04-03', name: 'Good Friday', type: 'national' },
      { date: '2026-04-06', name: 'Easter Monday', type: 'national' },
      { date: '2026-05-04', name: 'Early May bank holiday', type: 'national' },
      { date: '2026-05-25', name: 'Spring bank holiday', type: 'national' },
      { date: '2026-08-31', name: 'Summer bank holiday', type: 'national' },
      { date: '2026-12-25', name: 'Christmas Day', type: 'national' },
      { date: '2026-12-28', name: 'Boxing Day (substitute day)', type: 'national', description: '26 Dec falls on a Saturday — substitute Monday 28 Dec.' },
    ],
    2027: [
      { date: '2027-01-01', name: "New Year's Day", type: 'national' },
      { date: '2027-03-26', name: 'Good Friday', type: 'national' },
      { date: '2027-03-29', name: 'Easter Monday', type: 'national' },
      { date: '2027-05-03', name: 'Early May bank holiday', type: 'national' },
      { date: '2027-05-31', name: 'Spring bank holiday', type: 'national' },
      { date: '2027-08-30', name: 'Summer bank holiday', type: 'national' },
      { date: '2027-12-27', name: 'Christmas Day (substitute day)', type: 'national', description: '25 Dec falls on a Saturday — substitute Monday 27 Dec.' },
      { date: '2027-12-28', name: 'Boxing Day (substitute day)', type: 'national', description: '26 Dec falls on a Sunday — substitute Tuesday 28 Dec.' },
    ],
  },
};

export function getHolidayPresets(country: string, year: number): HolidayPreset[] {
  return HOLIDAY_PRESETS[country]?.[year] ?? [];
}
