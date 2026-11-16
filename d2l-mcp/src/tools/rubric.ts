import { z } from 'zod';
import { client } from '../client.js';
import { stripHtml } from '../utils/marshal.js';

// Raw D2L rubric types (Valence Rubric.Rubric — see assessment.html)
type RichText = { Text?: string; Html?: string } | null | undefined;

interface RawRubricLevel {
  Id?: number;
  Name: string;
  Points?: number | null;
}

interface RawCriterionCell {
  Description?: RichText;
  Feedback?: RichText;
  Points?: number | null;
}

interface RawRubricCriterion {
  Id?: number;
  Name: string;
  Cells?: RawCriterionCell[] | null;
  // Legacy/unknown shapes some callers saw — tolerated, not required.
  Description?: RichText;
  Levels?: Array<{ Name: string; Points: number; Description?: RichText }> | null;
}

interface RawCriteriaGroup {
  Name?: string;
  Levels?: RawRubricLevel[] | null;
  Criteria?: RawRubricCriterion[] | null;
}

export interface RawRubric {
  RubricId: number;
  Name: string;
  Description?: RichText;
  ScoringMethod?: unknown;
  CriteriaGroups?: RawCriteriaGroup[] | null;
  // Legacy flat shape.
  Criteria?: RawRubricCriterion[] | null;
}

interface RawDropboxFolder {
  Id: number;
  Name: string;
  CustomInstructions: { Text: string; Html: string } | null;
  DueDate: string | null;
  // Valence DropboxFolder.Assessment: { ScoreDenominator, Rubrics: Rubric[] }
  Assessment: { ScoreDenominator: number | null; Rubrics?: RawRubric[] | null } | null;
}

export interface RubricCriterionOut {
  rubric: string;
  group?: string;
  name: string;
  description: string;
  maxPoints: number;
  levels: Array<{ name: string; points: number | null; description?: string }>;
}

const rt = (t: RichText) => stripHtml(t?.Text || t?.Html) || '';

/** Flatten rubrics (CriteriaGroups → Criteria → Cells, aligned with group Levels). */
export function flattenRubrics(rubrics: RawRubric[]): RubricCriterionOut[] {
  const out: RubricCriterionOut[] = [];
  for (const rubric of rubrics || []) {
    const groups: RawCriteriaGroup[] =
      rubric.CriteriaGroups && rubric.CriteriaGroups.length > 0
        ? rubric.CriteriaGroups
        : rubric.Criteria
        ? [{ Criteria: rubric.Criteria, Levels: [] }]
        : [];
    for (const group of groups) {
      const groupLevels = group.Levels || [];
      for (const criterion of group.Criteria || []) {
        let levels: RubricCriterionOut['levels'];
        if (criterion.Cells && criterion.Cells.length > 0) {
          // Cells are provided one per level, in the group's level order.
          levels = criterion.Cells.map((cell, i) => {
            const desc = rt(cell.Description);
            return {
              name: groupLevels[i]?.Name ?? `Level ${i + 1}`,
              points: cell.Points ?? groupLevels[i]?.Points ?? null,
              ...(desc ? { description: desc } : {}),
            };
          });
        } else if (criterion.Levels && criterion.Levels.length > 0) {
          levels = criterion.Levels.map((l) => {
            const desc = rt(l.Description);
            return { name: l.Name, points: l.Points ?? null, ...(desc ? { description: desc } : {}) };
          });
        } else {
          levels = groupLevels.map((l) => ({ name: l.Name, points: l.Points ?? null }));
        }
        const maxPoints = Math.max(0, ...levels.map((l) => l.points ?? 0));
        out.push({
          rubric: rubric.Name,
          ...(group.Name ? { group: group.Name } : {}),
          name: criterion.Name,
          description: rt(criterion.Description),
          maxPoints,
          levels,
        });
      }
    }
  }
  return out;
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

      // Rubrics: prefer the folder's own Assessment.Rubrics; otherwise ask the
      // rubrics endpoint for rubrics attached to this dropbox folder.
      let rubricNote: string | null = null;
      let rubrics: RawRubric[] = folder.Assessment?.Rubrics || [];
      if (rubrics.length === 0) {
        try {
          const raw = (await client.getRubrics(orgUnitId, 'Dropbox', folderId)) as
            | RawRubric[]
            | { Objects: RawRubric[] };
          rubrics = Array.isArray(raw) ? raw : raw?.Objects || [];
        } catch (err) {
          rubricNote = `Could not load rubric for this assignment: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
        }
      }
      const rubricCriteria: RubricCriterionOut[] = flattenRubrics(rubrics);
      if (!rubricNote && rubrics.length === 0) {
        rubricNote = 'No rubric is attached to this assignment.';
      }

      const result: Record<string, unknown> = {
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
      if (rubricNote) result.rubricNote = rubricNote;

      return JSON.stringify(result, null, 2);
    },
  },
};
