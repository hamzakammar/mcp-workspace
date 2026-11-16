// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Router, IRequest } from "npm:itty-router@4";
import pdf from "npm:pdf-parse@1.1.1";
import mammoth from "npm:mammoth@1.7.2";

// --- CORS ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

// --- Types ---
interface PiazzaSyncRequestBody {
  courseId?: string;
  sinceDays?: number;
  maxPosts?: number;
  highSignalOnly?: boolean;
}

interface PresignUploadRequestBody {
  filename: string;
  contentType: string;
  size: number;
}

interface ProcessNoteRequestBody {
  storagePath: string;
  title: string;
  courseId?: string;
  bucket?: string;
}

// --- Supabase Service Role Client ---
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// --- File Processing Helpers ---
async function extractContent(data: ArrayBuffer, contentType: string): Promise<string | null> {
  const lowerContentType = contentType.toLowerCase();
  if (lowerContentType.startsWith("text/")) {
    return new TextDecoder().decode(data);
  }
  if (lowerContentType === "application/pdf") {
    try {
      const pdfData = await pdf(new Uint8Array(data));
      return pdfData?.text || null;
    } catch (error: any) {
      console.error(`[PDF] Error parsing PDF: ${error?.message || error}`);
      throw new Error("Failed to parse PDF file. It may be corrupted or encrypted.");
    }
  }
  if (lowerContentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const result = await mammoth.extractRawText({ arrayBuffer: data });
      return result.value;
    } catch (error: any) {
      console.error(`[DOCX] Error parsing DOCX: ${error?.message || error}`);
      throw new Error("Failed to parse DOCX file.");
    }
  }
  console.warn(`Unsupported content type for text extraction: ${contentType}`);
  return null;
}

function chunkText(text: string, { chunkSize = 1500, chunkOverlap = 200 } = {}): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    chunks.push(text.slice(i, end));
    i += chunkSize - chunkOverlap;
    if (i < 0) i = end;
  }
  return chunks;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    console.warn("OPENAI_API_KEY not set. Skipping embedding generation.");
    return [];
  }
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text.replace(/\n/g, " "),
      model: "text-embedding-3-small",
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }
  const json = await response.json();
  return json.data[0].embedding;
}

async function embedNoteSections(supabase: SupabaseClient, userId: string, noteId: string): Promise<number> {
  const { data: sections } = await supabase
    .from("note_sections")
    .select("id, content")
    .eq("note_id", noteId)
    .is("embedding", null);

  if (!sections || sections.length === 0) return 0;

  let count = 0;
  for (const section of sections) {
    try {
      const embedding = await generateEmbedding(section.content);
      if (embedding.length > 0) {
        await supabase.from("note_sections").update({ embedding }).eq("id", section.id);
        count++;
      }
    } catch (e: any) {
      console.error(`Failed to embed section ${section.id}:`, e);
    }
  }
  return count;
}

// --- D2L Helpers ---
async function getD2LCredentials(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_credentials")
    .select("host, token, updated_at")
    .eq("user_id", userId)
    .eq("service", "d2l")
    .single();
  if (error || !data) return null;
  return data;
}

async function fetchD2L(host: string, path: string, cookieHeader: string) {
  const url = `https://${host}${path}`;
  const response = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      Accept: "application/json",
    },
  });
  if (response.status === 401 || response.status === 403) throw new Error("REAUTH_REQUIRED");
  if (!response.ok) throw new Error(`D2L API Error: ${response.status}`);
  return response.json();
}

// --- Marshal Helpers ---
function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function formatDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  return new Date(isoDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function marshalAnnouncements(announcements: any[]): any[] {
  return announcements.map((a) => ({
    id: a.Id,
    title: a.Title,
    body: stripHtml(a.Body.Text || a.Body.Html),
    date: formatDate(a.CreatedDate),
  }));
}

// --- Push Notification Helpers ---
async function sendPushToUser(supabase: SupabaseClient, userId: string, title: string, body: string, data?: any) {
  const { data: tokens } = await supabase.from("device_tokens").select("device_token").eq("user_id", userId);
  if (!tokens || tokens.length === 0) return;
  const messages = tokens.map((t: any) => ({ to: t.device_token, sound: "default", title, body, data }));
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messages),
  });
}

// --- Piazza Helpers ---
async function getPiazzaCookieHeader(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("user_credentials")
    .select("token")
    .eq("user_id", userId)
    .eq("service", "piazza")
    .single();
  if (error || !data?.token) throw new Error("Piazza authentication required.");
  return data.token as string;
}

