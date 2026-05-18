#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assignmentTools } from "./tools/dropbox.js";
import { contentTools } from "./tools/content.js";
import { gradeTools } from "./tools/grades.js";
import { calendarTools } from "./tools/calendar.js";
import { newsTools } from "./tools/news.js";
import { enrollmentTools } from "./tools/enrollments.js";
import { downloadFile, readFile, deleteFile } from "./tools/files.js";
import { quizTools } from "./tools/quizzes.js";
import { rubricTools } from "./tools/rubric.js";
import { priorityTools } from "./tools/priority.js";
import { priorityGlobalTools } from "./tools/priorityGlobal.js";
import { discussionTools } from "./tools/discussions.js";
import { statusTools } from "./tools/status.js";
import { crowdmarkTools } from "./tools/crowdmark.js";
import { connectTools } from "./tools/connect.js";
import { notionTools, backgroundNotionSync } from "./tools/notion.js";
import { D2LClient } from "./client.js";
import { startSessionRefreshScheduler } from "./jobs/sessionRefresher.js";
import { startStorageStateTTLJob } from "./jobs/storageStateTTL.js";
import { deleteAllUserData } from "./utils/deleteUserData.js";
import { piazzaTools } from "./tools/piazza.js";
import { PlanningTools } from "./study/src/planning.js";
import { NotesTools } from "./study/src/notes.js";
import { SyncTools } from "./study/src/sync.js";
import { PiazzaTools } from "./study/src/piazza.js";
import { OutlineTools } from "./study/src/outline.js";
import { getUserId, runWithUserId } from "./utils/userContext.js";
import { embedText } from "./rag/embeddings.js";
import { semanticSearch } from "./rag/vectorStore.js";
import { authMiddleware } from "./api/auth.js";
import { isDuoRequired } from "./auth.js";
import apiRoutes from "./api/routes.js";
import d2lAuthRoutes from "./api/d2lAuthRoutes.js";
import publicAuthRoutes from "./api/publicAuthRoutes.js";
import { BrowserSessionManager } from "./browser/BrowserSessionManager.js";
import { fileURLToPath } from "url";

// ---- Urgency surfacing cache (Task 6) ----
// Caches upcoming-deadline check results per user+course for 15 minutes.
const urgencyCache: Record<
  string,
  { items: UrgentReminder[]; cachedAt: number }
> = {};
const URGENCY_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

interface UrgentReminder {
  title: string;
  dueIn: string;
  type: string;
}

