import { z } from 'zod';
import { client } from '../client.js';
import { isQuizAttemptCompleted, loadQuizAttemptSummary, type RawQuizAttempt } from '../utils/marshal.js';

interface RawQuiz {
  QuizId: number;
  Name: string;
  DueDate: string | null;
  StartDate: string | null;
  EndDate: string | null;
  IsActive: boolean;
  TimeLimit: {
    IsEnforced: boolean;
    ShowClock: boolean;
    TimeLimitValue: number; // minutes
  } | null;
  AttemptsAllowed: {
    IsUnlimited: boolean;
    NumberOfAttemptsAllowed: number | null;
  } | null;
  Description: { Text: string; Html: string } | null;
}

type RawAttempt = RawQuizAttempt & { CompletionDate?: string | null };

export interface MarshalledQuiz {
  quizId: string;
  name: string;
  dueDate: string | null;
  timeLimitMinutes: number | null;
  attemptsAllowed: number | null; // null = unlimited
  attemptsUsed: number | null; // null when attempts could not be loaded
  lastAttemptScore: number | null;
  attemptsUnknown?: true;
}

export function marshalQuiz(
  quiz: RawQuiz,
  attempts: RawAttempt[],
  attemptsUnknown = false
): MarshalledQuiz {
  const completedAttempts = attempts.filter(isQuizAttemptCompleted);
  const completedAt = (a: RawAttempt) => new Date(a.Completed || a.CompletionDate || 0).getTime();
  const lastAttempt = [...completedAttempts].sort((a, b) => completedAt(b) - completedAt(a))[0];

  return {
    quizId: String(quiz.QuizId),
    name: quiz.Name,
    dueDate: quiz.DueDate || null,
    timeLimitMinutes:
      quiz.TimeLimit?.IsEnforced && quiz.TimeLimit.TimeLimitValue
        ? quiz.TimeLimit.TimeLimitValue
        : null,
    attemptsAllowed:
      quiz.AttemptsAllowed?.IsUnlimited
        ? null
        : (quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null),
    attemptsUsed: attemptsUnknown ? null : completedAttempts.length,
    lastAttemptScore: lastAttempt?.Score ?? null,
    ...(attemptsUnknown ? { attemptsUnknown: true as const } : {}),
  };
}

export const quizTools = {
  get_quizzes: {
    description: `Get all quizzes for a course including name, due date, time limit, attempts allowed, and the current user's attempt history. Use to answer: "What quizzes do I have?", "How many attempts do I have left?", "When is the next quiz due?", "What did I score on the last attempt?"`,
    schema: {
      orgUnitId: z
        .number()
        .describe('The course ID (e.g. 1221444 for ECE 124).'),
    },
    handler: async (args: { orgUnitId: number }): Promise<string> => {
      const { orgUnitId } = args;

      // Fetch quiz list
      const quizListRaw = await client.getQuizzes(orgUnitId) as { Objects: RawQuiz[] } | RawQuiz[];
      const quizList: RawQuiz[] = Array.isArray(quizListRaw)
        ? quizListRaw
        : (quizListRaw as { Objects: RawQuiz[] }).Objects || [];

      // Fetch attempts for each quiz in parallel
      const results = await Promise.all(
        quizList.map(async (quiz) => {
          // 404 → no attempts; any other failure → attemptsUnknown (not "0 used").
          const summary = await loadQuizAttemptSummary(() => client.getQuizAttempts(orgUnitId, quiz.QuizId));
          return marshalQuiz(quiz, summary.attempts as RawAttempt[], summary.unknown);
        })
      );

      return JSON.stringify(results, null, 2);
    },
  },
};
