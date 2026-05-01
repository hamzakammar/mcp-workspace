import { z } from 'zod';
import { client } from '../client.js';

interface RawForum {
  ForumId: number;
  Name: string;
  Description: { Text: string } | null;
  IsLocked: boolean;
  IsHidden: boolean;
}

interface RawTopic {
  TopicId: number;
  Name: string;
  Description: { Text: string } | null;
  IsLocked: boolean;
  IsHidden: boolean;
  PostCount: number | null;
  UnreadPostCount: number | null;
  LastPostDate: string | null;
}

export const discussionTools = {
  get_discussion_boards: {
    description: `Get the discussion boards (forums and topics) for a course. Returns all forums with their topics, post counts, and whether you have unread posts. Use to answer: "What discussion boards are there?", "Are there any unread posts?", "What forums are active?"`,
    schema: {
      orgUnitId: z
        .number()
        .describe('The course ID (e.g. 1221444 for ECE 124).'),
    },
    handler: async (args: { orgUnitId: number }): Promise<string> => {
      const { orgUnitId } = args;

      const forumsRaw = (await client.getDiscussionForums(orgUnitId)) as
        | RawForum[]
        | { Objects: RawForum[] };
      const forums: RawForum[] = Array.isArray(forumsRaw)
        ? forumsRaw
        : (forumsRaw as { Objects: RawForum[] }).Objects || [];

      const visibleForums = forums.filter((f) => !f.IsHidden);

      const result = await Promise.allSettled(
        visibleForums.map(async (forum) => {
          let topics: Array<{
            topicId: number;
            name: string;
            description: string | null;
            isLocked: boolean;
            postCount: number | null;
            unreadPostCount: number | null;
            lastPostDate: string | null;
          }> = [];

          try {
            const topicsRaw = (await client.getDiscussionTopics(orgUnitId, forum.ForumId)) as
              | RawTopic[]
              | { Objects: RawTopic[] };
            const rawList: RawTopic[] = Array.isArray(topicsRaw)
              ? topicsRaw
              : (topicsRaw as { Objects: RawTopic[] }).Objects || [];

            topics = rawList
              .filter((t) => !t.IsHidden)
              .map((t) => ({
                topicId: t.TopicId,
                name: t.Name,
                description: t.Description?.Text || null,
                isLocked: t.IsLocked,
                postCount: t.PostCount ?? null,
                unreadPostCount: t.UnreadPostCount ?? null,
                lastPostDate: t.LastPostDate || null,
              }));
          } catch {
            // topics unavailable for this forum — return empty
          }

          return {
            forumId: forum.ForumId,
            name: forum.Name,
            description: forum.Description?.Text || null,
            isLocked: forum.IsLocked,
            topics,
          };
        })
      );

      const boards = result
        .filter((r) => r.status === 'fulfilled')
        .map((r) => (r as PromiseFulfilledResult<typeof result[0] extends PromiseFulfilledResult<infer V> ? V : never>).value);

      return JSON.stringify({ forums: boards, forumCount: boards.length }, null, 2);
    },
  },
};
