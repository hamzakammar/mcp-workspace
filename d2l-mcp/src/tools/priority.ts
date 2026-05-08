import { z } from 'zod';
import { client } from '../client.js';

// ---- Raw D2L types ----

interface RawAssignment {
  Id: number;
  Name: string;
  DueDate: string | null;
  Assessment: { ScoreDenominator: number } | null;
}

export interface RawGradeObject {
  Id: number;
  Name: string;
  Weight: number | null;
}

interface RawQuiz {
  QuizId: number;
  Name: string;
  DueDate: string | null;
  AttemptsAllowed: {
    IsUnlimited: boolean;
    NumberOfAttemptsAllowed: number | null;
  } | null;
}

interface RawAttempt {
  IsCompleted: boolean;
}

// ---- Output types ----

interface Recommendation {
  type: 'assignment' | 'quiz' | 'review';
  name: string;
  dueIn: string;
  weight: number | null;
  reason: string;
  urgencyScore: number;
  _folderId?: number; // internal — stripped before output
}

// ---- Helpers (exported for testing) ----

export function formatDueIn(isoDate: string): string {
  const diffMs = new Date(isoDate).getTime() - Date.now();
  if (diffMs <= 0) return 'overdue';
  const h = Math.round(diffMs / (1000 * 60 * 60));
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

// weight here is already a percentage (0–100) from GradeObject.Weight, not raw points
export function urgencyScore(
  dueMs: number,
  weight: number | null,
  notStarted: boolean
): number {
  const now = Date.now();
  const hoursUntilDue = Math.max((dueMs - now) / (1000 * 60 * 60), 0.1);
  const weightFactor = weight != null ? weight / 100 : 0.1;
  const notStartedPenalty = notStarted ? 2 : 1;
  return (weightFactor * notStartedPenalty) / hoursUntilDue;
}

/**
 * Returns true when needle is a whole-word substring of haystack.
 * "assignment 1" inside "assignment 10" is rejected because '0' follows the match.
 */
function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return false;
  const afterIdx = idx + needle.length;
  const charAfter = haystack[afterIdx];
  return afterIdx >= haystack.length || !/\w/.test(charAfter);
}

export function matchGradeWeight(
  name: string,
  gradeObjects: RawGradeObject[]
): number | null {
  const lower = name.toLowerCase();
  // Tier 1: exact match or whole-word substring containment
  let match = gradeObjects.find((g) => {
    const gLower = g.Name.toLowerCase();
    return gLower === lower ||
      wordBoundaryIncludes(gLower, lower) ||
      wordBoundaryIncludes(lower, gLower);
  });
  if (match) return match.Weight ?? null;

  // Tier 2: number-extraction fallback — if both names share the same integer,
  // treat as a match (handles "A1" vs "Assignment 1", "Quiz2" vs "Quiz 2", etc.)
  const nameNums = lower.match(/\d+/g);
  if (nameNums) {
    match = gradeObjects.find((g) => {
      const gNums = g.Name.toLowerCase().match(/\d+/g);
      return gNums && nameNums.some(n => gNums.includes(n));
    });
  }
  return match?.Weight ?? null;
}