async function fetchPiazza(method: string, params: Record<string, any>, cookieHeader: string): Promise<any> {
  const sessionIdMatch = cookieHeader.match(/session_id=([^;]+)/);
  const csrfToken = sessionIdMatch ? sessionIdMatch[1] : "";
  const response = await fetch(`https://piazza.com/logic/api?method=${encodeURIComponent(method)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookieHeader, "csrf-token": csrfToken },
    body: JSON.stringify({ method, params }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`Piazza error: ${json.error}`);
  return json.result;
}

const router = Router({ base: '/study-logic' });

router.options("*", () => new Response("ok", { headers: corsHeaders }));

router.get("/", () => {
  return new Response(JSON.stringify({ status: "ok", message: "Study Logic Root" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

router.get("/health", () => {
  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

const authMiddleware = async (req: IRequest) => {
  const authHeader = req.headers.get("Authorization");
  
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "No Authorization header" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error } = await supabaseClient.auth.getUser();

  if (error || !user) {
    console.error("Auth Error:", error?.message);
    return new Response(JSON.stringify({ error: "Invalid Token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Attach to request for use in handlers
  req.user = user;
  req.supabase = supabaseClient;
};

router.get("/dashboard", authMiddleware, async (req: any) => {
  const { supabase, user } = req;
  const [notesRes, sectionsRes, notesCountRes] = await Promise.all([
    supabase.from("notes").select("id, title, course_id, created_at, status").eq("user_id", user.id).order("created_at", { ascending: false }).limit(5),
    supabase.from("note_sections").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    supabase.from("notes").select("id", { count: "exact", head: true }).eq("user_id", user.id),
  ]);

  return new Response(JSON.stringify({
    recentNotes: notesRes.data ?? [],
    usage: { totalChunks: sectionsRes.count ?? 0 },
    stats: { notesCount: notesCountRes.count ?? 0 },
  }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
});

router.get("/d2l/status", authMiddleware, async (req: any) => {
  const { supabase, user } = req;
  const creds = await getD2LCredentials(supabase, user.id);
  return new Response(JSON.stringify({ connected: !!creds?.token }), { headers: corsHeaders });
});

router.post("/d2l/connect-cookie", authMiddleware, async (req) => {
  const { user, supabase } = req;
  const { host, cookies } = await req.json();

  console.log(`Saving cookies for user ${user.id} on host ${host}`);

  // We use .select() at the end to confirm the data actually hit the disk
  const { data, error } = await supabase
    .from("user_credentials")
    .upsert({
      user_id: user.id,
      service: "d2l",
      host: host,
      token: cookies, // The cookie array
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service" })
    .select(); // This is the key: it returns the row if successful

  if (error) {
    console.error("UPSERT FAIL:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, 
        headers: corsHeaders 
    });
  }

  if (!data || data.length === 0) {
    console.error("UPSERT SUCCESSFUL BUT NO DATA RETURNED (RLS ISSUE?)");
    return new Response(JSON.stringify({ error: "RLS blocking write" }), { 
        status: 403, 
        headers: corsHeaders 
    });
  }

  return new Response(JSON.stringify({ success: true, saved: data[0] }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

router.post("/notes/process", authMiddleware, async (req: any) => {
  const { supabase, user } = req;
  const { storagePath, title, courseId } = await req.json();
  // storagePath is downloaded with the service-role client, so it must be
  // confined to the caller's own folder in the "notes" bucket.
  // Reject encoded/escaped forms and any empty, "." or ".." path segment.
  if (
    typeof storagePath !== "string" ||
    !storagePath.startsWith(`${user.id}/`) ||
    /[%\\\u0000-\u001f]/.test(storagePath) ||
    storagePath.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    return new Response(JSON.stringify({ error: "Forbidden storagePath" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { data: note } = await supabase.from("notes").insert({
    user_id: user.id, storage_path: storagePath, title, course_id: courseId, status: "processing",
  }).select("id").single();

  try {
    const { data: fileData } = await supabaseAdmin.storage.from("notes").download(storagePath);
    const textContent = await extractContent(await fileData.arrayBuffer(), fileData.type);
    const chunks = chunkText(textContent!);
    await supabase.from("note_sections").insert(chunks.map((c, i) => ({
      note_id: note.id, user_id: user.id, content: c, page_number: i + 1,
    })));
    await embedNoteSections(supabase, user.id, note.id);
    await supabase.from("notes").update({ status: "ready", page_count: chunks.length }).eq("id", note.id);
    return new Response(JSON.stringify({ status: "ready", noteId: note.id }), { headers: corsHeaders });
  } catch (e: any) {
    await supabase.from("notes").update({ status: "error" }).eq("id", note.id);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});

router.post("/d2l/sync", authMiddleware, async (req) => {
  console.log("Sync initiated...");
  try {
    const { user, supabase } = req;
    
    // FIX 1: You must parse the body to use 'body.host'
    const body = await req.json().catch(() => ({}));
    
    console.log(`Searching for credentials: user_id=${user.id}, service=d2l`);

    const { data: creds, error: dbError } = await supabase
      .from('user_credentials')
      .select('token, host')
      .eq('user_id', user.id)
      .eq('service', 'd2l')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (dbError) {
      console.error("Database query exploded:", dbError.message);
      return new Response(JSON.stringify({ error: dbError.message }), { 
        status: 500, 
        headers: corsHeaders 
      });
    }

    if (!creds) {
      console.error("No credentials found in table for this user.");
      return new Response(JSON.stringify({ 
        error: "Credentials missing", 
        message: "Please ensure the connect-cookie step finished successfully first." 
      }), { status: 404, headers: corsHeaders });
    }

    // FIX 2: Sanitize targetHost logic
    let targetHost = (body.host || creds.host || "")
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
      
    if (!targetHost) throw new Error("Missing D2L Host");

    // 4. Format Cookies
    const cookieString = Array.isArray(creds.token) 
      ? creds.token.join('; ') 
      : String(creds.token);

    console.log(`Connecting to: https://${targetHost}/d2l/api/lp/1.45/users/whoami`);

    // 5. Execute Scrape
    const response = await fetch(`https://${targetHost}/d2l/api/lp/1.45/users/whoami`, {
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000) 
    });

    if (!response.ok) {
      const status = response.status;
      const text = await response.text();
      console.error(`D2L API Error (${status}):`, text);
      return new Response(JSON.stringify({ error: "D2L Auth Failed", status, detail: text }), { 
        status: 401, 
        headers: corsHeaders 
      });
    }

    const d2lUser = await response.json();
    console.log("D2L Sync Successful for:", d2lUser.UniqueName);

    return new Response(JSON.stringify({ 
      success: true, 
      profile: d2lUser 
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("CRITICAL SYNC ERROR:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: corsHeaders 
    });
  }
});

