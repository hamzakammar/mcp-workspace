/**
 * outlineHosts.ts — mapping from D2L host to course outline URL base.
 *
 * Each entry describes how to reach a school's published course outlines.
 * Add entries here as new schools are onboarded.
 *
 * Format:
 *   d2lHost (key)   — the value of D2L_HOST used by that school
 *   outlineBase     — base URL of the outline viewer (no trailing slash)
 *   authRequired    — whether the site requires login before fetching
 *   notes           — human-readable notes about URL structure or quirks
 */

export interface OutlineHostConfig {
  outlineBase: string;
  authRequired: boolean;
  notes: string;
}

export const OUTLINE_HOST_MAP: Record<string, OutlineHostConfig> = {
  // University of Waterloo
  'learn.uwaterloo.ca': {
    outlineBase: 'https://outline.uwaterloo.ca',
    authRequired: true,
    notes: 'Django site. URL pattern: /viewer/course/{subject}/{number}/{term}/. List: /viewer/org/uwaterloo/.',
  },

  // Add additional schools here as they are researched and confirmed.
  // Example template (do not uncomment without verifying the URL structure):
  // 'avenue.mcmaster.ca': {
  //   outlineBase: 'https://academiccalendars.registrar.mcmaster.ca',
  //   authRequired: false,
  //   notes: 'McMaster course outlines are in the academic calendar. URL pattern TBD.',
  // },
};

/** Returns the supported school names (human-readable) for error messages. */
export function getSupportedSchools(): string[] {
  return Object.keys(OUTLINE_HOST_MAP).map((host) => {
    const labels: Record<string, string> = {
      'learn.uwaterloo.ca': 'University of Waterloo (learn.uwaterloo.ca)',
    };
    return labels[host] || host;
  });
}