export const priorityTools = {
  what_should_i_work_on: {
    description: `Get an AI-prioritized list of what to work on next for a course. Synthesizes upcoming assignment deadlines, quiz due dates and remaining attempts into a ranked recommendation list. Use to answer: "What should I focus on?", "What's most urgent?", "What do I need to do before the deadline?"`,
    schema: {
      orgUnitId: z
        .number()
        .describe('The course ID (e.g. 1221444 for ECE 124).'),
      hoursAhead: z
        .number()
        .optional()
        .describe(
          'How far ahead to look in hours (default: 72). Increase to see further-out items.'
        ),
    },
    handler: async (args: {
      orgUnitId: number;
      hoursAhead?: number;
    }): Promise<string> => {
      const { orgUnitId } = args;
      const hoursAhead = args.hoursAhead ?? 72;
      const cutoff = Date.now() + hoursAhead * 60 * 60 * 1000;

      const recommendations: Recommendation[] = [];

      // Fetch grade objects once for weight lookup
      let gradeObjects: RawGradeObject[] = [];
      try {
        const raw = (await client.getGradeObjects(orgUnitId)) as
          | RawGradeObject[]
          | { Objects: RawGradeObject[] };
        gradeObjects = Array.isArray(raw)
          ? raw
          : (raw as { Objects: RawGradeObject[] }).Objects || [];
      } catch {
        // Grade objects unavailable — fall back to default weight
      }

      // ---- Assignments ----
      try {
        const foldersRaw = (await client.getDropboxFolders(
          orgUnitId
        )) as RawAssignment[];
        const folders: RawAssignment[] = Array.isArray(foldersRaw)
          ? foldersRaw
          : [];

        for (const folder of folders) {
          if (!folder.DueDate) continue;
          const dueMs = new Date(folder.DueDate).getTime();
          if (dueMs > cutoff || dueMs < Date.now() - 7 * 24 * 60 * 60 * 1000)
            continue;
          // Use grade object Weight (% of final grade) instead of raw ScoreDenominator
          const gradeWeight = matchGradeWeight(folder.Name, gradeObjects);
          const displayWeight = folder.Assessment?.ScoreDenominator ?? null;
          const score = urgencyScore(dueMs, gradeWeight, true);
          recommendations.push({
            type: 'assignment',
            name: folder.Name,
            dueIn: formatDueIn(folder.DueDate),
            weight: displayWeight,
            reason:
              gradeWeight != null
                ? `Worth ${gradeWeight}% of final grade, due in ${formatDueIn(folder.DueDate)}`
                : displayWeight != null
                ? `Worth ${displayWeight} points, due in ${formatDueIn(folder.DueDate)}`
                : `Due in ${formatDueIn(folder.DueDate)}`,
            urgencyScore: score,
            _folderId: folder.Id,
          });
        }
      } catch {
        // Assignments unavailable — skip
      }

      // ---- Quizzes ----
      try {
        const quizzesRaw = (await client.getQuizzes(orgUnitId)) as
          | { Objects: RawQuiz[] }
          | RawQuiz[];
        const quizzes: RawQuiz[] = Array.isArray(quizzesRaw)
          ? quizzesRaw
          : (quizzesRaw as { Objects: RawQuiz[] }).Objects || [];

        await Promise.all(
          quizzes.map(async (quiz) => {
            if (!quiz.DueDate) return;
            const dueMs = new Date(quiz.DueDate).getTime();
            if (dueMs > cutoff || dueMs < Date.now() - 7 * 24 * 60 * 60 * 1000)
              return;

            let attemptsUsed = 0;
            let attemptsAllowed: number | null = null;
            try {
              const attemptsRaw = (await client.getQuizAttempts(
                orgUnitId,
                quiz.QuizId
              )) as { Objects: RawAttempt[] } | RawAttempt[];
              const attempts: RawAttempt[] = Array.isArray(attemptsRaw)
                ? attemptsRaw
                : (attemptsRaw as { Objects: RawAttempt[] }).Objects || [];
              attemptsUsed = attempts.filter((a) => a.IsCompleted).length;
            } catch {
              attemptsUsed = 0;
            }

            if (!quiz.AttemptsAllowed?.IsUnlimited) {
              attemptsAllowed =
                quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null;
            }

            // Skip if all attempts used
            if (
              attemptsAllowed !== null &&
              attemptsUsed >= attemptsAllowed
            )
              return;

            const notStarted = attemptsUsed === 0;
            const score = urgencyScore(dueMs, null, notStarted);
            const attemptsDesc =
              attemptsAllowed !== null
                ? `${attemptsUsed} of ${attemptsAllowed} attempts used`
                : `${attemptsUsed} attempt${attemptsUsed !== 1 ? 's' : ''} used (unlimited)`;

            recommendations.push({
              type: 'quiz',
              name: quiz.Name,
              dueIn: formatDueIn(quiz.DueDate),
              weight: null,
              reason: `${attemptsDesc}, due in ${formatDueIn(quiz.DueDate)}`,
              urgencyScore: score,
            });
          })
        );
      } catch {
        // Quizzes unavailable — skip
      }

      // Sort by urgency score descending, take top candidates
      recommendations.sort((a, b) => b.urgencyScore - a.urgencyScore);
      const candidates = recommendations.slice(0, 10);

      // Filter out already-submitted assignments (check submissions only for top candidates)
      const submissionChecks = await Promise.allSettled(
        candidates
          .filter((r) => r.type === 'assignment' && r._folderId != null)
          .map(async (r) => {
            try {
              const raw = (await client.getMySubmissions(orgUnitId, r._folderId!)) as
                | { HasSubmission?: boolean; Submissions?: unknown[] }
                | unknown[];
              const hasSubmission = Array.isArray(raw)
                ? raw.length > 0
                : !!(raw.HasSubmission || (raw.Submissions && (raw.Submissions as unknown[]).length > 0));
              return { name: r.name, submitted: hasSubmission };
            } catch {
              return { name: r.name, submitted: false };
            }
          })
      );
      const submittedNames = new Set<string>();
      for (const result of submissionChecks) {
        if (result.status === 'fulfilled' && result.value.submitted) {
          submittedNames.add(result.value.name);
        }
      }

      const top = candidates
        .filter((r) => !submittedNames.has(r.name))
        .slice(0, 5)
        .map(({ _folderId: _f, ...rec }) => rec); // strip internal field

      let summary: string;
      if (top.length === 0) {
        summary = `Nothing due within the next ${hoursAhead} hours — you're on top of things.`;
      } else {
        summary = `${top.length} item${top.length > 1 ? 's' : ''} need attention: most urgent is "${top[0].name}" (${top[0].dueIn}).`;
      }

      return JSON.stringify({ recommendations: top, summary }, null, 2);
    },
  },
};
