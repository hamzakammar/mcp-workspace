import { z } from 'zod';
import { client } from '../client.js';
import { stripHtml } from '../utils/marshal.js';

// Raw D2L rubric types
interface RawRubricCriterion {
  Name: string;
  Description: { Text: string; Html: string } | null;
  Levels: Array<{
    Name: string;
    Points: number;
    Description: { Text: string; Html: string } | null;
  }>;
}

interface RawRubric {
  RubricId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  Criteria: RawRubricCriterion[] | null;
  ScoringMethod: string | null;
}

interface RawDropboxFolder {
  Id: number;
  Name: string;
  CustomInstructions: { Text: string; Html: string } | null;
  DueDate: string | null;
  Assessment: { ScoreDenominator: number } | null;
}

export const rubricTools = {
  get_assignment_rubric: {
    description: `Get the assignment description, instructions, and grading rubric criteria for a specific assignment. Use this to understand what is expected and how it will be graded. Does NOT fetch or draft submissions. Use to answer: "What does this assignment expect?", "How will this be graded?", "What are the marking criteria?"`,
    schema: {
      orgUnitId: z
        .number()
        .describe('The course ID (e.g. 1221444 for ECE 124).'),
      folderId: z
        .number()
        .describe('The assignment/dropbox folder ID from get_assignments.'),
    },
    handler: async (args: {
      orgUnitId: number;
      folderId: number;
    }): Promise<string> => {
      const { orgUnitId, folderId } = args;

      // Fetch assignment details
      const folder = (await client.getDropboxFolder(
        orgUnitId,
        folderId
      )) as RawDropboxFolder;

      // Fetch rubrics for the course
      let rubricCriteria: Array<{
        name: string;
        description: string;
        maxPoints: number;
      }> = [];

      try {
        const rubricsRaw = (await client.getRubrics(orgUnitId)) as
          | RawRubric[]
          | { Objects: RawRubric[] };
        const rubrics: RawRubric[] = Array.isArray(rubricsRaw)
          ? rubricsRaw
          : (rubricsRaw as { Objects: RawRubric[] }).Objects || [];

        // Flatten all criteria from all rubrics associated with this course
        for (const rubric of rubrics) {
          for (const criterion of rubric.Criteria || []) {
            const maxPoints = Math.max(
              ...(criterion.Levels || []).map((l) => l.Points ?? 0),
              0
            );
            rubricCriteria.push({
              name: criterion.Name,
              description:
                stripHtml(
                  criterion.Description?.Text ||
                    criterion.Description?.Html
                ) || '',
              maxPoints,
            });
          }
        }
      } catch {
        // Rubric endpoint may not be available for all courses — return empty
        rubricCriteria = [];
      }

      const result = {
        name: folder.Name,
        instructions:
          stripHtml(
            folder.CustomInstructions?.Text ||
              folder.CustomInstructions?.Html
          ) || null,
        dueDate: folder.DueDate || null,
        totalPoints: folder.Assessment?.ScoreDenominator ?? null,
        rubricCriteria,
      };

      return JSON.stringify(result, null, 2);
    },
  },
};
