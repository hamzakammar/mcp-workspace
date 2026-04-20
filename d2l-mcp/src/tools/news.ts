import { z } from 'zod';
import { client } from '../client.js';
import { marshalAnnouncements, RawAnnouncement } from '../utils/marshal.js';

const DEFAULT_COURSE_ID = process.env.D2L_COURSE_ID ? parseInt(process.env.D2L_COURSE_ID) : undefined;

function getOrgUnitId(provided?: number): number {
  const orgUnitId = provided ?? DEFAULT_COURSE_ID;
  if (!orgUnitId) {
    throw new Error('orgUnitId is required. Either provide it or set D2L_COURSE_ID environment variable.');
  }
  return orgUnitId;
}

export const newsTools = {
  get_announcements: {
    description: `Get course announcements/news items from instructors. Returns: title, body (text and HTML), created date, author, attachments. Optionally filter to announcements posted after a given ISO date. Use to answer: "Any new announcements?", "What did the professor post?", "Are there any updates?", "What's the latest news?"`,
    schema: {
      orgUnitId: z.number().optional().describe('The course ID. Optional if D2L_COURSE_ID env var is set.'),
      since: z.string().optional().describe('ISO 8601 date string. Only return announcements posted after this date (e.g. "2025-01-01T00:00:00Z").'),
    },
    handler: async (args: { orgUnitId?: number; since?: string }): Promise<string> => {
      const orgUnitId = getOrgUnitId(args.orgUnitId);
      const news = await client.getNews(orgUnitId) as RawAnnouncement[];
      let filtered = news;
      if (args.since) {
        const sinceMs = new Date(args.since).getTime();
        filtered = news.filter((a) => new Date(a.StartDate || a.CreatedDate).getTime() >= sinceMs);
      }
      return JSON.stringify(marshalAnnouncements(filtered), null, 2);
    },
  },
};
