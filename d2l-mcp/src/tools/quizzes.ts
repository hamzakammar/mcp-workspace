import { z } from 'zod';
import { client } from '../client.js';

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

interface RawAttempt {
  AttemptId: number;
  CompletionDate: string | null;
  Score: number | null;
  IsCompleted: boolean;
}

export interface MarshalledQuiz {
  quizId: string;
  name: string;
  dueDate: string | null;
  timeLimitMinutes: number | null;
  attemptsAllowed: number | null; // null = unlimited
  attemptsUsed: number;
  lastAttemptScore: number | null;
}

function marshalQuiz(
  quiz: RawQuiz,
  attempts: RawAttempt[]
): MarshalledQuiz {
  const completedAttempts = attempts.filter((a) => a.IsCompleted);
  const lastAttempt = completedAttempts.sort(
    (a, b) =>
      new Date(b.CompletionDate || 0).getTime() -
      new Date(a.CompletionDate || 0).getTime()
  )[0];

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
    attemptsUsed: completedAttempts.length,
    lastAttemptScore: lastAttempt?.Score ?? null,
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
          let attempts: RawAttempt[] = [];
          try {
            const attemptsRaw = await client.getQuizAttempts(orgUnitId, quiz.QuizId) as { Objects: RawAttempt[] } | RawAttempt[];
            attempts = Array.isArray(attemptsRaw)
              ? attemptsRaw
              : (attemptsRaw as { Objects: RawAttempt[] }).Objects || [];
          } catch {
            // Attempts endpoint may return 403/404 for unstarted quizzes — treat as 0 attempts
            attempts = [];
          }
          return marshalQuiz(quiz, attempts);
        })
      );

      return JSON.stringify(results, null, 2);
    },
  },
};
