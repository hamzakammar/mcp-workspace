/**
 * Outline MCP tools — access course outlines from outline.uwaterloo.ca.
 *
 * Tools:
 *   get_course_outline        — fetch + parse a specific course outline by code + term
 *   get_my_course_outlines    — fetch outlines for all enrolled D2L courses
 *   get_cached_outline        — read a previously-fetched outline from DB (no network)
 */

import { z } from "zod";
import { supabase } from "../../utils/supabase.js";
import { getOrRefreshOutlineCookies } from "../outlineAuth.js";
import {
  fetchCourseOutline,
  fetchMyOutlineList,
  getCurrentTerm,
  OutlineAuthError,
  type ParsedOutline,
} from "../outlineClient.js";
import { client } from "../../client.js";
import { marshalEnrollments, type RawEnrollment } from "../../utils/marshal.js";

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function upsertOutline(userId: string, outline: ParsedOutline): Promise<void> {
  const { error } = await supabase.from("course_outlines").upsert({
    user_id: userId,
    course_code: outline.courseCode,
    term: outline.term,
    title: outline.title,
    raw_html: outline.rawHtml,
    assessments: outline.assessments,
    schedule: outline.schedule,
    instructors: outline.instructors,
    learning_objectives: outline.learningObjectives,
    outline_url: outline.outlineUrl,
    fetched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,course_code,term" });

  if (error) {
    console.error(`[OUTLINE] Failed to upsert outline ${outline.courseCode}/${outline.term}:`, error.message);
  }
}

function formatOutlineForLLM(outline: ParsedOutline): object {
  return {
    courseCode: outline.courseCode,
    term: outline.term,
    title: outline.title,
    url: outline.outlineUrl,
    instructors: outline.instructors,
    learningObjectives: outline.learningObjectives,
    assessments: outline.assessments,
    schedule: outline.schedule,
  };
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export const OutlineTools = {

  get_course_outline: {
    description: `Fetch and parse a course outline from outline.uwaterloo.ca. Returns structured data including assessments (with weights and due dates), weekly schedule, instructor info, and learning objectives. Requires the course code (e.g. "CS135", "MATH135") and term (e.g. "1251" for Winter 2025, "2509" for Fall 2025). Use get_my_course_outlines to fetch all enrolled courses at once.`,
    schema: {
      courseCode: z.string().describe('Course code, e.g. "CS135" or "MATH135"'),
      term: z.string().optional().describe('Term in YYMM format, e.g. "1251" for Winter 2025. Defaults to current term.'),
    },
    handler: async ({ courseCode, term, userId }: {
      courseCode: string;
      term?: string;
      userId: string;
    }): Promise<string> => {
      const resolvedTerm = term || getCurrentTerm();

      let cookieHeader: string;
      try {
        cookieHeader = await getOrRefreshOutlineCookies(userId);
      } catch (e: any) {
        return JSON.stringify({
          success: false,
          error: e.message,
          requiresAuth: true,
        }, null, 2);
      }

      try {
        const outline = await fetchCourseOutline(cookieHeader, courseCode, resolvedTerm);
        await upsertOutline(userId, outline);
        return JSON.stringify({
          success: true,
          outline: formatOutlineForLLM(outline),
        }, null, 2);
      } catch (e: any) {
        if (e instanceof OutlineAuthError) {
          return JSON.stringify({
            success: false,
            error: "Outline session expired. Re-authenticating...",
            requiresAuth: true,
          }, null, 2);
        }
        return JSON.stringify({
          success: false,
          error: e.message,
        }, null, 2);
      }
    },
  },

  get_my_course_outlines: {
    description: `Fetch course outlines from outline.uwaterloo.ca for all courses you're currently enrolled in on D2L. Cross-references your D2L enrolled courses with outline.uwaterloo.ca. Returns assessments, schedule, and instructor info for each course. This may take a moment as it fetches each outline individually.`,
    schema: {
      term: z.string().optional().describe('Term in YYMM format (e.g. "1251"). Defaults to current term.'),
    },
    handler: async ({ term, userId }: {
      term?: string;
      userId: string;
    }): Promise<string> => {
      const resolvedTerm = term || getCurrentTerm();

      let cookieHeader: string;
      try {
        cookieHeader = await getOrRefreshOutlineCookies(userId);
      } catch (e: any) {
        return JSON.stringify({
          success: false,
          error: e.message,
          requiresAuth: true,
        }, null, 2);
      }

      // Get enrolled D2L courses
      let enrolledCodes: string[] = [];
      try {
        const enrollments = await client.getMyEnrollments() as { Items: RawEnrollment[] };
        const courses = marshalEnrollments(enrollments);
        // D2L course codes look like "CS 135 001" — extract subject+number
        enrolledCodes = courses
          .filter(c => c.isActive && c.code)
          .map(c => c.code.trim().replace(/\s+/g, "").replace(/\d{3}$/, "").toUpperCase())
          .filter((code, i, arr) => arr.indexOf(code) === i && /^[A-Z]+\d+[A-Z]?$/.test(code));
      } catch (e: any) {
        console.error("[OUTLINE] Failed to get D2L enrollments:", e.message);
      }

      // Also try fetching the outline list for courses available on outline site
      let availableOnSite: string[] = [];
      try {
        const list = await fetchMyOutlineList(cookieHeader);
        availableOnSite = list
          .filter(o => o.term === resolvedTerm)
          .map(o => o.courseCode.toUpperCase());
      } catch (e: any) {
        console.error("[OUTLINE] Could not fetch outline list:", e.message);
      }

      // Merge: prioritize D2L enrolled courses, supplement with site list
      const allCodes = [...new Set([...enrolledCodes, ...availableOnSite])];

      if (allCodes.length === 0) {
        return JSON.stringify({
          success: false,
          error: "Could not determine enrolled courses. Make sure D2L is connected.",
        }, null, 2);
      }

      const results: Array<{ courseCode: string; success: boolean; outline?: object; error?: string }> = [];

      for (const code of allCodes) {
        try {
          const outline = await fetchCourseOutline(cookieHeader, code, resolvedTerm);
          await upsertOutline(userId, outline);
          results.push({ courseCode: code, success: true, outline: formatOutlineForLLM(outline) });
        } catch (e: any) {
          if (e instanceof OutlineAuthError) {
            return JSON.stringify({ success: false, error: "Outline session expired mid-fetch.", requiresAuth: true }, null, 2);
          }
          // 404 = outline doesn't exist for this course+term, skip silently
          if (e.message?.includes("404")) {
            continue;
          }
          results.push({ courseCode: code, success: false, error: e.message });
        }
      }

      return JSON.stringify({
        success: true,
        term: resolvedTerm,
        count: results.filter(r => r.success).length,
        outlines: results,
      }, null, 2);
    },
  },

  get_cached_outline: {
    description: `Return a previously-fetched course outline from local cache (no network request). Use this for quick access after you've already called get_course_outline or get_my_course_outlines. Returns null if the outline hasn't been fetched yet.`,
    schema: {
      courseCode: z.string().describe('Course code, e.g. "CS135"'),
      term: z.string().optional().describe('Term in YYMM format. Defaults to current term.'),
    },
    handler: async ({ courseCode, term, userId }: {
      courseCode: string;
      term?: string;
      userId: string;
    }): Promise<string> => {
      const resolvedTerm = term || getCurrentTerm();
      const normalizedCode = courseCode.trim().toUpperCase().replace(/\s+/g, "");

      const { data, error } = await supabase
        .from("course_outlines")
        .select("course_code, term, title, assessments, schedule, instructors, learning_objectives, outline_url, fetched_at")
        .eq("user_id", userId)
        .eq("course_code", normalizedCode)
        .eq("term", resolvedTerm)
        .single();

      if (error || !data) {
        return JSON.stringify({
          success: false,
          error: `No cached outline found for ${normalizedCode} term ${resolvedTerm}. Call get_course_outline to fetch it.`,
        }, null, 2);
      }

      return JSON.stringify({
        success: true,
        cachedAt: data.fetched_at,
        outline: {
          courseCode: data.course_code,
          term: data.term,
          title: data.title,
          url: data.outline_url,
          instructors: data.instructors,
          learningObjectives: data.learning_objectives,
          assessments: data.assessments,
          schedule: data.schedule,
        },
      }, null, 2);
    },
  },

};