router.get("/d2l/courses", authMiddleware, async (req: any) => {
  const { supabase, user } = req;
  try {
    // 1. Get Credentials
    const creds = await getD2LCredentials(supabase, user.id);
    if (!creds) {
      return new Response(JSON.stringify({ error: "D2L credentials not found." }), { 
        status: 404, headers: corsHeaders 
      });
    }

    const cookieString = Array.isArray(creds.token) ? creds.token.join('; ') : String(creds.token);

    // 2. Fetch from D2L - Remove strict query params to see EVERYTHING first
    const path = "/d2l/api/lp/1.45/enrollments/myenrollments/?orgUnitTypeId=3";
    const enrollments = await fetchD2L(creds.host, path, cookieString);

    // 3. Relaxed Mapping (Remove the .filter that hides "inactive" or "future" courses)
    const courses = (enrollments.Items || []).map((e: any) => ({
      id: String(e.OrgUnit.Id),
      name: e.OrgUnit.Name,
      code: e.OrgUnit.Code || "No Code",
      orgUnitId: e.OrgUnit.Id,
      isActive: e.Access?.IsActive, // Keep this for info, but don't filter by it
    }));

    console.log(`Found ${courses.length} total enrollments for user ${user.id}`);

    return new Response(JSON.stringify({ success: true, courses }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: any) {
    console.error("[API] d2l/courses error:", e.message);
    const status = e.message === "REAUTH_REQUIRED" ? 401 : 500;
    return new Response(JSON.stringify({ error: e.message }), { 
      status, headers: corsHeaders 
    });
  }
});
// Piazza Sync Logic
router.post("/piazza/sync", authMiddleware, async (req: any) => {
  const { supabase, user } = req;
  const body: PiazzaSyncRequestBody = await req.json();
  try {
    const cookieHeader = await getPiazzaCookieHeader(supabase, user.id);
    const profile = await fetchPiazza("user_profile.get_profile", {}, cookieHeader);
    const networks = profile?.networks || [];
    let totalSynced = 0;
    for (const network of networks) {
      const feed = await fetchPiazza("network.filter_feed", { nid: network.nid, limit: body.maxPosts || 40 }, cookieHeader);
      const posts = feed.feed.map((post: any) => ({
        user_id: user.id, post_id: post.id, course_id: network.nid, title: post.subject, body: post.preview_text || "",
      }));
      await supabase.from("piazza_posts").upsert(posts, { onConflict: "user_id,post_id" });
      totalSynced += posts.length;
    }
    return new Response(JSON.stringify({ success: true, posts_synced: totalSynced }), { headers: corsHeaders });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});



router.all("*", () => new Response(JSON.stringify({ error: "Route not found" }), { 
  status: 404, 
  headers: { ...corsHeaders, "Content-Type": "application/json" }
}));

Deno.serve(async (req) => {
  const { method } = req;
  const url = new URL(req.url);
  // This helps us see exactly what the function thinks the path is in the logs
  const path = url.pathname.replace(/\/functions\/v1\/study-logic/g, "");

  console.log(`Incoming request: ${method} ${url.pathname} -> Cleaned path: ${path}`);

  // 1. Handle CORS
  if (method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 2. HARDCODED PUBLIC ROUTES (Bypassing Router for testing)
  if (path === "/" || path === "") {
    return new Response(JSON.stringify({ status: "ok", message: "Root reached" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (path === "/health") {
    return new Response(JSON.stringify({ status: "ok", message: "Health reached" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 3. PROTECTED ROUTES (Passing to itty-router)
  try {
    // We create a dummy request object that itty-router can understand
    const response = await router.handle(req);
    
    if (response) return response;

    return new Response(JSON.stringify({ 
      error: "Route not found", 
      receivedPath: url.pathname,
      cleanedPath: path 
    }), { 
      status: 404, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});