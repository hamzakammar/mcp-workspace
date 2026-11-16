import { z } from 'zod';
import { client } from '../client.js';
import { marshalAssignments, marshalAssignment, marshalSubmissions, RawAssignment, RawSubmission } from '../utils/marshal.js';

const DEFAULT_COURSE_ID = process.env.D2L_COURSE_ID ? parseInt(process.env.D2L_COURSE_ID) : undefined;

function getOrgUnitId(orgUnitId?: number): number {
  const id = orgUnitId ?? DEFAULT_COURSE_ID;
  if (!id) {
    throw new Error('No course ID provided and D2L_COURSE_ID environment variable not set');
  }
  return id;
}

export const assignmentTools = {
  get_assignments: {
    description: `List all assignments for a course with their due dates and instructions. Returns: Name, DueDate (ISO 8601 format - compare with current date to find upcoming/overdue), instructions (in CustomInstructions.Text), point value (Assessment.ScoreDenominator), and Id (needed for get_assignment_submissions). Use this to answer: "What assignments do I have?", "What's due this week?", "What are my upcoming deadlines?", "Show me assignment instructions", "What homework is due soon?"`,
    schema: {
      orgUnitId: z.number().optional().describe('The course ID. Optional if D2L_COURSE_ID env var is set.'),
    },
    handler: async ({ orgUnitId }: { orgUnitId?: number }) => {
      const folders = await client.getDropboxFolders(getOrgUnitId(orgUnitId)) as RawAssignment[];
      return JSON.stringify(marshalAssignments(folders), null, 2);
    },
  },

  get_assignment: {
    description: `Get full details about a specific assignment including complete instructions, due date, point value, allowed file types, and grading rubrics. Use after get_assignments when you need more detail about one assignment.`,
    schema: {
      orgUnitId: z.number().optional().describe('The course ID. Optional if D2L_COURSE_ID env var is set.'),
      assignmentId: z.number().describe('The assignment Id from get_assignments. Example: 37812'),
    },
    handler: async ({ orgUnitId, assignmentId }: { orgUnitId?: number; assignmentId: number }) => {
      const folder = await client.getDropboxFolder(getOrgUnitId(orgUnitId), assignmentId) as RawAssignment;
      return JSON.stringify(marshalAssignment(folder), null, 2);
    },
  },

  get_assignment_submissions: {
    description: `Get the user's submissions for an assignment. Shows submitted files, submission timestamps, feedback comments, and grades received. Use to answer: "Did I submit this assignment?", "What grade did I get?", "When did I submit?", "What feedback did I receive?"`,
    schema: {
      orgUnitId: z.number().optional().describe('The course ID. Optional if D2L_COURSE_ID env var is set.'),
      assignmentId: z.number().describe('The assignment Id from get_assignments. Example: 37812'),
    },
    handler: async ({ orgUnitId, assignmentId }: { orgUnitId?: number; assignmentId: number }) => {
      // mysubmissions returns only the caller's own EntityDropbox entries; the plain
      // submissions/ route is staff-only (403 for students).
      const raw = await client.getMySubmissions(getOrgUnitId(orgUnitId), assignmentId) as RawSubmission[] | RawSubmission;
      const submissions: RawSubmission[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return JSON.stringify(marshalSubmissions(submissions), null, 2);
    },
  },
};
