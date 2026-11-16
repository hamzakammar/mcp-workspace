import { z } from "zod";
import OpenAI from "openai";
import { supabase } from "../../utils/supabase.js";
import piazzaMap from "../db/piazza_map.json" with { type: "json" };
import { getPiazzaCookieHeader } from "../piazzaAuth.js";

type PiazzaMap = Record<string, string>; // courseId -> piazza nid

type PiazzaRpcEnvelope<T = any> = {
  result?: T;
  error?: any;
};

type FeedItem = {
  cid?: string;
  id?: string;
  subject?: string;
  created?: number;
  updated?: number;
};

type ContentGet = {
  subject?: string;
  created?: number;
  updated?: number;
  history?: Array<{ content?: string }>;
  tags?: string[];
  folders?: string[];
};

function getNidFromUrl(url: string): string {
  const m = url.match(/piazza\.com\/class\/([^/?#]+)/i);
  if (!m) throw new Error(`Could not parse nid from piazza_url: ${url}`);
  return m[1];
}

function unixToIso(ts?: number): string | null {
  if (!ts || typeof ts !== "number") return null;
  const ms = ts > 1e12 ? ts : ts * 1000; // seconds vs ms
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function cleanText(s: string): string {
  return (s || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBody(content: ContentGet): string {
  const hist = Array.isArray(content.history) ? content.history : [];
  const last = hist.length ? hist[hist.length - 1] : null;
  return cleanText(String(last?.content ?? ""));
}

function isHighSignal(text: string): boolean {
  const t = text.toLowerCase();
  const keys = [
    "assignment",
    "a1",
    "a2",
    "a3",
    "a4",
    "quiz",
    "midterm",
    "final",
    "due",
    "deadline",
    "extension",
    "grading",
    "grades",
    "exam",
    "test",
  ];
  return keys.some((k) => t.includes(k));
}

async function piazzaRpc<T>(cookieHeader: string, method: string, params: Record<string, any>): Promise<T> {
  // Extract session_id from cookies to use as CSRF token
  const sessionIdMatch = cookieHeader.match(/session_id=([^;]+)/);
  const csrfToken = sessionIdMatch ? sessionIdMatch[1] : "";

  const res = await fetch(`https://piazza.com/logic/api?method=${encodeURIComponent(method)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/plain, */*",
      "csrf-token": csrfToken,
      cookie: cookieHeader,
    },
    body: JSON.stringify({ method, params }),
  });

  const text = await res.text();

  // If we accidentally got HTML, it's almost always auth/cookies
  if (text.trim().startsWith("<!DOCTYPE html") || text.trim().startsWith("<html") || text.trim().startsWith("<")) {
    throw new Error(`Piazza API returned HTML (auth issue). First 180 chars: ${text.slice(0, 180)}`);
  }

  let json: PiazzaRpcEnvelope<T>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Piazza API returned non-JSON. HTTP ${res.status}. First 200 chars: ${text.slice(0, 200)}`);
  }

  if (!res.ok) throw new Error(`Piazza API HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (json.error) throw new Error(`Piazza API error for ${method}: ${JSON.stringify(json.error).slice(0, 400)}`);
  if (json.result === undefined) throw new Error(`Piazza API missing result for ${method}`);

  return json.result;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

  const openai = new OpenAI({ apiKey });
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  return response.data[0].embedding;
}

export async function upsertPiazzaPosts(
  userId: string,
  rows: Array<{
    user_id: string;
    course_id: string;
    post_id: string;
    title: string;
    body: string | null;
    url: string;
    created_at: string | null;
    updated_at: string | null;
    metadata: any;
  }>
) {
  if (!rows.length) return 0;

  // Posts whose title/body changed (or are new) must have their embedding cleared
  // so piazza_embed_missing re-embeds them. Unchanged posts keep their embedding.
  // If we can't read existing rows, fall back to clearing all (safe: just re-embeds).
  let changed = rows;
  let unchanged: typeof rows = [];
  const courseIds = [...new Set(rows.map((r) => r.course_id))];
  const { data: existing, error: selectError } = await supabase
    .from("piazza_posts")
    .select("course_id, post_id, title, body")
    .eq("user_id", userId)
    .in("course_id", courseIds)
    .in("post_id", rows.map((r) => r.post_id));

  if (!selectError && Array.isArray(existing)) {
    const prev = new Map<string, { title: string | null; body: string | null }>();
    for (const e of existing as any[]) prev.set(`${e.course_id}\u0000${e.post_id}`, { title: e.title ?? null, body: e.body ?? null });
    changed = [];
    for (const r of rows) {
      const p = prev.get(`${r.course_id}\u0000${r.post_id}`);
      if (p && p.title === r.title && (p.body ?? null) === (r.body ?? null)) unchanged.push(r);
      else changed.push(r);
    }
  }

  if (changed.length) {
    const { error } = await supabase
      .from("piazza_posts")
      .upsert(changed.map((r) => ({ ...r, embedding: null })), { onConflict: "user_id,course_id,post_id" });
    if (error) throw new Error(`Supabase upsert piazza_posts failed: ${error.message}`);
  }
  if (unchanged.length) {
    const { error } = await supabase
      .from("piazza_posts")
      .upsert(unchanged, { onConflict: "user_id,course_id,post_id" });
    if (error) throw new Error(`Supabase upsert piazza_posts failed: ${error.message}`);
  }
  return rows.length;
}

export const PiazzaTools = {
  piazza_sync: {
    description:
      "Sync recent Piazza posts via Piazza internal API (/logic/api) using SSO-auth cookies. Stores into piazza_posts. Includes purge of older posts to keep context bounded.",
    schema: {
      courseId: z.string().optional().describe("Limit sync to one course ID."),
      sinceDays: z.number().optional().describe("Only keep/fetch posts updated within this many days. Default 21."),
      maxPosts: z.number().optional().describe("Max feed items to consider per course. Default 40."),
      highSignalOnly: z.boolean().optional().describe("Keep only posts with high-signal keywords. Default true."),
    },
    handler: async ({
      courseId,
      sinceDays = 21,
      maxPosts = 40,
      highSignalOnly = true,
      userId,
    }: {
      courseId?: string;
      sinceDays?: number;
      maxPosts?: number;
      highSignalOnly?: boolean;
      userId: string;
    }): Promise<string> => {
      try {
        const map = piazzaMap as PiazzaMap;
        const selected = courseId ? { [courseId]: map[courseId] } : map;

        if (courseId && !map[courseId]) {
          return JSON.stringify({ success: false, error: `Course ${courseId} not found in piazza_map.json` }, null, 2);
        }

        // Get and validate cookies before proceeding
        let cookieHeader: string;
        try {
          cookieHeader = await getPiazzaCookieHeader(userId);
          // Additional validation: ensure session_id exists
          if (!cookieHeader || !cookieHeader.includes("session_id=")) {
            return JSON.stringify({ 
              success: false, 
              error: "Piazza authentication required. Please re-authenticate via mobile app WebView login.",
              requiresReauth: true
            }, null, 2);
          }
        } catch (authError) {
          const authErrorMsg = authError instanceof Error ? authError.message : String(authError);
          return JSON.stringify({ 
            success: false, 
            error: `Piazza authentication failed: ${authErrorMsg}`,
            requiresReauth: true
          }, null, 2);
        }
        const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

        let totalFetched = 0;
        let totalUpserted = 0;
        const details: any[] = [];

        for (const [course, nid] of Object.entries(selected)) {
          if (!nid) {
            details.push({ course, ok: false, error: "Missing nid in piazza_map.json" });
            continue;
          }

          try {
            // Purge old rows for this user+course to keep DB bounded
            const cutoffIso = new Date(cutoffMs).toISOString();
            await supabase
              .from("piazza_posts")
              .delete()
              .eq("user_id", userId)
              .eq("course_id", course)
              .lt("updated_at", cutoffIso);

            const piazzaUrl = `https://piazza.com/class/${nid}`;

            const feed = await piazzaRpc<any>(cookieHeader, "network.get_my_feed", {
              nid,
              limit: maxPosts,
              offset: 0,
              sort: "updated",
            });

            const items: FeedItem[] = feed?.feed ?? feed?.data ?? (Array.isArray(feed) ? feed : []);
            const rows: Array<{
              user_id: string;
              course_id: string;
              post_id: string;
              title: string;
              body: string | null;
              url: string;
              created_at: string | null;
              updated_at: string | null;
              metadata: any;
            }> = [];

            for (const it of items.slice(0, maxPosts)) {
              const cid = String(it?.cid ?? it?.id ?? "");
              if (!cid) continue;

              const content = await piazzaRpc<ContentGet>(cookieHeader, "content.get", { nid, cid });
              const title = (content?.subject ?? it?.subject ?? `Post ${cid}`).toString().trim();

              const body = extractBody(content);
              const createdAt = unixToIso(content?.created ?? it?.created);
              const updatedAt = unixToIso(content?.updated ?? it?.updated);

              // time filter if we can infer a timestamp
              const ts = (content?.updated ?? content?.created ?? it?.updated ?? it?.created ?? 0) as number;
              const tsMs = ts ? (ts > 1e12 ? ts : ts * 1000) : 0;
              if (tsMs && tsMs < cutoffMs) continue;

              const combined = `${title}\n${body}`;
              const high = isHighSignal(combined);
              if (highSignalOnly && !high) continue;

              rows.push({
                user_id: userId,
                course_id: course,
                post_id: cid,
                title,
                body: body || null,
                url: `${piazzaUrl.replace(/\/+$/, "")}?cid=${encodeURIComponent(cid)}`,
                created_at: createdAt,
                updated_at: updatedAt,
                metadata: {
                  tags: content?.tags ?? null,
                  folders: content?.folders ?? null,
                  high_signal: high,
                },
              });
            }

            totalFetched += rows.length;
            const upserted = await upsertPiazzaPosts(userId, rows);
            totalUpserted += upserted;

            details.push({ course, ok: true, nid, posts_fetched: rows.length, posts_upserted: upserted });
          } catch (e: any) {
            details.push({ course, ok: false, error: e?.message ?? String(e) });
          }
        }

        return JSON.stringify(
          {
            success: true,
            ran_at: new Date().toISOString(),
            posts_fetched: totalFetched,
            posts_upserted: totalUpserted,
            details,
          },
          null,
          2
        );
      } catch (error) {
        return JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
      }
    },
  },

  piazza_embed_missing: {
    description:
      "Generate embeddings for piazza_posts rows missing embeddings. Fetches rows with null embedding vectors, generates embeddings via OpenAI, and updates them. Resumable and skips short bodies.",
    schema: {
      courseId: z.string().optional().describe("Optionally filter by course ID."),
      limit: z.number().optional().describe("Maximum rows to process in this batch. Defaults to 100."),
      minChars: z.number().optional().describe("Skip posts shorter than this. Defaults to 200."),
    },
    handler: async ({
      courseId,
      limit = 100,
      minChars = 200,
      userId,
    }: {
      courseId?: string;
      limit?: number;
      minChars?: number;
      userId: string;
    }): Promise<string> => {
      try {
        // Page through rows with null embeddings using an id cursor so rows that are
        // skipped (too short / embed failure) don't get re-selected forever.
        const PAGE_SIZE = Math.max(limit, 100);
        const MAX_PAGES = 50;
        let lastId: string | null = null;
        let scanned = 0;
        let embedded = 0;
        let skipped = 0;
        const updates: Array<{ id: string; embedding: number[] }> = [];

        for (let page = 0; page < MAX_PAGES && updates.length < limit; page++) {
          let query = supabase
            .from("piazza_posts")
            .select("id, title, body")
            .eq("user_id", userId)
            .is("embedding", null);

          if (courseId) query = query.eq("course_id", courseId);
          if (lastId !== null) query = query.gt("id", lastId);

          const { data: rows, error } = await query.order("id", { ascending: true }).limit(PAGE_SIZE);
          if (error) return JSON.stringify({ success: false, error: error.message }, null, 2);
          if (!rows || rows.length === 0) break;
          scanned += rows.length;

          for (const row of rows as any[]) {
            lastId = row.id;
            if (updates.length >= limit) break;
            const title = row.title ?? "";
            const body = row.body ?? "";
            const text = `${title}\n\n${body}`.trim();

            if (text.length < minChars) {
              skipped++;
              continue;
            }

            try {
              const embedding = await generateEmbedding(text);
              updates.push({ id: row.id, embedding });
              embedded++;
              console.error(`[PZ-EMBED] Embedded ${row.id}`);
            } catch (e) {
              console.error(`[PZ-EMBED] Failed ${row.id}:`, e);
              skipped++;
            }
          }

          if (rows.length < PAGE_SIZE) break;
        }

        if (scanned === 0) {
          return JSON.stringify(
            { success: true, embedded: 0, skipped: 0, remaining: 0, message: "No rows with missing embeddings found" },
            null,
            2
          );
        }

        for (const u of updates) {
          const { error: updateError } = await supabase.from("piazza_posts").update({ embedding: u.embedding }).eq("id", u.id).eq("user_id", userId);
          if (updateError) console.error(`[PZ-EMBED] Update error ${u.id}:`, updateError);
        }

        // remaining count
        let remainingQuery = supabase
          .from("piazza_posts")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .is("embedding", null);
        if (courseId) remainingQuery = remainingQuery.eq("course_id", courseId);

        const { count: remaining } = await remainingQuery;

        return JSON.stringify(
          {
            success: true,
            embedded,
            skipped,
            remaining: remaining ?? 0,
            message: `Embedded ${embedded} rows, skipped ${skipped}`,
          },
          null,
          2
        );
      } catch (error) {
        return JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
      }
    },
  },

  piazza_semantic_search: {
    description:
      "Semantic search over piazza_posts using pgvector. Embeds the query with OpenAI then calls the match_piazza_posts RPC.",
    schema: {
      courseId: z.string().optional().describe("Optional course filter."),
      query: z.string().describe("Search query."),
      topK: z.number().optional().describe("Number of results. Defaults to 5."),
    },
    handler: async ({ courseId, query, topK = 5, userId }: { courseId?: string; query: string; topK?: number; userId: string }): Promise<string> => {
      try {
        if (!query) return JSON.stringify({ success: false, error: "query is required" }, null, 2);

        const qEmb = await generateEmbedding(query);

        const { data, error } = await supabase.rpc("match_piazza_posts", {
          query_embedding: qEmb,
          match_count: Math.max(topK, 5),
          course_filter: courseId ?? null,
          user_filter: userId,
        });

        if (error) return JSON.stringify({ success: false, error: error.message }, null, 2);

        return JSON.stringify(
          {
            success: true,
            query,
            courseId: courseId ?? null,
            count: (data ?? []).length,
            results: (data ?? []).slice(0, topK),
          },
          null,
          2
        );
      } catch (error) {
        return JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
      }
    },
  },

  piazza_suggest_for_item: {
    description:
      "Suggest relevant Piazza clarifications for a task/assignment. Embeds title+description and returns top 3 semantic matches.",
    schema: {
      courseId: z.string().describe("Course ID"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Optional task description"),
    },
    handler: async ({ courseId, title, description, userId }: { courseId: string; title: string; description?: string; userId: string }): Promise<string> => {
      const query = description ? `${title}\n${description}` : title;
      return await PiazzaTools.piazza_semantic_search.handler({ courseId, query, topK: 3, userId });
    },
  },
};
