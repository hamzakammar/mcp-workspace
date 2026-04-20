import { z } from 'zod';
import { client } from '../client.js';

// ---- Raw D2L types ----

interface RawEnrollment {
  OrgUnit: { Id: number; Name: string; Code: string; Type: { Code: string } };
  Access: { IsActive: boolean; CanAccess: boolean; StartDate: string | null; EndDate: string | null };
}

interface RawAssignment {
  Id: number;
  Name: string;
  DueDate: string | null;
  Assessment: { ScoreDenominator: number } | null;
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

interface GlobalRecommendation {
  type: 'assignment' | 'quiz';
  courseName: string;
  courseCode: string;
  name: string;
  dueIn: string;
  weight: number | null;
  reason: string;
  urgencyScore: number;
}

// ---- Helpers ----

function formatDueIn(isoDate: string): string {
  const diffMs = new Date(isoDate).getTime() - Date.now();
  if (diffMs <= 0) return 'overdue';
  const h = Math.round(diffMs / (1000 * 60 * 60));
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

function urgencyScore(dueMs: number, weight: number | null, notStarted: boolean): number {
  const now = Date.now();
  const hoursUntilDue = Math.max((dueMs - now) / (1000 * 60 * 60), 0.1);
  const weightFactor = weight != null ? weight / 100 : 0.1;
  const notStartedPenalty = notStarted ? 2 : 1;
  return (weightFactor * notStartedPenalty) / hoursUntilDue;
}

async function getCourseRecommendations(
  orgUnitId: number,
  courseName: string,
  courseCode: string,
  cutoff: number
): Promise<GlobalRecommendation[]> {
  const recs: GlobalRecommendation[] = [];
  const now = Date.now();
  const pastCutoff = now - 7 * 24 * 60 * 60 * 1000;

  // Assignments
  try {
    const foldersRaw = (await client.getDropboxFolders(orgUnitId)) as RawAssignment[];
    const folders: RawAssignment[] = Array.isArray(foldersRaw) ? foldersRaw : [];
    for (const folder of folders) {
      if (!folder.DueDate) continue;
      const dueMs = new Date(folder.DueDate).getTime();
      if (dueMs > cutoff || dueMs < pastCutoff) continue;
      const weight = folder.Assessment?.ScoreDenominator ?? null;
      recs.push({
        type: 'assignment',
        courseName,
        courseCode,
        name: folder.Name,
        dueIn: formatDueIn(folder.DueDate),
        weight,
        reason: weight != null
          ? `Worth ${weight} points, due in ${formatDueIn(folder.DueDate)}`
          : `Due in ${formatDueIn(folder.DueDate)}`,
        urgencyScore: urgencyScore(dueMs, weight, true),
      });
    }
  } catch {
    // course may not expose dropbox — skip
  }

  // Quizzes
  try {
    const quizzesRaw = (await client.getQuizzes(orgUnitId)) as { Objects: RawQuiz[] } | RawQuiz[];
    const quizzes: RawQuiz[] = Array.isArray(quizzesRaw)
      ? quizzesRaw
      : (quizzesRaw as { Objects: RawQuiz[] }).Objects || [];

    await Promise.all(quizzes.map(async (quiz) => {
      if (!quiz.DueDate) return;
      const dueMs = new Date(quiz.DueDate).getTime();
      if (dueMs > cutoff || dueMs < pastCutoff) return;

      let attemptsUsed = 0;
      let attemptsAllowed: number | null = null;
      try {
        const attemptsRaw = (await client.getQuizAttempts(orgUnitId, quiz.QuizId)) as
          | { Objects: RawAttempt[] } | RawAttempt[];
        const attempts: RawAttempt[] = Array.isArray(attemptsRaw)
          ? attemptsRaw
          : (attemptsRaw as { Objects: RawAttempt[] }).Objects || [];
        attemptsUsed = attempts.filter((a) => a.IsCompleted).length;
      } catch {
        attemptsUsed = 0;
      }

      if (!quiz.AttemptsAllowed?.IsUnlimited) {
        attemptsAllowed = quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null;
      }
      if (attemptsAllowed !== null && attemptsUsed >= attemptsAllowed) return;

      const notStarted = attemptsUsed === 0;
      const attemptsDesc = attemptsAllowed !== null
        ? `${attemptsUsed} of ${attemptsAllowed} attempts used`
        : `${attemptsUsed} attempt${attemptsUsed !== 1 ? 's' : ''} used (unlimited)`;

      recs.push({
        type: 'quiz',
        courseName,
        courseCode,
        name: quiz.Name,
        dueIn: formatDueIn(quiz.DueDate),
        weight: null,
        reason: `${attemptsDesc}, due in ${formatDueIn(quiz.DueDate)}`,
        urgencyScore: urgencyScore(dueMs, null, notStarted),
      });
    }));
  } catch {
    // course may not expose quizzes — skip
  }

  return recs;
}

export const priorityGlobalTools = {
  what_should_i_work_on_global: {
    description: `Get a single unified priority list across ALL your enrolled courses. No course ID needed. Answers "What should I do today?" by fetching upcoming assignments and quizzes from every active course and ranking them by urgency. Use this as the first thing to check each morning.`,
    schema: {
      hoursAhead: z
        .number()
        .optional()
        .describe('How far ahead to look in hours (default: 72). Use 168 for a full week view.'),
    },
    handler: async (args: { hoursAhead?: number }): Promise<string> => {
      const hoursAhead = args.hoursAhead ?? 72;
      const cutoff = Date.now() + hoursAhead * 60 * 60 * 1000;

      // 1. Fetch all enrollments
      const enrollmentsRaw = (await client.getMyEnrollments()) as { Items: RawEnrollment[] };
      const now = new Date();
      const eightMonthsAgo = new Date(now.getTime() - 8 * 30 * 24 * 60 * 60 * 1000);

      const activeCourses = (enrollmentsRaw.Items || []).filter((e) => {
        if (e.OrgUnit?.Type?.Code !== 'Course Offering') return false;
        if (!e.Access?.IsActive || !e.Access?.CanAccess) return false;
        // Keep courses that started within the last 8 months or haven't ended yet
        const startDate = e.Access.StartDate ? new Date(e.Access.StartDate) : null;
        const endDate = e.Access.EndDate ? new Date(e.Access.EndDate) : null;
        if (endDate && endDate < eightMonthsAgo) return false;
        if (startDate && startDate > now) return false;
        return true;
      });

      if (activeCourses.length === 0) {
        return JSON.stringify({
          recommendations: [],
          summary: 'No active courses found.',
          coursesChecked: 0,
        }, null, 2);
      }

      // 2. Fetch assignments + quizzes for all courses in parallel
      const perCourseResults = await Promise.all(
        activeCourses.map((e) =>
          getCourseRecommendations(
            e.OrgUnit.Id,
            e.OrgUnit.Name,
            e.OrgUnit.Code || '',
            cutoff
          )
        )
      );

      // 3. Flatten, sort by urgency, take top 10
      const all: GlobalRecommendation[] = perCourseResults.flat();
      all.sort((a, b) => b.urgencyScore - a.urgencyScore);
      const top = all.slice(0, 10);

      let summary: string;
      if (top.length === 0) {
        summary = `Nothing due across your ${activeCourses.length} active course${activeCourses.length !== 1 ? 's' : ''} in the next ${hoursAhead} hours — you're on top of things.`;
      } else {
        const topItem = top[0];
        summary = `${top.length} item${top.length !== 1 ? 's' : ''} need attention across ${activeCourses.length} courses. Most urgent: "${topItem.name}" for ${topItem.courseCode || topItem.courseName} (${topItem.dueIn}).`;
      }

      return JSON.stringify({
        recommendations: top,
        summary,
        coursesChecked: activeCourses.length,
      }, null, 2);
    },
  },
};