function formatDueIn(isoDate: string): string {
  const diffMs = new Date(isoDate).getTime() - Date.now();
  if (diffMs <= 0) return 'overdue';
  const h = Math.round(diffMs / (1000 * 60 * 60));
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

async function getUrgentReminders(
  userId: string,
  orgUnitId: number
): Promise<UrgentReminder[]> {
  const cacheKey = `${userId}:${orgUnitId}`;
  const cached = urgencyCache[cacheKey];
  if (cached && Date.now() - cached.cachedAt < URGENCY_CACHE_TTL) {
    return cached.items;
  }
  try {
    const now = new Date();
    const deadline = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const d2lClient = new D2LClient(userId);
    const events = (await d2lClient.getMyCalendarEvents(
      orgUnitId,
      now.toISOString(),
      deadline.toISOString()
    )) as { Objects: Array<{ Title: string; EndDateTime: string; AssociatedEntity?: { AssociatedEntityType: string } }> };
    const items: UrgentReminder[] = (events.Objects || []).map((e) => {
      const et = e.AssociatedEntity?.AssociatedEntityType || '';
      const type = et.includes('Dropbox')
        ? 'assignment'
        : et.includes('Quiz')
        ? 'quiz'
        : 'event';
      return { title: e.Title, dueIn: formatDueIn(e.EndDateTime), type };
    });
    urgencyCache[cacheKey] = { items, cachedAt: Date.now() };
    return items;
  } catch {
    return [];
  }
}

// ---- Global deadline notifications (all courses, 7-day window) ----
interface GlobalDeadline {
  title: string;
  course: string;
  dueIn: string;
  dueDate: string;
}

const globalDeadlineCache: Record<string, { items: GlobalDeadline[]; cachedAt: number }> = {};
const GLOBAL_DEADLINE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function getGlobalDeadlines(userId: string): Promise<GlobalDeadline[]> {
  const cached = globalDeadlineCache[userId];
  if (cached && Date.now() - cached.cachedAt < GLOBAL_DEADLINE_CACHE_TTL) {
    return cached.items;
  }

  try {
    const d2lClient = new D2LClient(userId);
    const enrollmentsRaw = (await d2lClient.getMyEnrollments()) as { Items: Array<{
      OrgUnit: { Id: number; Name: string; Code: string; Type: { Code: string } };
      Access: { IsActive: boolean; CanAccess: boolean };
    }> };

    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const items: GlobalDeadline[] = [];

    // Only check active course offerings
    const courses = (enrollmentsRaw.Items || []).filter(e =>
      e.OrgUnit?.Type?.Code === 'Course Offering' && e.Access?.IsActive && e.Access?.CanAccess
    );

    // Fetch calendar events for all courses in parallel (7-day window)
    await Promise.all(courses.map(async (course) => {
      try {
        const events = (await d2lClient.getMyCalendarEvents(
          course.OrgUnit.Id,
          now.toISOString(),
          weekFromNow.toISOString()
        )) as { Objects: Array<{ Title: string; EndDateTime: string }> };

        for (const e of (events.Objects || [])) {
          items.push({
            title: e.Title,
            course: course.OrgUnit.Name.replace(/ Online - .*$/, ''),
            dueIn: formatDueIn(e.EndDateTime),
            dueDate: new Date(e.EndDateTime).toLocaleString('en-US', {
              timeZone: 'America/Toronto',
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            }),
          });
        }
      } catch { /* skip courses that fail */ }
    }));

    // Sort by urgency
    items.sort((a, b) => {
      const aMs = a.dueIn === 'overdue' ? -1 : parseInt(a.dueIn);
      const bMs = b.dueIn === 'overdue' ? -1 : parseInt(b.dueIn);
      return aMs - bMs;
    });

    globalDeadlineCache[userId] = { items, cachedAt: Date.now() };
    return items;
  } catch {
    return [];
  }
}

function createServer(): McpServer {
  console.error("[INIT] createServer() called - starting MCP server initialization");

  const server = new McpServer({
    name: "study-mcp",
    version: "1.0.0",
  });

  // Helper to wrap tool handlers with logging
  const wrapToolHandler = (
    toolName: string,
    handler: (args: any) => Promise<string>
  ) => {
    return async (args: any) => {
      const startTime = Date.now();
      console.error(`[TOOL] Starting tool execution: ${toolName}`);
      console.error(`[TOOL] Tool: ${toolName}, Args:`, JSON.stringify(args));
      try {
        const result = await handler(args);
        const elapsedTime = Date.now() - startTime;
        console.error(
          `[TOOL] Completed tool execution: ${toolName} (${elapsedTime}ms)`
        );
        // Prepend Duo warning if re-auth is needed
        const userId = getUserId();
        if (userId && userId !== "legacy") {
          const duoNeeded = await isDuoRequired(userId).catch(() => false);
          if (duoNeeded) {
            const host = process.env.API_HOST || "localhost:3000";
            const warning = `⚠️ Your D2L session has expired and requires Duo re-authentication.\nPlease visit https://${host}/onboard to reconnect.\n\n---\n\n`;
            return { content: [{ type: "text" as const, text: warning + result }] };
          }
        }

        // Append urgent reminders if args contain orgUnitId (Task 6)
        const effectiveUserId = userId || "legacy";
        const orgUnitId = args?.orgUnitId;
        if (orgUnitId && typeof orgUnitId === "number") {
          try {
            const urgentItems = await getUrgentReminders(effectiveUserId, orgUnitId);
            let finalResult = result;
            try {
              const parsed = JSON.parse(result);
              // Arrays don't support top-level keys in JSON.stringify —
              // wrap them so _urgentReminders is always a reachable field.
              const withReminders = Array.isArray(parsed)
                ? { results: parsed, _urgentReminders: urgentItems }
                : { ...parsed, _urgentReminders: urgentItems };
              finalResult = JSON.stringify(withReminders, null, 2);
            } catch {
              // Non-JSON result — skip injection entirely to avoid malformed output
              console.error(`[TOOL] ${toolName} returned non-JSON result; skipping _urgentReminders injection`);
            }
            return { content: [{ type: "text" as const, text: finalResult }] };
          } catch {
            // Urgency check failed — return original result unchanged
          }
        }
        // Fire-and-forget background Notion sync after successful tool calls
        const syncUserId = getUserId();
        if (syncUserId && syncUserId !== "legacy" && toolName !== "sync_to_notion") {
          backgroundNotionSync(syncUserId).catch(() => {});
        }

        // Inject global deadline notifications (7-day window, cached 30min)
        const deadlineUserId = userId || syncUserId;
        if (deadlineUserId && deadlineUserId !== "legacy") {
          try {
            const deadlines = await getGlobalDeadlines(deadlineUserId);
            if (deadlines.length > 0) {
              try {
                const parsed = JSON.parse(result);
                const withDeadlines = Array.isArray(parsed)
                  ? { results: parsed, _upcomingDeadlines: deadlines }
                  : { ...parsed, _upcomingDeadlines: deadlines };
                return { content: [{ type: "text" as const, text: JSON.stringify(withDeadlines, null, 2) }] };
              } catch {
                // Non-JSON result — append as text
                const deadlineText = `\n\n---\n📅 Upcoming deadlines (next 7 days):\n${deadlines.map(d => `  • ${d.title} (${d.course}) — ${d.dueDate}`).join('\n')}`;
                return { content: [{ type: "text" as const, text: result + deadlineText }] };
              }
            }
          } catch { /* deadline check failed, continue without */ }
        }

        return { content: [{ type: "text" as const, text: result }] };
      } catch (error: any) {
        const elapsedTime = Date.now() - startTime;
        console.error(
          `[TOOL] Tool execution failed: ${toolName} (${elapsedTime}ms)`,
          error
        );
        // Provide a helpful reauth message instead of a raw error string
        if (error?.message === "REAUTH_REQUIRED" || error?.message?.includes("REAUTH_REQUIRED")) {
          const host = process.env.API_HOST || "localhost:3000";
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Your D2L session has expired and requires Duo re-authentication.\n\nTo fix this:\n1. Visit https://${host}/onboard\n2. Click "Connect" next to D2L / Brightspace\n3. Complete the Duo MFA login in the browser window\n\nOnce re-authenticated, your tools will work again automatically.`,
            }],
            isError: true,
          };
        }
        throw error;
      }
    };
  };

  // Study tools: inject userId from MCP_USER_ID (or 'legacy') on each request
  const wrapStudyToolHandler = (
    toolName: string,
    handler: (args: any) => Promise<string>
  ) => {
    return wrapToolHandler(toolName, async (args: any) => {
      const userId = getUserId();
      return handler({ ...args, userId });
    });
  };

  // Register assignment tools
  server.tool(
    "get_assignments",
    assignmentTools.get_assignments.description,
    { orgUnitId: assignmentTools.get_assignments.schema.orgUnitId },
    wrapToolHandler("get_assignments", async (args) => {
      return await assignmentTools.get_assignments.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  server.tool(
    "get_assignment",
    assignmentTools.get_assignment.description,
    {
      orgUnitId: assignmentTools.get_assignment.schema.orgUnitId,
      assignmentId: assignmentTools.get_assignment.schema.assignmentId,
    },
    wrapToolHandler("get_assignment", async (args) => {
      return await assignmentTools.get_assignment.handler(
        args as { orgUnitId?: number; assignmentId: number }
      );
    })
  );

  server.tool(
    "get_assignment_submissions",
    assignmentTools.get_assignment_submissions.description,
    {
      orgUnitId: assignmentTools.get_assignment_submissions.schema.orgUnitId,
      assignmentId:
        assignmentTools.get_assignment_submissions.schema.assignmentId,
    },
    wrapToolHandler("get_assignment_submissions", async (args) => {
      return await assignmentTools.get_assignment_submissions.handler(
        args as { orgUnitId?: number; assignmentId: number }
      );
    })
  );

  // Register content tools
  server.tool(
    "get_course_content",
    contentTools.get_course_content.description,
    { orgUnitId: contentTools.get_course_content.schema.orgUnitId },
    wrapToolHandler("get_course_content", async (args) => {
      return await contentTools.get_course_content.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  server.tool(
    "get_course_topic",
    contentTools.get_course_topic.description,
    {
      orgUnitId: contentTools.get_course_topic.schema.orgUnitId,
      topicId: contentTools.get_course_topic.schema.topicId,
    },
    wrapToolHandler("get_course_topic", async (args) => {
      return await contentTools.get_course_topic.handler(
        args as { orgUnitId?: number; topicId: number }
      );
    })
  );

  server.tool(
    "get_course_modules",
    contentTools.get_course_modules.description,
    { orgUnitId: contentTools.get_course_modules.schema.orgUnitId },
    wrapToolHandler("get_course_modules", async (args) => {
      return await contentTools.get_course_modules.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  server.tool(
    "get_course_module",
    contentTools.get_course_module.description,
    {
      orgUnitId: contentTools.get_course_module.schema.orgUnitId,
      moduleId: contentTools.get_course_module.schema.moduleId,
    },
    wrapToolHandler("get_course_module", async (args) => {
      return await contentTools.get_course_module.handler(
        args as { orgUnitId?: number; moduleId: number }
      );
    })
  );

  // Register grade tools
  server.tool(
    "get_my_grades",
    gradeTools.get_my_grades.description,
    { orgUnitId: gradeTools.get_my_grades.schema.orgUnitId },
    wrapToolHandler("get_my_grades", async (args) => {
      return await gradeTools.get_my_grades.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  // Register calendar tools
  server.tool(
    "get_upcoming_due_dates",
    calendarTools.get_upcoming_due_dates.description,
    {
      orgUnitId: calendarTools.get_upcoming_due_dates.schema.orgUnitId,
      daysBack: calendarTools.get_upcoming_due_dates.schema.daysBack,
      daysAhead: calendarTools.get_upcoming_due_dates.schema.daysAhead,
    },
    wrapToolHandler("get_upcoming_due_dates", async (args) => {
      return await calendarTools.get_upcoming_due_dates.handler(
        args as { orgUnitId?: number; daysBack?: number; daysAhead?: number }
      );
    })
  );

  // Register news tools
  server.tool(
    "get_announcements",
    newsTools.get_announcements.description,
    {
      orgUnitId: newsTools.get_announcements.schema.orgUnitId,
      since: newsTools.get_announcements.schema.since,
    },
    wrapToolHandler("get_announcements", async (args) => {
      return await newsTools.get_announcements.handler(
        args as { orgUnitId?: number; since?: string }
      );
    })
  );

  // Register enrollment tools
  server.tool(
    "get_my_courses",
    enrollmentTools.get_my_courses.description,
    {},
    wrapToolHandler("get_my_courses", async () => {
      return await enrollmentTools.get_my_courses.handler();
    })
  );

  // Register file tools
  server.tool(
    "download_file",
    "Download a file from D2L Brightspace. Provide a D2L content URL (e.g., https://learn.ul.ie/content/enforced/68929-CS4444.../file.docx or /content/enforced/...). The file will be saved to your Downloads folder by default, or to a custom path if specified. Returns the local file path, filename, size, and content type. Use this to download lecture slides, assignment files, course materials, or any file linked in course content.",
    {
      url: z
        .string()
        .describe(
          "The D2L URL or path to the file to download (e.g., https://learn.ul.ie/content/enforced/68929-CS4444_SEM1_2025_6/file.docx)"
        ),
      savePath: z
        .string()
        .optional()
        .describe(
          "Optional: Custom path to save the file (directory or full file path). Defaults to ~/Downloads"
        ),
    },
    wrapToolHandler("download_file", async (args) => {
      const result = await downloadFile(args.url, args.savePath);
      const sizeKB = (result.size / 1024).toFixed(1);
      let text = `Downloaded: ${result.filename}\nPath: ${result.path}\nSize: ${sizeKB} KB\nType: ${result.contentType}`;

      if (result.content) {
        text += `\n\n--- File Content ---\n${result.content}`;
      }

      return text;
    })
  );

  server.tool(
    "read_file",
    "Read a file and extract its text content. Supports PDF, DOCX, TXT, MD, and other formats. Accepts: a note ID (UUID from uploaded notes), an S3 key (users/.../file.pdf), a filename (searched in Downloads), or a full path. Use this to read uploaded PDFs/notes or downloaded D2L files.",
    {
      filePath: z
        .string()
        .describe(
          "The file to read. Can be: a note ID (UUID), an S3 path (users/.../*.pdf), a filename (searched in Downloads), or a full filesystem path."
        ),
    },
    wrapToolHandler("read_file", async (args) => {
      const result = await readFile(args.filePath);
      const sizeKB = (result.size / 1024).toFixed(1);
      let text = `File: ${result.filename}\nPath: ${result.path}\nSize: ${sizeKB} KB\nType: ${result.contentType}`;

      if (result.content) {
        text += `\n\n--- File Content ---\n${result.content}`;
      } else {
        text += `\n\nNote: Could not extract text content from this file type. The file may be binary or unsupported.`;
      }

      return text;
    })
  );

  server.tool(
    "delete_file",
    "Delete a file from disk. Uses the same path resolution as read_file: you can pass a full path or just a filename (it will search your Downloads folder). Use this to clean up downloaded files after you are done reading them.",
    {
      filePath: z
        .string()
        .describe(
          "The file path or filename to delete. Can be a full path (e.g., /Users/username/Downloads/file.pdf) or just a filename (e.g., file.pdf) which will be searched in the Downloads folder."
        ),
    },
    wrapToolHandler("delete_file", async (args) => {
      const result = await deleteFile(args.filePath);
      return `Deleted file: ${result.filename}\nPath: ${result.path}`;
    })
  );

  // Register Piazza tools
  piazzaTools.forEach((tool) => {
    const schema = tool.inputSchema as z.ZodObject<any>;
    server.tool(
      tool.name,
      tool.description,
      schema.shape,
      wrapToolHandler(tool.name, tool.handler)
    );
  });

  // Register Planning tools (multi-user: userId injected from MCP_USER_ID)
  server.tool(
    "tasks_list",
    PlanningTools.tasks_list.description,
    PlanningTools.tasks_list.schema,
    wrapStudyToolHandler("tasks_list", PlanningTools.tasks_list.handler)
  );

  server.tool(
    "tasks_complete",
    PlanningTools.tasks_complete.description,
    PlanningTools.tasks_complete.schema,
    wrapStudyToolHandler("tasks_complete", PlanningTools.tasks_complete.handler)
  );

  server.tool(
    "notes_sync",
    NotesTools.notes_sync.description,
    NotesTools.notes_sync.schema,
    wrapStudyToolHandler("notes_sync", NotesTools.notes_sync.handler)
  );

  server.tool(
    "notes_search",
    NotesTools.notes_search.description,
    NotesTools.notes_search.schema,
    wrapStudyToolHandler("notes_search", NotesTools.notes_search.handler)
  );

  server.tool(
    "notes_suggest_for_item",
    NotesTools.notes_suggest_for_item.description,
    NotesTools.notes_suggest_for_item.schema,
    wrapStudyToolHandler("notes_suggest_for_item", NotesTools.notes_suggest_for_item.handler)
  );

  server.tool(
    "notes_embed_missing",
    NotesTools.notes_embed_missing.description,
    NotesTools.notes_embed_missing.schema,
    wrapStudyToolHandler("notes_embed_missing", NotesTools.notes_embed_missing.handler)
  );

  // RAG semantic search over note_chunks (vector embeddings in note_chunks table)
  server.tool(
    "semantic_search_notes",
    "Semantic (vector) search over your note chunks using AI embeddings. Returns the most relevant note passages for a given query, ranked by cosine similarity. Optionally filter by course ID.",
    {
      query: z.string().describe("Natural language search query (e.g., 'integration by parts', 'Newton's second law')."),
      courseId: z.string().optional().describe("Optionally restrict search to a specific course ID (e.g., 'MATH119')."),
      limit: z.number().optional().describe("Maximum number of results to return. Defaults to 10."),
    },
    wrapStudyToolHandler("semantic_search_notes", async ({ query, courseId, limit = 10, userId }: { query: string; courseId?: string; limit?: number; userId: string }) => {
      if (!query) {
        return JSON.stringify({ success: false, error: "query is required" }, null, 2);
      }
      try {
        const queryEmbedding = await embedText(query);
        const results = await semanticSearch(userId, queryEmbedding, courseId, limit);
        if (results.length === 0) {
          return JSON.stringify({ success: true, query, courseId, count: 0, results: [], message: "No matching note chunks found" }, null, 2);
        }
        const formatted = results.map((r) => ({
          similarity: Math.round(r.similarity * 1000) / 1000,
          courseId: r.courseId,
          chunkIndex: r.chunkIndex,
          preview: r.content.slice(0, 300),
          metadata: r.metadata,
        }));
        return JSON.stringify({ success: true, query, courseId, count: formatted.length, results: formatted }, null, 2);
      } catch (error) {
        return JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
      }
    })
  );

  server.tool(
    "sync_all",
    SyncTools.sync_all.description,
    SyncTools.sync_all.schema,
    wrapStudyToolHandler("sync_all", SyncTools.sync_all.handler)
  );

  server.tool(
    "plan_week",
    PlanningTools.plan_week.description,
    PlanningTools.plan_week.schema,
    wrapStudyToolHandler("plan_week", PlanningTools.plan_week.handler)
  );

  server.tool(
    "tasks_add",
    PlanningTools.tasks_add.description,
    PlanningTools.tasks_add.schema,
    wrapStudyToolHandler("tasks_add", PlanningTools.tasks_add.handler)
  );

  // Register Piazza study tools (multi-user: userId injected from MCP_USER_ID)
  server.tool(
    "piazza_sync",
    PiazzaTools.piazza_sync.description,
    PiazzaTools.piazza_sync.schema,
    wrapStudyToolHandler("piazza_sync", PiazzaTools.piazza_sync.handler)
  );

  server.tool(
    "piazza_embed_missing",
    PiazzaTools.piazza_embed_missing.description,
    PiazzaTools.piazza_embed_missing.schema,
    wrapStudyToolHandler("piazza_embed_missing", PiazzaTools.piazza_embed_missing.handler)
  );

  server.tool(
    "piazza_semantic_search",
    PiazzaTools.piazza_semantic_search.description,
    PiazzaTools.piazza_semantic_search.schema,
    wrapStudyToolHandler("piazza_semantic_search", PiazzaTools.piazza_semantic_search.handler)
  );

  server.tool(
    "piazza_suggest_for_item",
    PiazzaTools.piazza_suggest_for_item.description,
    PiazzaTools.piazza_suggest_for_item.schema,
    wrapStudyToolHandler("piazza_suggest_for_item", PiazzaTools.piazza_suggest_for_item.handler)
  );

  // Register outline tools (outline.uwaterloo.ca)
  server.tool(
    "get_course_outline",
    OutlineTools.get_course_outline.description,
    OutlineTools.get_course_outline.schema,
    wrapStudyToolHandler("get_course_outline", OutlineTools.get_course_outline.handler)
  );

  server.tool(
    "get_my_course_outlines",
    OutlineTools.get_my_course_outlines.description,
    OutlineTools.get_my_course_outlines.schema,
    wrapStudyToolHandler("get_my_course_outlines", OutlineTools.get_my_course_outlines.handler)
  );

  server.tool(
    "get_cached_outline",
    OutlineTools.get_cached_outline.description,
    OutlineTools.get_cached_outline.schema,
    wrapStudyToolHandler("get_cached_outline", OutlineTools.get_cached_outline.handler)
  );

  // Register quiz tools (Task 2)
  server.tool(
    "get_quizzes",
    quizTools.get_quizzes.description,
    { orgUnitId: quizTools.get_quizzes.schema.orgUnitId },
    wrapToolHandler("get_quizzes", async (args) => {
      return await quizTools.get_quizzes.handler(args as { orgUnitId: number });
    })
  );

  // Register rubric tool (Task 4)
  server.tool(
    "get_assignment_rubric",
    rubricTools.get_assignment_rubric.description,
    {
      orgUnitId: rubricTools.get_assignment_rubric.schema.orgUnitId,
      folderId: rubricTools.get_assignment_rubric.schema.folderId,
    },
    wrapToolHandler("get_assignment_rubric", async (args) => {
      return await rubricTools.get_assignment_rubric.handler(
        args as { orgUnitId: number; folderId: number }
      );
    })
  );

  // Register priority tool (Task 5)
  server.tool(
    "what_should_i_work_on",
    priorityTools.what_should_i_work_on.description,
    {
      orgUnitId: priorityTools.what_should_i_work_on.schema.orgUnitId,
      hoursAhead: priorityTools.what_should_i_work_on.schema.hoursAhead,
    },
    wrapToolHandler("what_should_i_work_on", async (args) => {
      return await priorityTools.what_should_i_work_on.handler(
        args as { orgUnitId: number; hoursAhead?: number }
      );
    })
  );

  server.tool(
    "what_should_i_work_on_global",
    priorityGlobalTools.what_should_i_work_on_global.description,
    {
      hoursAhead: priorityGlobalTools.what_should_i_work_on_global.schema.hoursAhead,
    },
    wrapToolHandler("what_should_i_work_on_global", async (args) => {
      return await priorityGlobalTools.what_should_i_work_on_global.handler(
        args as { hoursAhead?: number }
      );
    })
  );

  // Register discussion boards tool (Task 11)
  server.tool(
    "get_discussion_boards",
    discussionTools.get_discussion_boards.description,
    { orgUnitId: discussionTools.get_discussion_boards.schema.orgUnitId },
    wrapToolHandler("get_discussion_boards", async (args) => {
      return await discussionTools.get_discussion_boards.handler(args as { orgUnitId: number });
    })
  );

  // Register Crowdmark tools (Task 9)
  server.tool(
    "get_crowdmark_assignments",
    crowdmarkTools.get_crowdmark_assignments.description,
    {},
    wrapToolHandler("get_crowdmark_assignments", async () => {
      return await crowdmarkTools.get_crowdmark_assignments.handler();
    })
  );

  server.tool(
    "get_crowdmark_feedback",
    crowdmarkTools.get_crowdmark_feedback.description,
    { assignmentId: crowdmarkTools.get_crowdmark_feedback.schema.assignmentId },
    wrapToolHandler("get_crowdmark_feedback", async (args) => {
      return await crowdmarkTools.get_crowdmark_feedback.handler(args as { assignmentId: string });
    })
  );

  // Register connect tools (optional integration setup via MCP)
  server.tool(
    "connect_crowdmark",
    connectTools.connect_crowdmark.description,
    connectTools.connect_crowdmark.schema,
    wrapToolHandler("connect_crowdmark", async (args) => {
      return await connectTools.connect_crowdmark.handler(args as { cookie: string });
    })
  );

  server.tool(
    "connect_outline",
    connectTools.connect_outline.description,
    connectTools.connect_outline.schema,
    wrapToolHandler("connect_outline", async (args) => {
      return await connectTools.connect_outline.handler(args as { cookie: string });
    })
  );

  server.tool(
    "connect_piazza",
    connectTools.connect_piazza.description,
    connectTools.connect_piazza.schema,
    wrapToolHandler("connect_piazza", async (args) => {
      return await connectTools.connect_piazza.handler(args as { email: string; password: string });
    })
  );

  server.tool(
    "get_connection_guide",
    connectTools.get_connection_guide.description,
    connectTools.get_connection_guide.schema,
    wrapToolHandler("get_connection_guide", async (args) => {
      return await connectTools.get_connection_guide.handler(args as { service?: string });
    })
  );

  server.tool(
    "connect_notion",
    connectTools.connect_notion.description,
    connectTools.connect_notion.schema,
    wrapToolHandler("connect_notion", async () => {
      return await connectTools.connect_notion.handler();
    })
  );

  server.tool(
    "sync_to_notion",
    notionTools.sync_to_notion.description,
    notionTools.sync_to_notion.schema,
    wrapToolHandler("sync_to_notion", async (args) => {
      return await notionTools.sync_to_notion.handler(args as { databaseId: string });
    })
  );

  // Register horizon status tool (Task 12)
  server.tool(
    "get_horizon_status",
    statusTools.get_horizon_status.description,
    {},
    wrapToolHandler("get_horizon_status", async () => {
      return await statusTools.get_horizon_status.handler();
    })
  );

  // delete_my_data — wipe all user data traces from the system
  server.tool(
    "delete_my_data",
    "Permanently delete all your stored data from Horizon. " +
      "This removes your D2L and Piazza credentials, session cookies, S3 browser state, and API key. " +
      "You will need to re-authenticate from scratch after calling this tool. " +
      "This action cannot be undone.",
    {},
    async () => {
      const userId = getUserId();
      if (!userId || userId === "legacy") {
        return {
          content: [{ type: "text" as const, text: "Error: could not determine your user ID. Please re-authenticate and try again." }],
        };
      }

      const result = await deleteAllUserData(userId);
      const summary = [
        `Supabase credentials: ${result.deleted.supabaseCredentials ? "✓ deleted" : "✗ failed"}`,
        `Supabase API key:     ${result.deleted.supabaseApiKey ? "✓ deleted" : "✗ failed"}`,
        `S3 browser state:     ${result.deleted.s3State ? "✓ deleted" : "✗ failed"}`,
        `D2L disk session:     ${result.deleted.diskD2lSession ? "✓ deleted" : "✗ failed"}`,
        `Piazza disk session:  ${result.deleted.diskPiazzaSession ? "✓ deleted" : "✗ failed"}`,
      ].join("\n");

      const errorsSection = result.errors.length > 0
        ? `\n\nErrors encountered:\n${result.errors.map((e) => `  • ${e}`).join("\n")}`
        : "";

      const allOk = result.errors.length === 0;
      return {
        content: [
          {
            type: "text" as const,
            text: allOk
              ? `All your data has been deleted from Horizon.\n\n${summary}`
              : `Partial deletion — some items could not be removed.\n\n${summary}${errorsSection}`,
          },
        ],
      };
    }
  );

  return server;
}

async function main() {
  const transportType = process.env.MCP_TRANSPORT?.toLowerCase() || "http";

  if (transportType === "stdio") {
    // Use stdio transport (manual selection)
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("D2L Brightspace MCP server running on stdio");
  } else if (transportType === "http" || transportType === "https") {
    // Require STUDY_MCP_TOKEN — no unauthenticated mode
    const mcpToken = process.env.STUDY_MCP_TOKEN;
    if (!mcpToken) {
      console.error(
        "[STARTUP] FATAL: STUDY_MCP_TOKEN is not set.\n" +
        "The MCP endpoint requires authentication. Generate a token with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        "Then set STUDY_MCP_TOKEN=<generated-token> in your environment."
      );
      process.exit(1);
    }

    // Use HTTP transport with StreamableHTTPServerTransport
    const port = process.env.MCP_PORT
      ? parseInt(process.env.MCP_PORT, 10)
      : 3000;
    const app = express();

    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.use(
      cors({
        origin: "*",
        exposedHeaders: ["Mcp-Session-Id"],
      })
    );

    // Health check (no auth) for ALB / load balancers
    app.get("/health", (_req, res) => res.json({ ok: true }));

    // Onboarding page (no auth)
    const publicDir = path.join(process.cwd(), "dist", "public");
    app.use(express.static(publicDir));
    app.get("/onboard", (req, res) => {
      const filePath = path.join(publicDir, "onboard.html");
      console.error(`[ONBOARD] Serving from: ${filePath}`);
      // Always serve the latest onboarding page (avoid stale browser/CDN caches).
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.sendFile(filePath, (err) => {
        if (err) {
          console.error(`[ONBOARD] sendFile error:`, err);
          res.status(500).send(`File not found: ${filePath}`);
        }
      });

      // Record page view (fire-and-forget)
      try {
        import("crypto").then(({ createHash }) => {
          const raw = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
          const ip_hash = createHash("sha256").update(raw.split(",")[0].trim()).digest("hex").slice(0, 16);
          const sbUrl = process.env.SUPABASE_URL;
          const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
          if (sbUrl && sbKey) {
            fetch(`${sbUrl}/rest/v1/page_views`, {
              method: "POST",
              headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
              body: JSON.stringify({ path: "/onboard", ip_hash, user_agent: (req.headers["user-agent"] || "").slice(0, 200) }),
            }).catch(() => {});
          }
        }).catch(() => {});
      } catch {}
    });

    // Page view stats (no auth — internal use)
    app.get("/admin/stats", async (_req, res) => {
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      if (!sbUrl || !sbKey) return res.status(500).json({ error: "No Supabase config" });
      const headers = { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` };

      const [todayResp, weekResp, totalResp, uniqueResp] = await Promise.all([
        fetch(`${sbUrl}/rest/v1/page_views?path=eq./onboard&created_at=gte.${new Date(new Date().setHours(0,0,0,0)).toISOString()}&select=id`, { headers }),
        fetch(`${sbUrl}/rest/v1/page_views?path=eq./onboard&created_at=gte.${new Date(Date.now()-7*86400000).toISOString()}&select=id`, { headers }),
        fetch(`${sbUrl}/rest/v1/page_views?path=eq./onboard&select=id`, { headers }),
        fetch(`${sbUrl}/rest/v1/page_views?path=eq./onboard&select=ip_hash`, { headers }),
      ]);

      const [today, week, total, unique] = await Promise.all([todayResp.json(), weekResp.json(), totalResp.json(), uniqueResp.json()]) as [any[], any[], any[], any[]];
      const uniqueVisitors = new Set(unique.map((r: any) => r.ip_hash)).size;

      res.json({
        onboard: {
          today: today.length,
          last7days: week.length,
          allTime: total.length,
          uniqueVisitors,
        }
      });
    });

    // Public auth routes (signup/signin for onboarding — no JWT required)
    app.use("/auth", publicAuthRoutes);

    // D2L auth routes (browser streaming)
    app.use("/", d2lAuthRoutes);

    // REST API (app-first): /api/notes, /api/search, /api/dashboard
    app.use("/api", authMiddleware, apiRoutes);

    // Map to store transports by session ID
    const transports: Record<string, StreamableHTTPServerTransport> = {};
    
    // Session persistence
    const SESSION_FILE = path.join(process.cwd(), '.mcp-sessions.json');
    const validSessionIds = new Set<string>();
    
    // Load persisted sessions on startup
    async function loadSessions() {
      try {
        const data = await fs.readFile(SESSION_FILE, 'utf-8');
        const sessions = JSON.parse(data);
        sessions.forEach((id: string) => validSessionIds.add(id));
        console.error(`[SESSION] Loaded ${validSessionIds.size} persisted session(s)`);
      } catch {
        console.error('[SESSION] No existing sessions file found, starting fresh');
      }
    }
    
    // Save sessions to disk
    async function saveSessions() {
      try {
        const sessions = Array.from(validSessionIds);
        await fs.writeFile(SESSION_FILE, JSON.stringify(sessions, null, 2));
        console.error(`[SESSION] Saved ${sessions.length} session(s) to disk`);
      } catch (error) {
        console.error('[SESSION] Failed to save sessions:', error);
      }
    }
    
    // Load sessions on startup
    await loadSessions();

    // MCP POST endpoint
    const mcpPostHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      // Auth: accept requests that came through the gateway (X-User-Id injected after JWT
      // validation) OR direct requests with the STUDY_MCP_TOKEN (localhost only).
      const token = process.env.STUDY_MCP_TOKEN!;
      const authHeader = req.headers["authorization"] || req.headers["Authorization"];
      const xUserId = req.headers["x-user-id"] as string;
      if (!xUserId && (!authHeader || authHeader !== `Bearer ${token}`)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      // Extract userId from X-User-Id header (injected by Go gateway after JWT verification)
      const requestUserId = xUserId || "legacy";

      return runWithUserId(requestUserId, async () => {
      const requestStartTime = Date.now();
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const requestMethod = req.body?.method || "unknown";
      const requestId = req.body?.id || null;
      const requestParams = req.body?.params || {};

      console.error(`[MCP] POST request received`);
      console.error(
        `[MCP] Session ID: ${sessionId || "none (initialization)"}`
      );
      console.error(`[MCP] Method: ${requestMethod}`);
      console.error(`[MCP] Request ID: ${requestId}`);
      console.error(`[MCP] Active sessions: ${Object.keys(transports).join(', ') || 'none'}`);
      console.error(`[MCP] Headers:`, JSON.stringify(req.headers, null, 2));
      if (requestMethod === "tools/call") {
        console.error(
          `[MCP] Tool: ${requestParams.name || "unknown"}, Args:`,
          JSON.stringify(requestParams.arguments || {})
        );
      }

      try {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          // Reuse existing transport
          console.error(
            `[MCP] Reusing existing transport for session: ${sessionId}`
          );
          transport = transports[sessionId];
        } else if (sessionId) {
          // Session ID provided but no transport in memory (server restarted or new container)
          // Silently restore the session regardless of whether we've seen it before
          console.error(
            `[MCP] Silently restoring session ${sessionId} after server restart`
          );
          
          const initStartTime = Date.now();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId, // Reuse the persisted session ID
            onsessioninitialized: (sid: string) => {
              const initTime = Date.now() - initStartTime;
              console.error(`[MCP] Session silently restored: ${sid} (${initTime}ms)`);
              // Don't wait - already setting transports[sid] below
            },
            onsessionclosed: (sid: string) => {
              console.error(`[MCP] Session closed: ${sid}`);
              delete transports[sid];
              validSessionIds.delete(sid);
              void saveSessions();
            },
          });
          
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              console.error(`[MCP] Transport closed for session ${sid}`);
              delete transports[sid];
            }
          };

          // Connect server to transport
          const server = createServer();
          await server.connect(transport);
          
          // IMPORTANT: Manually set the sessionId and mark as initialized
          // This bypasses the normal initialize handshake
          (transport as any).sessionId = sessionId;
          (transport as any)._initialized = true;
          
          // Store transport immediately
          transports[sessionId] = transport;
          
          // Now handle the actual request through the restored transport
          await transport.handleRequest(req, res, req.body);
          const totalTime = Date.now() - requestStartTime;
          console.error(`[MCP] Session restored and request handled (${totalTime}ms)`);
          return;
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request
          const initStartTime = Date.now();
          console.error(`[MCP] Creating new transport for initialization`);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId: string) => {
              const initTime = Date.now() - initStartTime;
              console.error(
                `[MCP] Session initialized with ID: ${sessionId} (${initTime}ms)`
              );
              transports[sessionId] = transport;
              validSessionIds.add(sessionId);
              void saveSessions();
            },
            onsessionclosed: (sessionId: string) => {
              console.error(`[MCP] Session closed: ${sessionId}`);
              delete transports[sessionId];
              validSessionIds.delete(sessionId);
              void saveSessions();
            },
          });

          // Set up onclose handler to clean up transport when closed
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              console.error(
                `[MCP] Transport closed for session ${sid}, removing from transports map`
              );
              delete transports[sid];
            }
          };

          // Connect the transport to the MCP server BEFORE handling the request
          const server = createServer();
          const connectStartTime = Date.now();
          await server.connect(transport);
          const connectTime = Date.now() - connectStartTime;
          console.error(
            `[MCP] Server connected to transport (${connectTime}ms)`
          );

          const handleStartTime = Date.now();
          await transport.handleRequest(req, res, req.body);
          const handleTime = Date.now() - handleStartTime;
          const totalTime = Date.now() - requestStartTime;
          console.error(
            `[MCP] Request handled (${handleTime}ms, total: ${totalTime}ms)`
          );
          return; // Already handled
        } else {
          // Invalid request - no session ID or not initialization request
          const totalTime = Date.now() - requestStartTime;
          console.error(
            `[MCP] Invalid request - no session ID or not initialization (${totalTime}ms)`
          );
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
          });
          return;
        }

        // Handle the request with existing transport
        const handleStartTime = Date.now();
        await transport.handleRequest(req, res, req.body);
        const handleTime = Date.now() - handleStartTime;
        const totalTime = Date.now() - requestStartTime;
        console.error(
          `[MCP] Request handled (${handleTime}ms, total: ${totalTime}ms)`
        );
      } catch (error) {
        const totalTime = Date.now() - requestStartTime;
        console.error(
          `[MCP] Error handling MCP request (${totalTime}ms):`,
          error
        );
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
      }); // end runWithUserId
    };

    app.post("/mcp", mcpPostHandler);

    // Handle GET requests for SSE streams
    const mcpGetHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      // Auth: accept requests that came through the gateway (X-User-Id injected after JWT
      // validation) OR direct requests with the STUDY_MCP_TOKEN (localhost only).
      const token = process.env.STUDY_MCP_TOKEN!;
      const authHeader = req.headers["authorization"] || req.headers["Authorization"];
      if (!req.headers["x-user-id"] && (!authHeader || authHeader !== `Bearer ${token}`)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const requestStartTime = Date.now();
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      console.error(`[MCP] GET request received`);
      console.error(`[MCP] Session ID: ${sessionId || "none"}`);

      if (!sessionId || !transports[sessionId]) {
        const totalTime = Date.now() - requestStartTime;
        console.error(`[MCP] Invalid or missing session ID (${totalTime}ms)`);
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      const lastEventId = req.headers["last-event-id"] as string | undefined;
      if (lastEventId) {
        console.error(
          `[MCP] Client reconnecting with Last-Event-ID: ${lastEventId}`
        );
      } else {
        console.error(
          `[MCP] Establishing new SSE stream for session ${sessionId}`
        );
      }

      const transport = transports[sessionId];
      const handleStartTime = Date.now();
      await transport.handleRequest(req, res);
      const handleTime = Date.now() - handleStartTime;
      const totalTime = Date.now() - requestStartTime;
      console.error(
        `[MCP] GET request handled (${handleTime}ms, total: ${totalTime}ms)`
      );
    };

    app.get("/mcp", mcpGetHandler);

    // Handle DELETE requests for session termination
    const mcpDeleteHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      // Auth: accept requests that came through the gateway (X-User-Id injected after JWT
      // validation) OR direct requests with the STUDY_MCP_TOKEN (localhost only).
      const token = process.env.STUDY_MCP_TOKEN!;
      const authHeader = req.headers["authorization"] || req.headers["Authorization"];
      if (!req.headers["x-user-id"] && (!authHeader || authHeader !== `Bearer ${token}`)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const requestStartTime = Date.now();
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      console.error(`[MCP] DELETE request received`);
      console.error(`[MCP] Session ID: ${sessionId || "none"}`);

      if (!sessionId || !transports[sessionId]) {
        const totalTime = Date.now() - requestStartTime;
        console.error(`[MCP] Invalid or missing session ID (${totalTime}ms)`);
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      console.error(
        `[MCP] Received session termination request for session ${sessionId}`
      );
      try {
        const transport = transports[sessionId];
        const handleStartTime = Date.now();
        await transport.handleRequest(req, res);
        const handleTime = Date.now() - handleStartTime;
        const totalTime = Date.now() - requestStartTime;
        console.error(
          `[MCP] DELETE request handled (${handleTime}ms, total: ${totalTime}ms)`
        );
      } catch (error) {
        const totalTime = Date.now() - requestStartTime;
        console.error(
          `[MCP] Error handling session termination (${totalTime}ms):`,
          error
        );
        if (!res.headersSent) {
          res.status(500).send("Error processing session termination");
        }
      }
    };

    app.delete("/mcp", mcpDeleteHandler);

    // Bind to 127.0.0.1 only — the Go gateway proxies inbound traffic.
    // External clients cannot reach this port directly.
    const httpServer = app.listen(port, "127.0.0.1", () => {
      console.error(`D2L Brightspace MCP server running on http://127.0.0.1:${port}`);
      console.error(`(Accessible via reverse proxy only — not bound to 0.0.0.0)`);
    });

    // Forward WebSocket upgrade events to the VNC proxy middleware
    // Without this, noVNC WebSocket connections silently fail through the ALB
    httpServer.on("upgrade", (req, socket, head) => {
      const match = req.url?.match(/^\/vnc\/([^/]+)\/websockify/);
      if (match) {
        const sessionId = match[1];
        const session = BrowserSessionManager.getSession(sessionId);
        if (session) {
          const wsProxy = createProxyMiddleware({
            target: `http://localhost:${session.wsPort}`,
            ws: true,
            changeOrigin: true,
            pathRewrite: { [`^/vnc/${sessionId}/websockify`]: "/" },
          });
          wsProxy.upgrade(req, socket as any, head);
        } else {
          socket.destroy();
        }
      }
    });

    // Handle server shutdown
    const shutdown = async () => {
      console.error("Shutting down server...");
      for (const sessionId in transports) {
        try {
          await transports[sessionId].close();
          delete transports[sessionId];
        } catch {}
      }
      await BrowserSessionManager.closeAll();
      console.error("Server shutdown complete");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Session refresh scheduler — headless cookie refresh every 30min,
    // with credential-based fallback when ADFS state expires.
    startSessionRefreshScheduler();

    // Storage state TTL job — daily check; marks duo_required for expired S3 states.
    startStorageStateTTLJob();
  } else {
    console.error(
      `Invalid MCP_TRANSPORT value: ${transportType}. Must be 'stdio', 'http', or 'https'`
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
