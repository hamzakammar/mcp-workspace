/**
 * REST API routes for app-first MVP.
 * Mount at /api. All routes use authMiddleware (req.userId).
 */

import express, { Router, Request, Response } from "express";
import { supabase } from "../utils/supabase.js";
import { ingestPdfBuffer, embedNoteSections, generateEmbedding, NotesTools } from "../study/src/notes.js";
import { isS3Configured, presignUpload, presignDownload, getObjectBuffer, getBucket, putObjectBuffer } from "./s3.js";
import { SyncTools } from "../study/src/sync.js";
import { PiazzaTools } from "../study/src/piazza.js";
import { D2LClient } from "../client.js";
import { getToken } from "../auth.js";
import { getPiazzaCookieHeader } from "../study/piazzaAuth.js";
import { registerDeviceToken, sendPushToUser, checkAndNotifyUpdates } from "./push.js";
import { encryptPassword, d2lPasswordContext } from "../utils/kms.js";
import { logCredentialAccess } from "../utils/auditLog.js";
import { deleteAllUserData } from "../utils/deleteUserData.js";
import { resolveAllowedD2LHost, DEFAULT_D2L_HOST } from "../utils/d2lHost.js";
import { signNotionState } from "./oauth/crypto.js";
import { Readable, Transform, pipeline } from "node:stream";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { isPrivateIp } from "../study/src/courseWebsite/fetcher.js";


/**
 * Resolve a D2L file URL (absolute or host-relative) and require it to be on
 * the user's own D2L host — the request carries their D2L session cookies, so
 * an external link from course content must never be fetched with them.
 */
function resolveD2LFileUrl(fileUrl: string, d2lHost: string): string | null {
  const host = String(d2lHost || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  try {
    const u = new URL(fileUrl, `https://${host}`);
    if (u.protocol !== "https:" || u.host.toLowerCase() !== host) return null;
    return u.toString();
  } catch {
    return null;
  }
}

type FetchResponse = globalThis.Response;

/** Upper bound on files proxied/saved from D2L. */
export const MAX_D2L_FILE_BYTES = 50 * 1024 * 1024;
const MAX_D2L_REDIRECTS = 5;

export class D2LFileFetchError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type HostLookup = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: HostLookup = (host) => dnsLookup(host, { all: true });

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  /** Abort if response headers haven't arrived within this long (default 60s). */
  headerTimeoutMs?: number;
  lookup?: HostLookup;
}

/** Throws unless every address `host` resolves to is public (no SSRF to internal ranges). */
async function assertPublicHost(hostname: string, lookup: HostLookup): Promise<void> {
  const bare = hostname.replace(/^\[(.*)\]$/, "$1");
  let addrs: Array<{ address: string }>;
  if (net.isIP(bare)) {
    addrs = [{ address: bare }];
  } else {
    try { addrs = await lookup(bare); } catch { throw new D2LFileFetchError(502, "Could not resolve file redirect host"); }
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new D2LFileFetchError(502, "D2L redirected to a disallowed address");
  }
}

/**
 * Fetch a D2L file, following redirects manually (max 5) so each hop is
 * re-checked:
 *  - https on the user's (allowed) D2L host (exact host incl. port) → sent
 *    WITH the session cookie;
 *  - any other https host (e.g. a signed CDN URL) → allowed only if it
 *    resolves to public IPs, and sent WITHOUT the cookie;
 *  - anything else → 502.
 * The header timeout is cleared once headers arrive; the returned controller
 * can abort the body (idle timeout / client disconnect).
 */
export async function fetchD2LFileSafely(
  startUrl: string,
  d2lHost: string,
  cookieHeader: string,
  opts: SafeFetchOptions = {},
): Promise<{ resp: FetchResponse; controller: AbortController }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  const controller = new AbortController();
  const headerTimer = setTimeout(
    () => controller.abort(new D2LFileFetchError(504, "Timed out waiting for D2L")),
    opts.headerTimeoutMs ?? 60_000,
  );
  try {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_D2L_REDIRECTS; hop++) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new D2LFileFetchError(502, "Invalid redirect target from D2L"); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new D2LFileFetchError(502, "D2L redirected to a non-https URL");
      }
      const onD2L = parsed.host.toLowerCase() === d2lHost.toLowerCase();
      if (!onD2L) {
        if (hop === 0) throw new D2LFileFetchError(400, "Only files hosted on your D2L site can be proxied");
        await assertPublicHost(parsed.hostname, lookup);
      }
      const resp = await fetchImpl(url, {
        headers: onD2L ? { Cookie: cookieHeader } : {},
        redirect: "manual",
        signal: controller.signal,
      });
      if (resp.status >= 300 && resp.status < 400 && resp.status !== 304) {
        const location = resp.headers.get("location");
        try { await resp.body?.cancel(); } catch { /* ignore */ }
        if (!location) throw new D2LFileFetchError(502, "D2L redirect without a Location header");
        url = new URL(location, url).toString();
        continue;
      }
      return { resp, controller };
    }
    throw new D2LFileFetchError(502, "Too many redirects from D2L");
  } catch (e) {
    if (controller.signal.aborted && controller.signal.reason instanceof D2LFileFetchError) throw controller.signal.reason;
    throw e;
  } finally {
    clearTimeout(headerTimer);
  }
}

/** Default idle timeout for D2L file bodies: abort if no data arrives for this long. */
export const D2L_BODY_IDLE_MS = 30_000;

/** True if the declared content length is over `max`. */
export function exceedsMaxSize(resp: FetchResponse, max = MAX_D2L_FILE_BYTES): boolean {
  const len = Number(resp.headers.get("content-length"));
  return Number.isFinite(len) && len > max;
}

/**
 * Read a response body into a Buffer, aborting once it exceeds `max` bytes or
 * when no data arrives for `idleMs`.
 */
export async function readBodyWithLimit(resp: FetchResponse, max = MAX_D2L_FILE_BYTES, idleMs = D2L_BODY_IDLE_MS): Promise<Buffer> {
  if (!resp.body) return Buffer.alloc(0);
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      idleTimer = setTimeout(() => reject(new D2LFileFetchError(504, "D2L stopped sending data")), idleMs);
    });
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await Promise.race([reader.read(), idle]);
    } catch (e) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw e;
    } finally {
      clearTimeout(idleTimer);
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new D2LFileFetchError(413, `File exceeds ${Math.round(max / 1024 / 1024)} MB limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Accept a body as PDF if it is labelled as one or starts with the PDF magic bytes. */
export function looksLikePdf(contentType: string | null | undefined, buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  // PDF readers accept the header anywhere in the first 1 KB.
  if (buffer.subarray(0, 1024).includes("%PDF-")) return true;
  return /application\/(x-)?pdf/i.test(contentType || "");
}

/** Build the Cookie header from the stored D2L token (JSON session vals or raw cookie string). */
function d2lCookieHeader(token: string): string {
  try {
    const parsed = JSON.parse(token);
    if (parsed.d2lSessionVal && parsed.d2lSecureSessionVal) {
      return `d2lSessionVal=${parsed.d2lSessionVal}; d2lSecureSessionVal=${parsed.d2lSecureSessionVal}`;
    }
  } catch {}
  return token;
}

type D2LCredsSnapshot = { host: string | null; username: string | null; password: string | null; token: string | null; updated_at: string | null } | null;

/** Read the user's current D2L credentials row (or null) before overwriting it. */
export async function snapshotD2LCreds(sb: any, userId: string): Promise<D2LCredsSnapshot> {
  const { data, error } = await sb
    .from("user_credentials")
    .select("host, username, password, token, updated_at")
    .eq("user_id", userId)
    .eq("service", "d2l")
    .limit(1);
  if (error) throw new Error(`Failed to read existing credentials: ${error.message || error}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}

/**
 * Undo a failed connect attempt. With a previous row, restore just `fields`
 * from it (other columns — e.g. saved username/password on a cookie connect —
 * are never touched). With no previous row, the row holds only what this
 * request wrote, so remove it. Returns the error, if any.
 */
export async function restoreD2LCreds(
  sb: any,
  userId: string,
  previous: D2LCredsSnapshot,
  fields: Array<"host" | "username" | "password" | "token" | "updated_at">,
  written: { column: "token" | "password"; value: string },
): Promise<unknown> {
  // Only touch the row if it still holds what this request wrote: a concurrent
  // successful connect/refresh must not be clobbered. Zero rows matched means
  // someone else has already replaced it — nothing to roll back.
  if (!previous) {
    const { error } = await sb.from("user_credentials").delete()
      .eq("user_id", userId).eq("service", "d2l").eq(written.column, written.value);
    return error ?? null;
  }
  const patch: Record<string, unknown> = {};
  for (const f of fields) patch[f] = previous[f] ?? null;
  const { error } = await sb.from("user_credentials").update(patch)
    .eq("user_id", userId).eq("service", "d2l").eq(written.column, written.value);
  return error ?? null;
}

const router = Router();
const MAX_NOTE_UPLOAD_BYTES = 60 * 1024 * 1024; // matches rawPdfUpload limit
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const rawPdfUpload = express.raw({ type: "*/*", limit: "60mb" });

import { randomBytes, createHash } from "node:crypto";

/** POST /api/keys — generate API key for current user. Returns plaintext key once. */
router.post("/keys", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) throw new Error("Missing Supabase config");
    const headers = { "apikey": sbKey, "Authorization": `Bearer ${sbKey}`, "Content-Type": "application/json" };

    // Check if user already has a key
    const existing = await fetch(`${sbUrl}/rest/v1/api_keys?user_id=eq.${userId}&select=id&limit=1`, { headers });
    const rows = await existing.json();
    if (Array.isArray(rows) && rows.length > 0) {
      res.status(409).json({ error: "API key already exists. Delete it first to generate a new one." });
      return;
    }

    // Generate key
    const raw = randomBytes(32);
    const plaintext = "hzn_" + raw.toString("hex");
    const keyHash = createHash("sha256").update(plaintext).digest("hex");

    // Store only the hash — never the plaintext. The key is shown once in this response and never again.
    const resp = await fetch(`${sbUrl}/rest/v1/api_keys`, {
      method: "POST",
      headers: { ...headers, "Prefer": "return=representation" },
      body: JSON.stringify({ user_id: userId, key_hash: keyHash }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    // Show once — if the user loses this they must delete and regenerate
    res.json({ apiKey: plaintext });
  } catch (e: any) {
    console.error("[API] key create error:", e);
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/keys — check if user has an API key. Does NOT return the plaintext key (shown once at creation only). */
router.get("/keys", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) throw new Error("Missing Supabase config");
    const resp = await fetch(`${sbUrl}/rest/v1/api_keys?user_id=eq.${userId}&select=id&limit=1`, {
      headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
    });
    if (!resp.ok) throw new Error(await resp.text());
    const rows = await resp.json() as Array<{ id: string }>;
    const hasKey = Array.isArray(rows) && rows.length > 0;
    res.json({ hasKey });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/disconnect — wipe every trace of the current user.
 *
 * Atomically deletes:
 *   - Supabase user_credentials row (passwords, tokens)
 *   - Supabase api_keys row
 *   - S3 browser-state for the user (ADFS + D2L session cookies)
 *   - Disk Playwright sessions (~/.d2l-session-{userId}, ~/.piazza-session-{userId})
 *
 * The response includes a breakdown of what was deleted and any errors.
 */
router.delete("/disconnect", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const result = await deleteAllUserData(userId);
    const allSuccess = result.errors.length === 0;
    res.status(allSuccess ? 200 : 207).json({
      ok: allSuccess,
      deleted: result.deleted,
      errors: result.errors,
    });
  } catch (e: any) {
    console.error("[API] disconnect error:", e);
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/keys — revoke user's API key */
router.delete("/keys", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) throw new Error("Missing Supabase config");
    const resp = await fetch(`${sbUrl}/rest/v1/api_keys?user_id=eq.${userId}`, {
      method: "DELETE",
      headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
    });
    if (!resp.ok) throw new Error(await resp.text());
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/notes/presign-upload — { filename, contentType, size, courseId? } -> { uploadUrl, s3Key } */
router.post("/notes/presign-upload", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { filename, contentType, size } = req.body || {};
  if (!filename || !contentType || typeof size !== "number") {
    res.status(400).json({ error: "filename, contentType, and size required" });
    return;
  }
  if (typeof filename !== "string" || filename.length > 255) {
    res.status(400).json({ error: "filename must be a string of at most 255 characters" });
    return;
  }
  if (typeof contentType !== "string" || contentType.length > 100 || !MIME_TYPE_RE.test(contentType)) {
    res.status(400).json({ error: "contentType must be a valid MIME type" });
    return;
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_NOTE_UPLOAD_BYTES) {
    res.status(400).json({ error: `size must be a positive integer up to ${MAX_NOTE_UPLOAD_BYTES} bytes` });
    return;
  }
  if (!isS3Configured()) {
    res.status(503).json({ error: "S3 not configured (AWS_REGION, S3_BUCKET)" });
    return;
  }
  try {
    const { uploadUrl, s3Key } = await presignUpload(userId, filename, contentType, size);
    res.json({ uploadUrl, s3Key });
  } catch (e) {
    console.error("[API] presign error:", e);
    res.status(500).json({ error: "Failed to generate presigned URL" });
  }
});

/** POST /api/notes/upload-direct?s3Key=... — fallback upload relay for browsers with S3 CORS issues */
router.post("/notes/upload-direct", rawPdfUpload, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const s3Key = String(req.query.s3Key || "");
  const contentType = String(req.headers["content-type"] || "application/pdf");

  if (!s3Key) {
    res.status(400).json({ error: "s3Key query param required" });
    return;
  }
  const prefix = `users/${userId}/`;
  if (!s3Key.startsWith(prefix)) {
    res.status(403).json({ error: "s3Key must be under your user path" });
    return;
  }
  if (!isS3Configured()) {
    res.status(503).json({ error: "S3 not configured" });
    return;
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "Binary PDF body required" });
    return;
  }

  try {
    await putObjectBuffer(s3Key, req.body, contentType || "application/pdf");
    res.json({ ok: true, bytes: req.body.length });
  } catch (e: any) {
    console.error("[API] upload-direct error:", e);
    res.status(500).json({ error: e?.message || "Failed to upload file" });
  }
});

/** POST /api/notes/process — { s3Key, courseId?, title? } -> { noteId, status } */
router.post("/notes/process", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { s3Key, courseId, title } = req.body || {};

  // Validate input
  if (!s3Key || !title || typeof s3Key !== "string") {
    res.status(400).json({ error: "Invalid input: s3Key and title are required." });
    return;
  }

  const noteTitle = title && typeof title === "string" ? title : "Untitled PDF";
  const prefix = `users/${userId}/`;
  if (!s3Key.startsWith(prefix)) {
    res.status(403).json({ error: "s3Key must be under your user path" });
    return;
  }
  if (!isS3Configured()) {
    res.status(503).json({ error: "S3 not configured" });
    return;
  }

  const course = courseId && typeof courseId === "string" ? courseId : "default";
  const url = `s3://${getBucket()}/${s3Key}`;
  let noteId: string | null = null;

  try {
    // Step 1: Create note record first (file should already be uploaded to S3 by mobile app)
    console.error("[API] Creating note record...");
    const { data: note, error: insertErr } = await supabase
      .from("notes")
      .insert({
        user_id: userId,
        s3_key: s3Key,
        title: noteTitle,
        course_id: course,
        status: "processing",
      })
      .select("id")
      .single();

    if (insertErr || !note || !note.id) {
      console.error("[API] note insert error:", insertErr);
      res.status(500).json({ 
        error: "Failed to create note",
        details: insertErr?.message || "Unknown error",
        code: insertErr?.code
      });
      return;
    }
    noteId = note.id;
    console.error("[API] Note created:", note.id);

    // Step 2: Fetch PDF from S3 (file should exist since mobile app uploaded it first)
    console.error("[API] Fetching PDF from S3...");
    let buffer: Buffer | null = null;
    let retries = 12; // Increase retries to 12 (~12s total wait for S3 consistency)
    while (retries > 0 && !buffer) {
      buffer = await getObjectBuffer(s3Key);
      if (!buffer && retries > 1) {
        console.error(`[API] PDF not found, retrying... (${retries - 1} retries left)`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s between attempts
        retries--;
      } else {
        break;
      }
    }

    if (!buffer) {
      console.error("[API] PDF buffer is null/undefined after retries");
      // Mark the note as pending instead of deleting it
      await supabase.from("notes").update({ status: "pending" }).eq("id", note.id).eq("user_id", userId);
      res.status(503).json({ 
        error: "PDF not yet available in storage", 
        suggestion: "The upload may not have fully finished. Please wait a few seconds and try again.",
      });
      return;
    }

    if (buffer.length === 0) {
      console.error("[API] PDF buffer is empty");
      await supabase.from("notes").update({ status: "error" }).eq("id", note.id).eq("user_id", userId);
      res.status(400).json({ error: "PDF file is empty", noteId: note.id });
      return;
    }
    console.error("[API] PDF buffer retrieved, size:", buffer.length);

    // Step 3: Process PDF (with proper error handling to update status)
    let chunkCount = 0;
    let pageCount = 0;
    try {
      console.error("[API] Starting PDF ingestion, buffer size:", buffer.length, "noteId:", note.id);
      const ingestResult = await ingestPdfBuffer(userId, buffer, {
        courseId: course,
        title: noteTitle,
        noteId: note.id, // Ensure note.id is passed (UUID)
        url,
      });
      chunkCount = ingestResult.chunkCount;
      pageCount = ingestResult.pageCount;
      console.error("[API] PDF ingestion successful:", { chunkCount, pageCount });
    } catch (ingestError) {
      const errorMsg = ingestError instanceof Error ? ingestError.message : String(ingestError);
      const errorStack = ingestError instanceof Error ? ingestError.stack : undefined;
      console.error("[API] ingestPdfBuffer error:", errorMsg);
      console.error("[API] ingestPdfBuffer stack:", errorStack);
      console.error("[API] ingestPdfBuffer full error:", JSON.stringify(ingestError, Object.getOwnPropertyNames(ingestError)));
      
      // ALWAYS update status to error on failure (prevents stuck "processing" state)
      try {
        await supabase.from("notes").update({ status: "error" }).eq("id", note.id).eq("user_id", userId);
      } catch (updateErr) {
        console.error("[API] Failed to update note status to error:", updateErr);
      }
      
      // Check if it's a database error
      if (errorMsg.includes("ingest upsert failed") || errorMsg.includes("Supabase") || errorMsg.includes("constraint") || errorMsg.includes("foreign key")) {
        res.status(500).json({ 
          error: "Database error while saving PDF chunks", 
          details: errorMsg,
          noteId: note.id,
          suggestion: "This may be a database constraint or foreign key issue. Please check backend logs.",
        });
      } else if (errorMsg.includes("pdf-parse") || errorMsg.includes("PDF") || errorMsg.includes("parse") || errorMsg.includes("corrupted") || errorMsg.includes("encrypted")) {
        res.status(500).json({ 
          error: "Failed to parse PDF file", 
          details: errorMsg,
          noteId: note.id,
          suggestion: "The PDF file may be corrupted, encrypted, or in an unsupported format. Please try a different PDF file.",
        });
      } else {
        res.status(500).json({ 
          error: "Failed to ingest PDF", 
          details: errorMsg,
          noteId: note.id,
        });
      }
      return;
    }

    let embedded = 0;
    try {
      embedded = await embedNoteSections(userId, note.id);
    } catch (embedError) {
      console.error("[API] embedNoteSections error:", embedError);
      // Don't fail the whole request if embedding fails - note is still usable
      console.error("[API] Continuing despite embedding failure");
    }

    await supabase
      .from("notes")
      .update({ status: "ready", page_count: pageCount })
      .eq("id", note.id)
      .eq("user_id", userId);

    res.json({
      noteId: note.id,
      status: "ready",
      chunkCount,
      pageCount,
      embedded,
    });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    const errorStack = e instanceof Error ? e.stack : undefined;
    console.error("[API] process error:", errorMessage);
    console.error("[API] process error stack:", errorStack);
    console.error("[API] process error details:", {
      userId,
      s3Key,
      courseId: course,
      title: noteTitle,
      noteId,
      s3KeyPrefix: s3Key?.substring(0, 50),
      s3KeyStartsWithPrefix: s3Key?.startsWith(`users/${userId}/`),
    });
    
    if (noteId) {
      await supabase.from("notes").update({ status: "error" }).eq("id", noteId).eq("user_id", userId);
    }
    
    // Return detailed error for debugging
    res.status(500).json({ 
      error: "Failed to process PDF", 
      details: errorMessage,
      noteId: noteId ?? undefined,
      debug: {
        s3KeyPrefix: s3Key?.substring(0, 50),
        hasS3Key: !!s3Key,
        s3KeyFormat: s3Key?.startsWith(`users/${userId}/`) ? 'valid' : 'invalid',
      }
    });
  }
});

/** GET /api/notes — query courseId? -> { notes: [...] } */
router.get("/notes", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const courseId = req.query.courseId as string | undefined;
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) throw new Error("Missing Supabase config");
    let url = `${sbUrl}/rest/v1/notes?user_id=eq.${userId}&select=id,title,course_id,created_at,page_count,status,s3_key&order=created_at.desc`;
    if (courseId) url += `&course_id=eq.${encodeURIComponent(courseId)}`;
    const resp = await fetch(url, {
      headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
    });
    if (!resp.ok) throw new Error(await resp.text());
    const notes = await resp.json();
    res.json({ notes: notes ?? [] });
  } catch (e: any) {
    console.error("[API] notes list error:", e);
    res.status(500).json({ error: "Failed to list notes" });
  }
});

/** GET /api/notes/:id/view — get a presigned URL to view a note's PDF */
router.get("/notes/:id/view", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const noteId = req.params.id;
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) throw new Error("Missing Supabase config");
    const resp = await fetch(`${sbUrl}/rest/v1/notes?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(noteId)}&select=s3_key&limit=1`, {
      headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
    });
    if (!resp.ok) throw new Error(await resp.text());
    const rows = await resp.json();
    const note = Array.isArray(rows) ? rows[0] : rows;
    if (!note?.s3_key) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    const viewUrl = await presignDownload(note.s3_key);
    res.json({ viewUrl });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/notes/:id — delete a note and its sections for the current user */
router.delete("/notes/:id", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const noteId = req.params.id;

  if (!userId || !noteId || typeof noteId !== "string") {
    res.status(400).json({ error: "Invalid input: userId and noteId are required." });
    return;
  }

  try {
    console.info("[API] Deleting note and sections:", { userId, noteId });
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) throw new Error("Missing Supabase config");
    const headers = { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` };

    // First delete note_sections for this note/user
    const secResp = await fetch(`${sbUrl}/rest/v1/note_sections?user_id=eq.${encodeURIComponent(userId)}&note_id=eq.${encodeURIComponent(noteId)}`, {
      method: "DELETE", headers,
    });
    if (!secResp.ok) {
      const msg = await secResp.text();
      console.error("[API] notes delete - note_sections error:", msg);
      res.status(500).json({ error: "Failed to delete note sections", details: msg });
      return;
    }

    // Then delete the note itself
    const noteResp = await fetch(`${sbUrl}/rest/v1/notes?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(noteId)}`, {
      method: "DELETE", headers: { ...headers, "Prefer": "return=representation" },
    });
    if (!noteResp.ok) {
      const msg = await noteResp.text();
      console.error("[API] notes delete - notes error:", msg);
      res.status(500).json({ error: "Failed to delete note", details: msg });
      return;
    }

    const deletedNotes = await noteResp.json();
    if (!deletedNotes || deletedNotes.length === 0) {
      res.status(404).json({ error: "Note not found" });
      return;
    }

    // Best-effort: remove the uploaded PDF too, but only from this user's prefix.
    const s3Key = deletedNotes[0]?.s3_key;
    if (isS3Configured() && typeof s3Key === "string" && s3Key.startsWith(`users/${userId}/`)) {
      try {
        const { DeleteObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
        const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
        await s3.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: s3Key }));
      } catch (s3Err) {
        console.error("[API] notes delete - S3 object delete failed (ignored):", s3Err);
      }
    }

    res.json({ status: "deleted", noteId });
  } catch (e) {
    console.error("[API] notes delete error:", e);
    res.status(500).json({ error: "Unexpected error occurred while deleting note." });
  }
});

/** GET /api/search — query q, courseId?, limit? -> { hits: [...] } */
router.get("/search", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const q = (req.query.q as string)?.trim();
  const courseId = (req.query.courseId as string) || undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

  if (!q) {
    res.status(400).json({ error: "query q required" });
    return;
  }

  try {
    const queryEmbedding = await generateEmbedding(q);
    const { data: sections, error } = await supabase.rpc("match_note_sections", {
      query_embedding: queryEmbedding,
      match_count: limit,
      course_filter: courseId ?? null,
      user_filter: userId,
    });

    if (error) {
      console.error("[API] search error:", error);
      res.status(500).json({ error: "Search failed" });
      return;
    }

    const hits = (sections ?? []).map((s: { id: string; note_id: string | null; title: string; url: string; anchor: string; preview: string; similarity: number }) => ({
      sectionId: s.id,
      noteId: s.note_id,
      title: s.title,
      snippet: s.preview,
      url: s.url,
      anchor: s.anchor,
      score: s.similarity,
    }));

    res.json({ hits });
  } catch (e) {
    console.error("[API] search error:", e);
    res.status(500).json({ error: "Search failed" });
  }
});

/** GET /api/dashboard — { recentNotes, usage, stats } */
router.get("/dashboard", async (req: Request, res: Response) => {
  const userId = req.userId!;

  try {
    // Test database connection first
    if (!supabase) {
      console.error("[API] dashboard error: Supabase client not initialized");
      res.status(503).json({
        error: "Database not configured",
        message: "SUPABASE_URL or DATABASE_URL environment variable is missing or invalid"
      });
      return;
    }

    const [notesRes, sectionsRes, notesCountRes] = await Promise.all([
      supabase
        .from("notes")
        .select("id, title, course_id, created_at, status")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(12),
      supabase
        .from("note_sections")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
      supabase
        .from("notes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
    ]);

    // Check for errors - if any critical query fails, return error
    const errors: string[] = [];
    if (notesRes.error) {
      console.error("[API] dashboard notes error:", notesRes.error);
      errors.push(`Notes query failed: ${notesRes.error.message || JSON.stringify(notesRes.error)}`);
    }
    if (sectionsRes.error) {
      console.error("[API] dashboard sections error:", sectionsRes.error);
      errors.push(`Sections count failed: ${sectionsRes.error.message || JSON.stringify(sectionsRes.error)}`);
    }
    if (notesCountRes.error) {
      console.error("[API] dashboard notesCount error:", notesCountRes.error);
      errors.push(`Notes count failed: ${notesCountRes.error.message || JSON.stringify(notesCountRes.error)}`);
    }

    // If all queries failed, return error
    if (errors.length === 3) {
      res.status(503).json({
        error: "Database queries failed",
        details: errors,
        message: "All database queries failed. Check database connection and table existence."
      });
      return;
    }

    // Return partial data if some queries succeeded
    const recentNotes = notesRes.data ?? [];
    const totalChunks = sectionsRes.count ?? 0;
    const notesCount = notesCountRes.count ?? 0;

    res.json({
      recentNotes,
      usage: { totalChunks },
      stats: { notesCount },
      warnings: errors.length > 0 ? errors : undefined,
    });
  } catch (e) {
    console.error("[API] dashboard error:", e);
    const errorMessage = e instanceof Error ? e.message : String(e);

    // Check if it's a database connection error
    if (errorMessage.includes('connection') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('timeout')) {
      res.status(503).json({
        error: "Database connection failed",
        details: errorMessage,
        message: "Cannot connect to database. Check SUPABASE_URL/DATABASE_URL and network connectivity."
      });
    } else {
      res.status(500).json({
        error: "Failed to load dashboard",
        details: errorMessage
      });
    }
  }
});

/** POST /api/notes/embed-missing — Embed missing note sections */
router.post("/notes/embed-missing", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId, limit, minChars } = req.body || {};

  try {
    const result = await NotesTools.notes_embed_missing.handler({
      userId,
      courseId: courseId || undefined,
      limit: limit || 100,
      minChars: minChars || 200,
    });

    const parsed = JSON.parse(result);
    if (parsed.success) {
      res.json(parsed);
    } else {
      res.status(500).json(parsed);
    }
  } catch (e) {
    console.error("[API] embed-missing error:", e);
    res.status(500).json({ error: "Failed to embed missing notes", details: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/d2l/connect — Store D2L credentials for user */
/** POST /api/d2l/connect-and-sync — Store cookies + ingest pre-fetched course/assignment data from app
 *  The app fetches D2L data on-device (where session cookies are valid), then pushes
 *  the raw results here. No server-side D2L calls needed — avoids IP/session mismatch. */
router.post("/d2l/connect-and-sync", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { host: rawHost, cookies, courseData } = req.body || {};

  if (!rawHost || !cookies) {
    res.status(400).json({ error: "host and cookies required" });
    return;
  }
  const host = resolveAllowedD2LHost(rawHost);
  if (!host) {
    res.status(400).json({ error: "Unsupported D2L host" });
    return;
  }

  const correlationId = `cas-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    // 1. Store cookies
    const { error: upsertError } = await supabase
      .from("user_credentials")
      .upsert({
        user_id: userId,
        service: "d2l",
        host,
        token: cookies,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,service" });

    if (upsertError) {
      console.error(`[API] [${correlationId}] Failed to store cookies:`, upsertError);
      res.status(500).json({ error: "Failed to store credentials" });
      return;
    }

    // Clear token cache so next request picks up fresh cookies from DB
    const { clearTokenCache } = await import("../auth.js");
    clearTokenCache(userId);

    // 2. Ingest pre-fetched assignment data (app fetched this on-device)
    let totalAdded = 0;
    let totalAssignments = 0;
    const results: Array<{ course: string; assignments: number; added: number }> = [];

    if (Array.isArray(courseData)) {
      for (const course of courseData) {
        const { orgUnitId, name: courseName, assignments = [] } = course;
        totalAssignments += assignments.length;
        let addedCount = 0;

        for (const a of assignments) {
          const dueDate = a.DueDate || null;
          if (!dueDate) continue;

          const sourceRef = `${orgUnitId}-${a.Id}`;

          try {
            const { data: existing } = await supabase
              .from("tasks")
              .select("id")
              .eq("user_id", userId)
              .eq("source_ref", sourceRef)
              .maybeSingle();

            if (!existing) {
              const { error: insertError } = await supabase
                .from("tasks")
                .insert({
                  user_id: userId,
                  title: a.Name,
                  course_id: String(orgUnitId),
                  source: `d2l-${orgUnitId}`,
                  source_ref: sourceRef,
                  due_at: dueDate,
                  status: "open",
                });

              if (!insertError) {
                addedCount++;
                totalAdded++;
              } else {
                console.error(`[API] [${correlationId}] Insert error for ${a.Name}:`, insertError);
              }
            }
          } catch (taskErr: any) {
            console.error(`[API] [${correlationId}] tasks table error (may not exist yet):`, taskErr.message);
            break; // Stop trying if the table doesn't exist
          }
        }

        results.push({ course: courseName, assignments: assignments.length, added: addedCount });
      }
    }

    console.error(`[API] [${correlationId}] connect-and-sync complete: ${totalAdded}/${totalAssignments} tasks added`);

    res.json({
      status: "connected",
      message: "D2L connected and synced successfully",
      totalCourses: courseData?.length || 0,
      totalAssignments,
      totalAdded,
      results,
      correlationId,
    });
  } catch (e) {
    console.error(`[API] [${correlationId}] connect-and-sync error:`, e);
    res.status(500).json({
      error: "Failed to connect and sync",
      details: e instanceof Error ? e.message : String(e),
      correlationId,
    });
  }
});

/** POST /api/d2l/connect-cookie — Store D2L cookies directly (from WebView) */
router.post("/d2l/connect-cookie", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { host: rawHost, cookies } = req.body || {};

  if (!rawHost || !cookies) {
    res.status(400).json({ error: "host and cookies required" });
    return;
  }
  const host = resolveAllowedD2LHost(rawHost);
  if (!host) {
    res.status(400).json({ error: "Unsupported D2L host" });
    return;
  }

  const correlationId = `cookie-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    // Snapshot the existing row so a failed verification can roll back
    // instead of wiping working credentials.
    const previous = await snapshotD2LCreds(supabase, userId);

    // Store cookies in user_credentials table as the 'token'
    // Store cookies as token (cookie-based auth)
    const { error } = await supabase
      .from("user_credentials")
      .upsert({
        user_id: userId,
        service: "d2l",
        host: host,
        token: cookies,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "user_id,service"
      });

    if (error) {
      console.error(`[API] [${correlationId}] d2l/connect-cookie error storing:`, error);
      res.status(500).json({ error: "Failed to store cookies", correlationId });
      return;
    }

    console.error(`[API] [${correlationId}] Cookies stored, verifying...`);

    // Verify cookies work by making a test API call
    try {
      // Clear token cache to force refresh
      const { clearTokenCache } = await import("../auth.js");
      clearTokenCache(userId);

      const client = new D2LClient(userId, host);
      // This will use the stored cookies from getToken() -> D2LClient adapter
      await client.getMyEnrollments();

      console.error(`[API] [${correlationId}] Cookies verified successfully`);
      res.json({
        status: "connected",
        message: "D2L connected via cookies successfully",
        correlationId
      });
    } catch (verifyError) {
      console.error(`[API] [${correlationId}] Cookie verification failed:`, verifyError);

      // Roll back to the previous token/host (saved username/password are untouched)
      const restoreError = await restoreD2LCreds(supabase, userId, previous, ["host", "token", "updated_at"], { column: "token", value: cookies });
      if (restoreError) {
        console.error(`[API] [${correlationId}] Failed to restore previous credentials:`, restoreError);
      }

      res.status(400).json({
        error: "Invalid or expired cookies. Please try logging in again.",
        details: verifyError instanceof Error ? verifyError.message : String(verifyError),
        correlationId
      });
    }
  } catch (e) {
    console.error(`[API] [${correlationId}] d2l/connect-cookie error:`, e);
    res.status(500).json({
      error: "Failed to store cookies",
      details: e instanceof Error ? e.message : String(e),
      correlationId
    });
  }
});

/** POST /api/d2l/token — Store D2L token directly (from WebView login) */
router.post("/d2l/token", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { host: rawHost, token } = req.body || {};

  if (!rawHost || !token) {
    res.status(400).json({ error: "host and token required" });
    return;
  }
  const host = resolveAllowedD2LHost(rawHost);
  if (!host) {
    res.status(400).json({ error: "Unsupported D2L host" });
    return;
  }

  const correlationId = `token-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    const previous = await snapshotD2LCreds(supabase, userId);

    // Store token in user_credentials table
    const { error } = await supabase
      .from("user_credentials")
      .upsert({
        user_id: userId,
        service: "d2l",
        host: host,
        token: token, // Store the token directly
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "user_id,service"
      });

    if (error) {
      console.error(`[API] [${correlationId}] d2l/token error storing:`, error);
      res.status(500).json({ error: "Failed to store token", correlationId });
      return;
    }

    console.error(`[API] [${correlationId}] Token stored, verifying...`);

    // Verify token works by making a test API call
    try {
      // Clear token cache to force refresh
      const { clearTokenCache } = await import("../auth.js");
      clearTokenCache(userId);

      const client = new D2LClient(userId, host);
      // This will use the stored token from getToken()
      await client.getMyEnrollments();

      console.error(`[API] [${correlationId}] Token verified successfully`);
      res.json({
        status: "connected",
        message: "D2L token stored and verified successfully",
        correlationId
      });
    } catch (verifyError) {
      console.error(`[API] [${correlationId}] Token verification failed:`, verifyError);

      // Roll back to the previous token/host (saved username/password are untouched)
      const restoreError = await restoreD2LCreds(supabase, userId, previous, ["host", "token", "updated_at"], { column: "token", value: token });
      if (restoreError) {
        console.error(`[API] [${correlationId}] Failed to restore previous token:`, restoreError);
      } else {
        console.error(`[API] [${correlationId}] Rolled back invalid token`);
      }

      res.status(400).json({
        error: "Invalid or expired token. Please try logging in again.",
        details: verifyError instanceof Error ? verifyError.message : String(verifyError),
        correlationId
      });
    }
  } catch (e) {
    console.error(`[API] [${correlationId}] d2l/token error:`, e);
    res.status(500).json({
      error: "Failed to store token",
      details: e instanceof Error ? e.message : String(e),
      correlationId
    });
  }
});

router.post("/d2l/connect", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { host: rawHost, username, password } = req.body || {};

  if (!rawHost || !username || !password) {
    res.status(400).json({ error: "host, username, and password required" });
    return;
  }
  const host = resolveAllowedD2LHost(rawHost);
  if (!host) {
    res.status(400).json({ error: "Unsupported D2L host" });
    return;
  }

  try {
    const previous = await snapshotD2LCreds(supabase, userId);

    // First, verify credentials by attempting to authenticate
    // Store credentials with KMS-encrypted password, bound to this user (AAD)
    const encryptedPassword = await encryptPassword(password, d2lPasswordContext(userId));
    await logCredentialAccess(userId, "d2l_password", "write", "POST /d2l/connect");
    const { error: tempError } = await supabase
      .from("user_credentials")
      .upsert({
        user_id: userId,
        service: "d2l",
        host: host,
        username: username,
        password: encryptedPassword,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "user_id,service"
      });

    if (tempError) {
      console.error("[API] d2l/connect error storing temp credentials:", tempError);
      res.status(500).json({ error: "Failed to store credentials" });
      return;
    }

    // Now try to authenticate with D2L to verify credentials work
    // Set a timeout to prevent 504 Gateway Timeout (ALB timeout is typically 60s)
    const authTimeout = 55000; // 55 seconds - slightly less than typical ALB timeout
    const authPromise = (async () => {
      const client = new D2LClient(userId, host);
      // Try to get enrollments as a test - this will trigger authentication
      await client.getMyEnrollments();
      return { success: true };
    })();
    
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        reject(new Error("Authentication timeout - the login process is taking too long. This may be due to 2FA or additional verification steps."));
      }, authTimeout);
    });
    const rollback = async () => {
      const restoreError = await restoreD2LCreds(supabase, userId, previous, ["host", "username", "password", "updated_at"], { column: "password", value: encryptedPassword });
      if (restoreError) {
        console.error("[API] d2l/connect failed to restore previous credentials:", restoreError);
      }
    };
    // The D2L login can't be cancelled. If the timeout wins, defer the rollback
    // until the attempt actually settles: rolling back now would let a late
    // success persist a session token for the new credentials next to the
    // restored old ones. Late success → keep the (proven) new credentials;
    // late failure → roll back as usual.
    authPromise.then(
      () => { if (timedOut) console.error("[API] d2l/connect: authentication succeeded after timeout; keeping new credentials"); },
      async () => { if (timedOut) await rollback().catch(() => {}); },
    );

    try {
      try {
        await Promise.race([authPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutTimer);
      }

      // If we get here, authentication succeeded
      res.json({
        status: "connected",
        message: "D2L credentials verified and stored successfully"
      });
    } catch (authError) {
      // Authentication failed - roll back to whatever was stored before this
      // attempt (previous username/password/token are kept, not deleted).
      // On timeout the rollback is deferred until the attempt settles (above).
      if (!timedOut) await rollback();

      console.error("[API] d2l/connect authentication failed:", authError);
      const errorMessage = authError instanceof Error ? authError.message : String(authError);

      // Check for browser launch failures (Playwright not installed)
      if (errorMessage.includes("ENOENT") || errorMessage.includes("spawn") || errorMessage.includes("chromium") || errorMessage.includes("playwright")) {
        res.status(500).json({
          error: "Browser automation is not available. Please contact support.",
          details: "Playwright/Chromium is not installed in the backend container."
        });
      } else if (errorMessage.includes("login") || errorMessage.includes("password") || errorMessage.includes("credentials") || errorMessage.includes("Invalid") || errorMessage.includes("incorrect")) {
        res.status(401).json({
          error: "Invalid D2L credentials. Please check your username and password.",
          details: errorMessage
        });
      } else {
        res.status(500).json({
          error: "Failed to authenticate with D2L",
          details: errorMessage
        });
      }
    }
  } catch (e) {
    console.error("[API] d2l/connect error:", e);
    res.status(500).json({ error: "Failed to connect", details: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/d2l/status — Get D2L connection status */
router.get("/d2l/status", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    // Check if credentials exist in database
    const { data: credsData, error: credError } = await supabase
      .from("user_credentials")
      .select("host, username, password, token, updated_at")
      .eq("user_id", userId)
      .eq("service", "d2l")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;

    // Check if we have token (cookie-based auth) or username (legacy credential-based)
    const hasToken = !credError && !!creds && !!creds.token;
    const hasUsername = !credError && !!creds && !!creds.username;
    const connected = hasToken || hasUsername;
    // Auto-reconnect credentials are saved only when BOTH username and password exist.
    // (We never return the password itself — just whether it's stored.)
    const credentialsSaved = !credError && !!creds && !!creds.username && !!creds.password;

    // Check token age - if older than 20 hours, signal reauth required
    let reauthRequired = false;
    if (hasToken && creds.updated_at) {
      const tokenAge = Date.now() - (new Date(creds.updated_at).getTime());
      const maxAge = 20 * 60 * 60 * 1000; // 20 hours
      reauthRequired = tokenAge > maxAge;
    }

    // Get last sync time from tasks table (may not exist yet)
    let lastTask: any = null;
    try {
      const { data: lastTaskData } = await supabase
        .from("tasks")
        .select("created_at")
        .eq("user_id", req.userId!)
        .like("source", "d2l-%")
        .order("created_at", { ascending: false })
        .limit(1);
      lastTask = Array.isArray(lastTaskData) ? lastTaskData[0] : lastTaskData;
    } catch { /* tasks table may not exist */ }

    // Get courses count (optional - don't fail if this doesn't work)
    let coursesCount = 0;
    if (connected && creds && !reauthRequired) {
      try {
        const client = new D2LClient(userId, creds.host);
        const enrollments = await client.getMyEnrollments() as { Items: any[] };
        coursesCount = enrollments?.Items?.filter(
          (e: any) => e.OrgUnit?.Type?.Code === "Course Offering" && e.Access?.IsActive && e.Access?.CanAccess
        ).length || 0;
      } catch (e: any) {
        // Check if error is REAUTH_REQUIRED
        if (e.message === "REAUTH_REQUIRED" || (e instanceof Error && e.message.includes("REAUTH_REQUIRED"))) {
          reauthRequired = true;
        }
        // Ignore other errors getting courses - credentials might be valid but not authenticated yet
        console.error("[API] Error getting courses count:", e);
      }
    }

    res.json({
      connected: connected && !reauthRequired,
      reauthRequired,
      credentialsSaved,
      lastSync: lastTask?.created_at || null,
      coursesCount,
    });
  } catch (e) {
    console.error("[API] d2l/status error:", e);
    res.json({
      connected: false,
      reauthRequired: false,
      credentialsSaved: false,
      lastSync: null,
      coursesCount: 0,
    });
  }
});

/** DELETE /api/d2l/disconnect — Remove D2L credentials for current user */
router.delete("/d2l/disconnect", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const { error } = await supabase
      .from("user_credentials")
      .delete()
      .eq("user_id", userId)
      .eq("service", "d2l");

    if (error) {
      console.error("[API] d2l/disconnect error:", error);
      res.status(500).json({ error: "Failed to disconnect D2L" });
      return;
    }

    res.json({
      status: "disconnected",
      message: "D2L disconnected successfully",
    });
  } catch (e) {
    console.error("[API] d2l/disconnect error:", e);
    res.status(500).json({
      error: "Failed to disconnect D2L",
      details: e instanceof Error ? e.message : String(e),
    });
  }
});

/** POST /api/d2l/sync — Sync all D2L assignments */
router.post("/d2l/sync", async (req: Request, res: Response) => {
  const userId = req.userId!;

  try {
    const result = await SyncTools.sync_all.handler({ userId });
    const parsed = JSON.parse(result);

    if (parsed.success) {
      res.json({
        status: "completed",
        message: "D2L sync completed successfully",
        result: parsed,
      });
    } else {
      res.status(500).json({
        status: "failed",
        message: parsed.error || "D2L sync failed",
        result: parsed,
      });
    }
  } catch (e: any) {
    console.error("[API] d2l/sync error:", e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    const lowerMessage = errorMessage.toLowerCase();
    
    // Check if error is REAUTH_REQUIRED
    if (errorMessage === "REAUTH_REQUIRED" || errorMessage.includes("REAUTH_REQUIRED")) {
      res.status(401).json({ 
        status: "failed",
        error: "REAUTH_REQUIRED",
        message: "Your D2L session has expired. Please sign in again using the WebView." 
      });
      return;
    }
    
    // Check if it's an auth error (token issue)
    if (
      lowerMessage.includes("token") ||
      lowerMessage.includes("authentication") || // catches "Authentication required"
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("403") // treat 403 from D2L as auth issue for sync
    ) {
      res.status(401).json({
        status: "failed",
        error: "AUTH_REQUIRED",
        message: "Authentication required. Please sign in again.",
      });
      return;
    }
    
    res.status(500).json({
      status: "failed",
      error: errorMessage,
    });
  }
});

/** GET /api/d2l/courses — Get enrolled courses */
router.get("/d2l/courses", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    // Check credentials exist first
    const { data: credsData } = await supabase
      .from("user_credentials")
      .select("host")
      .eq("user_id", userId)
      .eq("service", "d2l")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;
    if (!creds) {
      res.status(404).json({ error: "D2L credentials not found. Please connect D2L first." });
      return;
    }

    // Derive distinct courses from the tasks table (stored during connect-and-sync)
    // This avoids server-side D2L API calls which fail due to IP/session mismatch
    const courseMap = new Map<string, { id: string; name: string; code: string; orgUnitId: number }>();
    try {
      const { data: tasks, error: tasksError } = await supabase
        .from("tasks")
        .select("course_id, source")
        .eq("user_id", userId)
        .like("source", "d2l-%")
        .not("course_id", "is", null);

      if (!tasksError) {
        for (const task of (tasks || [])) {
          const orgUnitId = task.course_id;
          if (!courseMap.has(orgUnitId)) {
            courseMap.set(orgUnitId, {
              id: orgUnitId,
              name: `Course ${orgUnitId}`,
              code: "",
              orgUnitId: Number(orgUnitId),
            });
          }
        }
      }
    } catch {
      // tasks table may not exist yet — that's fine, live fetch is the primary path
    }

    // Also try live D2L fetch — if it fails, fall back to tasks-derived courses
    try {
      const client = new D2LClient(userId, creds.host);
      const enrollments = await client.getMyEnrollments() as { Items: any[] };
      const now = new Date();
      const eightMonthsAgo = new Date(now.getTime() - 8 * 30 * 24 * 60 * 60 * 1000);

      const liveCourses = enrollments.Items
        .filter((e: any) => {
          if (e.OrgUnit?.Type?.Code !== "Course Offering") return false;
          if (!e.Access?.IsActive || !e.Access?.CanAccess) return false;
          // Filter to current term: endDate in future OR startDate within last 8 months
          const startDate = e.Access?.StartDate ? new Date(e.Access.StartDate) : null;
          const endDate = e.Access?.EndDate ? new Date(e.Access.EndDate) : null;
          if (endDate && endDate < now) return false; // already ended
          if (startDate && startDate < eightMonthsAgo) return false; // too old
          return true;
        })
        .map((e: any) => ({
          id: String(e.OrgUnit.Id),
          name: e.OrgUnit.Name,
          code: e.OrgUnit.Code || "",
          orgUnitId: e.OrgUnit.Id,
          startDate: e.Access?.StartDate || null,
          endDate: e.Access?.EndDate || null,
        }));
      res.json({ courses: liveCourses, source: "live" });
      return;
    } catch (liveErr: any) {
      console.error("[API] d2l/courses live fetch failed, falling back to cached:", liveErr.message);
    }

    // Fallback: return courses derived from synced tasks
    res.json({ courses: Array.from(courseMap.values()), source: "cached" });
  } catch (e: any) {
    console.error("[API] d2l/courses error:", e);
    if (e.message === "REAUTH_REQUIRED" || (e instanceof Error && e.message.includes("REAUTH_REQUIRED"))) {
      res.status(401).json({ 
        error: "REAUTH_REQUIRED",
        message: "Your D2L session has expired. Please sign in again using the WebView." 
      });
      return;
    }
    res.status(500).json({ error: "Failed to fetch courses", details: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/d2l/courses/:courseId/announcements — Get announcements for a course */
router.get("/d2l/courses/:courseId/announcements", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId } = req.params;
  const orgUnitId = parseInt(courseId, 10);

  if (isNaN(orgUnitId)) {
    res.status(400).json({ error: "Invalid course ID" });
    return;
  }

  try {
    // Get user's D2L host from credentials
    const { data: credsData } = await supabase
      .from("user_credentials")
      .select("host")
      .eq("user_id", userId)
      .eq("service", "d2l")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;
    if (!creds) {
      res.status(404).json({ error: "D2L credentials not found. Please connect D2L first." });
      return;
    }

    const client = new D2LClient(userId, creds.host);
    const news = await client.getNews(orgUnitId) as any[];
    const { marshalAnnouncements } = await import("../utils/marshal.js");
    const announcements = marshalAnnouncements(news);

    res.json({ announcements });
  } catch (e: any) {
    console.error("[API] d2l/courses/:courseId/announcements error:", e);
    // Check if error is REAUTH_REQUIRED
    if (e.message === "REAUTH_REQUIRED" || (e instanceof Error && e.message.includes("REAUTH_REQUIRED"))) {
      res.status(401).json({ 
        error: "REAUTH_REQUIRED",
        message: "Your D2L session has expired. Please sign in again using the WebView." 
      });
      return;
    }
    res.status(500).json({
      error: "Failed to fetch announcements",
      details: e instanceof Error ? e.message : String(e)
    });
  }
});

/** GET /api/d2l/courses/:courseId/assignments — Get assignments for a course */
router.get("/d2l/courses/:courseId/assignments", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId } = req.params;
  const orgUnitId = parseInt(courseId, 10);

  if (isNaN(orgUnitId)) {
    res.status(400).json({ error: "Invalid course ID" });
    return;
  }

  try {
    // Get user's D2L host from credentials
    const { data: credsData } = await supabase
      .from("user_credentials")
      .select("host")
      .eq("user_id", userId)
      .eq("service", "d2l")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;
    if (!creds) {
      res.status(404).json({ error: "D2L credentials not found. Please connect D2L first." });
      return;
    }

    const client = new D2LClient(userId, creds.host);
    const { assignmentTools } = await import("../tools/dropbox.js");
    const folders = await client.getDropboxFolders(orgUnitId) as any[];
    const { marshalAssignments } = await import("../utils/marshal.js");
    const assignments = marshalAssignments(folders);

    res.json({
      assignments: assignments.map((a: any) => ({
        id: a.id,
        name: a.name,
        dueDate: a.dueDate,
        dueDateIso: a.dueDateIso || null,
        instructions: a.instructions || null,
      })),
    });
  } catch (e: any) {
    console.error("[API] d2l/courses/:courseId/assignments error:", e);
    // Check if error is REAUTH_REQUIRED
    if (e.message === "REAUTH_REQUIRED" || (e instanceof Error && e.message.includes("REAUTH_REQUIRED"))) {
      res.status(401).json({ 
        error: "REAUTH_REQUIRED",
        message: "Your D2L session has expired. Please sign in again using the WebView." 
      });
      return;
    }
    res.status(500).json({ error: "Failed to fetch assignments", details: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/d2l/courses/:courseId/grades — Get grades for a course */
router.get("/d2l/courses/:courseId/grades", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId } = req.params;
  const orgUnitId = parseInt(courseId, 10);

  if (isNaN(orgUnitId)) {
    res.status(400).json({ error: "Invalid course ID" });
    return;
  }

  try {
    // Get user's D2L host from credentials
    const { data: credsData } = await supabase
      .from("user_credentials")
      .select("host")
      .eq("user_id", userId)
      .eq("service", "d2l")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;
    if (!creds) {
      res.status(404).json({ error: "D2L credentials not found. Please connect D2L first." });
      return;
    }

    const client = new D2LClient(userId, creds.host);
    const grades = await client.getMyGradeValues(orgUnitId) as any[];
    const { marshalGrades } = await import("../utils/marshal.js");
    const marshalledGrades = marshalGrades(grades);

    res.json({ grades: marshalledGrades });
  } catch (e: any) {
    console.error("[API] d2l/courses/:courseId/grades error:", e);
    // Check if error is REAUTH_REQUIRED
    if (e.message === "REAUTH_REQUIRED" || (e instanceof Error && e.message.includes("REAUTH_REQUIRED"))) {
      res.status(401).json({ 
        error: "REAUTH_REQUIRED",
        message: "Your D2L session has expired. Please sign in again using the WebView." 
      });
      return;
    }
    res.status(500).json({ error: "Failed to fetch grades", details: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/d2l/courses/:courseId/content — Get content table of contents for a course */
router.get("/d2l/courses/:courseId/content", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId } = req.params;
  const orgUnitId = parseInt(courseId, 10);

  if (isNaN(orgUnitId)) {
    res.status(400).json({ error: "Invalid course ID" });
    return;
  }

  try {
    const { data: credsData } = await supabase
      .from("user_credentials")
      .select("host")
      .eq("user_id", userId)
      .eq("service", "d2l")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;
    if (!creds) {
      res.status(404).json({ error: "D2L credentials not found. Please connect D2L first." });
      return;
    }

    const client = new D2LClient(userId, creds.host);
    const toc = await client.getContentToc(orgUnitId) as any;
    const { marshalToc } = await import("../utils/marshal.js");
    const modules = marshalToc(toc);

    res.json({ modules });
  } catch (e: any) {
    console.error("[API] d2l/courses/:courseId/content error:", e);
    if (e.message === "REAUTH_REQUIRED" || e.message?.includes("REAUTH_REQUIRED")) {
      res.status(401).json({ error: "REAUTH_REQUIRED", message: "Your D2L session has expired. Please sign in again." });
      return;
    }
    res.status(500).json({ error: "Failed to fetch course content", details: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/d2l/courses/:courseId/file?url=<encoded> — Proxy a D2L file download (PDF etc) */
router.get("/d2l/courses/:courseId/file", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId } = req.params;
  const fileUrl = req.query.url as string;

  if (!fileUrl) {
    res.status(400).json({ error: "url query param required" });
    return;
  }

  try {
    const { data: credsData } = await supabase
      .from("user_credentials")
      .select("host, token")
      .eq("user_id", userId)
      .eq("service", "d2l")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;
    if (!creds) {
      res.status(404).json({ error: "D2L credentials not found" });
      return;
    }

    const d2lHost = resolveAllowedD2LHost(creds.host || DEFAULT_D2L_HOST);
    if (!d2lHost) {
      res.status(400).json({ error: "Unsupported D2L host" });
      return;
    }

    const fullUrl = resolveD2LFileUrl(fileUrl, d2lHost);
    if (!fullUrl) {
      res.status(400).json({ error: "Only files hosted on your D2L site can be proxied. Open external links directly." });
      return;
    }

    // Fetch with session cookies
    const { getToken } = await import("../auth.js");
    const token = await getToken(userId);
    const cookieHeader = d2lCookieHeader(token);

    const { resp: fetchResp, controller } = await fetchD2LFileSafely(fullUrl, d2lHost, cookieHeader);

    if (!fetchResp.ok) {
      try { await fetchResp.body?.cancel(); } catch { /* ignore */ }
      res.status(fetchResp.status).json({ error: `D2L returned ${fetchResp.status}` });
      return;
    }
    if (exceedsMaxSize(fetchResp)) {
      try { await fetchResp.body?.cancel(); } catch { /* ignore */ }
      res.status(413).json({ error: "File too large to proxy" });
      return;
    }

    const contentType = fetchResp.headers.get("content-type") || "application/octet-stream";
    const rawName = fileUrl.split("/").pop()?.split("?")[0] || "file.pdf";
    // Strip any character that could break out of the quoted filename or
    // smuggle additional header directives (CR/LF, quotes, backslashes).
    const filename = rawName.replace(/[\r\n"\\]/g, "_").slice(0, 200) || "file.pdf";

    // Only PDFs render inline; anything else (HTML, SVG, ...) is forced to
    // download so D2L-hosted content can't run script on our origin.
    const isPdf = /^application\/(x-)?pdf\b/i.test(contentType);
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${isPdf ? "inline" : "attachment"}; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");

    // Stream response body, cutting it off if it grows past the size cap or
    // stalls. pipeline() tears everything down (incl. the upstream fetch) on
    // error or client disconnect.
    if (!fetchResp.body) {
      res.end();
      return;
    }
    let streamed = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        armIdle();
        streamed += chunk.length;
        if (streamed > MAX_D2L_FILE_BYTES) {
          cb(new D2LFileFetchError(413, "File too large to proxy"));
          return;
        }
        cb(null, chunk);
      },
      flush(cb) { clearTimeout(idleTimer); cb(); },
    });
    function armIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => limiter.destroy(new D2LFileFetchError(504, "D2L stopped sending data")), D2L_BODY_IDLE_MS);
    }
    armIdle();
    pipeline(Readable.fromWeb(fetchResp.body as any), limiter, res, (err) => {
      clearTimeout(idleTimer);
      if (!err) return;
      controller.abort();
      if ((err as any)?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        console.error("[API] d2l file proxy stream error:", err);
      }
      if (!res.headersSent) res.status(502).json({ error: "Failed to proxy file" });
      else res.destroy();
    });
  } catch (e: any) {
    console.error("[API] d2l file proxy error:", e);
    if (e instanceof D2LFileFetchError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    res.status(500).json({ error: "Failed to proxy file", details: e.message });
  }
});

/** POST /api/d2l/courses/:courseId/file/save — Download D2L file, upload to S3, process as note */
router.post("/d2l/courses/:courseId/file/save", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId } = req.params;
  const { fileUrl, title } = req.body || {};

  if (!fileUrl || !title) {
    res.status(400).json({ error: "fileUrl and title required" });
    return;
  }

  if (!isS3Configured()) {
    res.status(503).json({ error: "S3 not configured" });
    return;
  }

  try {
    const { data: credsData } = await supabase
      .from("user_credentials")
      .select("host, token")
      .eq("user_id", userId)
      .eq("service", "d2l")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;
    if (!creds) {
      res.status(404).json({ error: "D2L credentials not found" });
      return;
    }

    const d2lHost = resolveAllowedD2LHost(creds.host || DEFAULT_D2L_HOST);
    if (!d2lHost) {
      res.status(400).json({ error: "Unsupported D2L host" });
      return;
    }

    const fullUrl = resolveD2LFileUrl(fileUrl, d2lHost);
    if (!fullUrl) {
      res.status(400).json({ error: "Only files hosted on your D2L site can be proxied. Open external links directly." });
      return;
    }

    const { getToken } = await import("../auth.js");
    const token2 = await getToken(userId);
    const cookieHeader = d2lCookieHeader(token2);

    // Download PDF buffer
    console.error(`[API] Downloading D2L file: ${fullUrl}`);
    const { resp: fetchResp } = await fetchD2LFileSafely(fullUrl, d2lHost, cookieHeader);

    if (!fetchResp.ok) {
      try { await fetchResp.body?.cancel(); } catch { /* ignore */ }
      res.status(fetchResp.status).json({ error: `D2L returned ${fetchResp.status}` });
      return;
    }
    if (exceedsMaxSize(fetchResp)) {
      try { await fetchResp.body?.cancel(); } catch { /* ignore */ }
      res.status(413).json({ error: "File too large to save" });
      return;
    }

    const buffer = await readBodyWithLimit(fetchResp);
    if (!looksLikePdf(fetchResp.headers.get("content-type"), buffer)) {
      res.status(415).json({ error: "Only PDF files can be saved as notes" });
      return;
    }
    const safeTitle = title.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "document";
    const noteId = crypto.randomUUID();
    const s3Key = `users/${userId}/notes/${noteId}-${safeTitle.replace(/ /g, "_")}.pdf`;

    // Upload to S3
    const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    await s3.send(new PutObjectCommand({ Bucket: getBucket(), Key: s3Key, Body: buffer, ContentType: "application/pdf" }));
    console.error(`[API] Uploaded to S3: ${s3Key}`);

    // Create note record
    const { data: note, error: insertErr } = await supabase
      .from("notes")
      .insert({
        id: noteId,
        user_id: userId,
        s3_key: s3Key,
        title: safeTitle,
        course_id: courseId || "default",
        status: "processing",
      })
      .select("id")
      .single();

    if (insertErr || !note) {
      res.status(500).json({ error: "Failed to create note record", details: insertErr?.message });
      return;
    }

    // Process PDF
    const { ingestPdfBuffer } = await import("../study/src/notes.js");
    const s3Url = `s3://${getBucket()}/${s3Key}`;
    let chunkCount = 0;
    let pageCount = 0;
    try {
      ({ chunkCount, pageCount } = await ingestPdfBuffer(userId, buffer, {
        noteId: note.id,
        courseId: courseId || "default",
        title: safeTitle,
        url: s3Url,
      }));
    } catch (ingestError) {
      // Don't leave the note stuck in "processing" (same as /notes/process)
      try {
        await supabase.from("notes").update({ status: "error" }).eq("id", note.id).eq("user_id", userId);
      } catch (updateErr) {
        console.error("[API] Failed to update note status to error:", updateErr);
      }
      throw ingestError;
    }

    await supabase.from("notes").update({ status: "ready", page_count: pageCount }).eq("id", note.id).eq("user_id", userId);

    res.json({ noteId: note.id, status: "ready", chunkCount, pageCount, s3Key });
  } catch (e: any) {
    console.error("[API] d2l file save error:", e);
    if (e instanceof D2LFileFetchError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    res.status(500).json({ error: "Failed to save file as note", details: e.message });
  }
});

/** GET /api/piazza/posts — Get stored Piazza posts for a user (from DB) */
router.get("/piazza/posts", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const courseId = req.query.courseId as string | undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

  try {
    let query = supabase
      .from("piazza_posts")
      .select("id, course_id, post_id, title, body, url, created_at, updated_at, metadata")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (courseId) query = query.eq("course_id", courseId);

    const { data: posts, error } = await query;

    if (error) {
      console.error("[API] piazza/posts error:", error);
      res.status(500).json({ error: "Failed to fetch Piazza posts" });
      return;
    }

    res.json({
      posts: (posts ?? []).map((p: any) => ({
        id: p.id,
        postId: p.post_id,
        courseId: p.course_id,
        title: p.title,
        snippet: p.body ? p.body.slice(0, 200) : null,
        url: p.url,
        date: p.updated_at || p.created_at,
        type: p.metadata?.type || 'post',
        answered: p.metadata?.answered ?? undefined,
        author: p.metadata?.author ?? undefined,
      })),
    });
  } catch (e) {
    console.error("[API] piazza/posts error:", e);
    res.status(500).json({ error: "Failed to fetch Piazza posts", details: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/d2l/save-credentials — Store D2L username/password for auto re-login */
router.post("/d2l/save-credentials", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { host, username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: "username and password required" });
    return;
  }
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) throw new Error("Missing Supabase config");
    const d2lHost = resolveAllowedD2LHost(host || DEFAULT_D2L_HOST);
    if (!d2lHost) {
      res.status(400).json({ error: "Unsupported D2L host" });
      return;
    }

    const encryptedPassword = await encryptPassword(password, d2lPasswordContext(userId));
    await logCredentialAccess(userId, "d2l_password", "write", "POST /d2l/save-credentials");

    // First try PATCH — only updates if row already exists (preserves token)
    const patchResp = await fetch(
      `${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.d2l`,
      {
        method: "PATCH",
        headers: {
          "apikey": sbKey, "Authorization": `Bearer ${sbKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
        },
        body: JSON.stringify({ username, password: encryptedPassword, host: d2lHost }),
      }
    );
    if (!patchResp.ok) throw new Error(await patchResp.text());
    const patched = await patchResp.json() as unknown[];

    if (patched.length === 0) {
      // No existing row — insert with placeholder token so future credential
      // re-login works even before the first VNC session completes.
      const insertResp = await fetch(`${sbUrl}/rest/v1/user_credentials`, {
        method: "POST",
        headers: {
          "apikey": sbKey, "Authorization": `Bearer ${sbKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: userId, service: "d2l",
          host: d2lHost, username, password: encryptedPassword,
          token: "{}",
          updated_at: new Date().toISOString(),
        }),
      });
      if (!insertResp.ok) throw new Error(await insertResp.text());
    }

    console.error(`[API] Saved D2L credentials for user ${userId}`);
    res.json({ ok: true });
  } catch (e: any) {
    console.error(`[API] save-credentials error for user ${userId}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/piazza/connect — Store Piazza credentials for user */
router.post("/piazza/connect", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { email, password } = req.body || {};

  if (!userId || !email || !password) {
    res.status(400).json({ error: "Invalid input: userId, email, and password are required." });
    return;
  }

  try {
    console.info("[API] Storing Piazza credentials:", { userId, email });

    const encryptedPiazzaPassword = await encryptPassword(password);
    await logCredentialAccess(userId, "piazza_password", "write", "POST /piazza/connect");
    const { error } = await supabase
      .from("user_credentials")
      .upsert({
        user_id: userId,
        service: "piazza",
        email,
        password: encryptedPiazzaPassword,
        token: "credential_auth",
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "user_id,service"
      });

    if (error) {
      console.error("[API] piazza/connect error:", error);
      res.status(500).json({ error: "Failed to store credentials" });
      return;
    }

    res.json({
      status: "connected",
      message: "Piazza credentials stored successfully"
    });
  } catch (e) {
    console.error("[API] piazza/connect error:", e);
    res.status(500).json({ error: "Unexpected error occurred while storing credentials." });
  }
});

/** POST /api/piazza/connect-cookie — Store Piazza cookies directly (from WebView) */
router.post("/piazza/connect-cookie", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { cookies } = req.body || {};

  if (!cookies || typeof cookies !== "string") {
    res.status(400).json({ error: "cookies required" });
    return;
  }

  const correlationId = `piazza-cookie-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    // Extract session_id from cookies (Piazza uses session_id as the main cookie)
    const sessionIdMatch = cookies.match(/session_id=([^;]+)/);
    if (!sessionIdMatch) {
      res.status(400).json({ error: "Invalid cookies: session_id not found" });
      return;
    }

    // Store cookies in user_credentials table as the 'token'
    // Store cookies as token (cookie-based auth)
    const { error } = await supabase
      .from("user_credentials")
      .upsert({
        user_id: userId,
        service: "piazza",
        token: cookies,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "user_id,service"
      });

    if (error) {
      console.error(`[API] [${correlationId}] piazza/connect-cookie error storing:`, error);
      res.status(500).json({ error: "Failed to store cookies", correlationId });
      return;
    }

    console.error(`[API] [${correlationId}] Piazza cookies stored, verifying...`);

    // Verify cookies work by making a test API call
    try {
      const cookieHeader = cookies;
      const testResponse = await fetch("https://piazza.com/logic/api?method=network.get_my_feed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "cookie": cookieHeader,
        },
        body: JSON.stringify({ method: "network.get_my_feed", params: { limit: 1 } }),
      });

      if (!testResponse.ok || testResponse.headers.get("content-type")?.includes("text/html")) {
        throw new Error("Invalid cookies - Piazza API returned error");
      }

      console.error(`[API] [${correlationId}] Piazza cookies verified successfully`);
      res.json({
        status: "connected",
        message: "Piazza connected via cookies successfully",
        correlationId
      });
    } catch (verifyError) {
      console.error(`[API] [${correlationId}] Piazza cookie verification failed:`, verifyError);

      // Delete invalid credentials
      const { error: deleteError } = await supabase
        .from("user_credentials")
        .delete()
        .eq("user_id", userId)
        .eq("service", "piazza");

      res.status(400).json({
        error: "Invalid or expired cookies. Please try logging in again.",
        details: verifyError instanceof Error ? verifyError.message : String(verifyError),
        correlationId
      });
    }
  } catch (e) {
    console.error(`[API] [${correlationId}] piazza/connect-cookie error:`, e);
    res.status(500).json({ 
      error: "Failed to connect Piazza", 
      details: e instanceof Error ? e.message : String(e),
      correlationId 
    });
  }
});

/** DELETE /api/piazza/disconnect — Remove Piazza credentials */
router.delete("/piazza/disconnect", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const { error } = await supabase
      .from("user_credentials")
      .delete()
      .eq("user_id", userId)
      .eq("service", "piazza");

    if (error) {
      console.error("[API] piazza/disconnect error:", error);
      res.status(500).json({ error: "Failed to disconnect Piazza" });
      return;
    }

    res.json({
      status: "disconnected",
      message: "Piazza disconnected successfully"
    });
  } catch (e) {
    console.error("[API] piazza/disconnect error:", e);
    res.status(500).json({ error: "Failed to disconnect", details: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/piazza/status — Get Piazza connection status */
router.get("/piazza/status", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    // Check if credentials exist in database
    const { data: credsData, error: credError } = await supabase
      .from("user_credentials")
      .select("email, token, updated_at")
      .eq("user_id", userId)
      .eq("service", "piazza")
      .limit(1);

    const creds = Array.isArray(credsData) ? credsData[0] : credsData;

    // Check if we have valid cookies/token (not just credentials)
    let cookieHeader: string | null = null;
    let hasValidAuth = false;
    
    // First check if token exists in database (cookies stored via WebView)
    if (creds?.token && typeof creds.token === "string") {
      const tokenValue = creds.token;
      // Verify cookies contain session_id (Piazza's main auth cookie)
      if (tokenValue.includes("session_id=")) {
        cookieHeader = tokenValue;
        hasValidAuth = true;
        console.error("[API] piazza/status - found valid cookies in DB");
      } else {
        console.error("[API] piazza/status - cookies in DB but missing session_id");
      }
    }
    
    // Fallback: try getPiazzaCookieHeader (for browser-based auth)
    if (!hasValidAuth) {
      try {
        const retrievedCookies = await getPiazzaCookieHeader(userId);
        // If we got cookies, verify they're valid by checking for session_id
        if (retrievedCookies && retrievedCookies.includes("session_id=")) {
          cookieHeader = retrievedCookies;
          hasValidAuth = true;
        }
      } catch (e) {
        // Not authenticated - that's fine
        console.error("[API] piazza/status - no valid auth:", e instanceof Error ? e.message : String(e));
      }
    }

    // Connected only if we have valid cookies/token (not just stored credentials)
    // This ensures we only show "connected" if actually authenticated
    const connected = hasValidAuth && cookieHeader !== null && cookieHeader.length > 0;

    // Get last sync time from piazza_posts table
    const { data: lastPostData } = await supabase
      .from("piazza_posts")
      .select("updated_at")
      .eq("user_id", req.userId!)
      .order("updated_at", { ascending: false })
      .limit(1);

    const lastPost = Array.isArray(lastPostData) ? lastPostData[0] : lastPostData;

    // Get classes count
    const { data: classes, count } = await supabase
      .from("piazza_posts")
      .select("course_id", { count: "exact", head: false })
      .eq("user_id", req.userId!);

    const uniqueClasses = new Set((classes || []).map((c: any) => c.course_id));
    const classesCount = uniqueClasses.size;

    res.json({
      connected,
      lastSync: lastPost?.updated_at || null,
      classesCount,
    });
  } catch (e) {
    console.error("[API] piazza/status error:", e);
    res.json({
      connected: false,
      lastSync: null,
      classesCount: 0,
    });
  }
});

/** POST /api/piazza/sync — Sync Piazza posts */
router.post("/piazza/sync", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId, sinceDays, maxPosts, highSignalOnly } = req.body || {};

  try {
    const result = await PiazzaTools.piazza_sync.handler({
      userId,
      courseId: courseId || undefined,
      sinceDays: sinceDays || 21,
      maxPosts: maxPosts || 40,
      highSignalOnly: highSignalOnly !== undefined ? highSignalOnly : true,
    });

    const parsed = JSON.parse(result);

    if (parsed.success) {
      res.json({
        status: "completed",
        message: "Piazza sync completed successfully",
        result: parsed,
      });
    } else {
      res.status(500).json({
        status: "failed",
        message: parsed.error || "Piazza sync failed",
        result: parsed,
      });
    }
  } catch (e) {
    console.error("[API] piazza/sync error:", e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    
    // Check if it's a browser launch error (production/AWS issue)
    if (errorMessage.includes("Failed to launch") || errorMessage.includes("browserType.launchPersistentContext")) {
      res.status(503).json({
        status: "failed",
        error: "Piazza sync is not available in this environment. Browser automation requires a local environment or manual authentication via the mobile app.",
        message: "Piazza sync requires browser automation which is not available in AWS ECS. Please use the mobile app to authenticate Piazza.",
      });
    } else {
      res.status(500).json({
        status: "failed",
        error: errorMessage,
      });
    }
  }
});

/** POST /api/piazza/embed-missing — Embed missing Piazza posts */
router.post("/piazza/embed-missing", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { courseId, limit, minChars } = req.body || {};

  try {
    const result = await PiazzaTools.piazza_embed_missing.handler({
      userId,
      courseId: courseId || undefined,
      limit: limit || 100,
      minChars: minChars || 200,
    });

    const parsed = JSON.parse(result);

    if (parsed.success) {
      res.json({
        status: "completed",
        message: "Piazza embedding completed",
        result: parsed,
      });
    } else {
      res.status(500).json({
        status: "failed",
        message: parsed.error || "Piazza embedding failed",
        result: parsed,
      });
    }
  } catch (e) {
    console.error("[API] piazza/embed-missing error:", e);
    res.status(500).json({
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

/** GET /api/piazza/search — Search Piazza posts */
router.get("/piazza/search", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const q = (req.query.q as string)?.trim();
  const courseId = (req.query.courseId as string) || undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

  // If no query, fall back to listing recent posts from DB
  if (!q) {
    try {
      let query = supabase
        .from("piazza_posts")
        .select("id, course_id, post_id, title, body, url, created_at, updated_at, metadata")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(limit);

      if (courseId) query = query.eq("course_id", courseId);

      const { data: posts, error } = await query;
      if (error) {
        res.status(500).json({ error: "Failed to fetch posts" });
        return;
      }

      const hits = (posts ?? []).map((p: any) => ({
        postId: p.post_id,
        title: p.title,
        snippet: p.body ? p.body.slice(0, 200) : null,
        url: p.url,
        score: 1,
        courseId: p.course_id,
        date: p.updated_at || p.created_at,
        type: p.metadata?.type || 'post',
        answered: p.metadata?.answered ?? undefined,
      }));
      res.json({ hits });
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch posts" });
    }
    return;
  }

  try {
    const result = await PiazzaTools.piazza_semantic_search.handler({
      userId,
      query: q,
      courseId,
      topK: limit,
    });

    const parsed = JSON.parse(result);

    if (parsed.success && parsed.results) {
      const hits = (parsed.results || []).map((r: any) => ({
        postId: r.post_id || r.id,
        title: r.title,
        snippet: r.body || r.preview || "",
        url: r.url,
        score: r.similarity || 0,
        courseId: r.course_id,
      }));

      res.json({ hits });
    } else {
      res.status(500).json({ error: parsed.error || "Search failed" });
    }
  } catch (e) {
    console.error("[API] piazza/search error:", e);
    res.status(500).json({ error: "Search failed", details: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/push/register — Register device token for push notifications */
router.post("/push/register", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { deviceToken, platform } = req.body || {};

  if (!deviceToken || !platform) {
    res.status(400).json({ error: "deviceToken and platform required" });
    return;
  }

  if (platform !== "ios" && platform !== "android") {
    res.status(400).json({ error: "platform must be 'ios' or 'android'" });
    return;
  }

  try {
    await registerDeviceToken(userId, deviceToken, platform);
    res.json({ status: "registered" });
  } catch (e) {
    console.error("[API] push/register error:", e);
    res.status(500).json({ error: "Failed to register device token", details: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/push/sync — Check for updates and send notifications (can be called by cron) */
router.post("/push/sync", async (req: Request, res: Response) => {
  const userId = req.userId!;

  try {
    const results = await checkAndNotifyUpdates(userId);
    res.json({
      status: "completed",
      results,
    });
  } catch (e) {
    console.error("[API] push/sync error:", e);
    res.status(500).json({ error: "Failed to check updates", details: e instanceof Error ? e.message : String(e) });
  }
});

// ============= BOOKMARKS =============

/** GET /api/bookmarks — List bookmarks for current user, optionally filtered by type */
router.get("/bookmarks", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const type = req.query.type as string | undefined;

  try {
    let query = supabase
      .from("bookmarks")
      .select("id, type, ref_id, title, url, metadata, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (type) query = query.eq("type", type);

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: "Failed to fetch bookmarks" });
      return;
    }
    res.json({ bookmarks: data ?? [] });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch bookmarks", details: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/bookmarks — Create a bookmark */
router.post("/bookmarks", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { type, ref_id, title, url, metadata } = req.body || {};

  if (!type || !ref_id || !title) {
    res.status(400).json({ error: "type, ref_id, and title are required" });
    return;
  }

  const validTypes = ['note', 'piazza_post', 'announcement', 'assignment'];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    return;
  }

  try {
    const { data, error } = await supabase
      .from("bookmarks")
      .upsert({
        user_id: userId,
        type,
        ref_id: String(ref_id),
        title,
        url: url || null,
        metadata: metadata || {},
      }, { onConflict: "user_id,type,ref_id" })
      .select("id, type, ref_id, title, url, metadata, created_at")
      .single();

    if (error) {
      res.status(500).json({ error: "Failed to create bookmark" });
      return;
    }
    res.status(201).json({ bookmark: data });
  } catch (e) {
    res.status(500).json({ error: "Failed to create bookmark", details: e instanceof Error ? e.message : String(e) });
  }
});

/** DELETE /api/bookmarks/:id — Remove a bookmark by id */
router.delete("/bookmarks/:id", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("bookmarks")
      .delete()
      .eq("user_id", userId)
      .eq("id", id);

    if (error) {
      res.status(500).json({ error: "Failed to delete bookmark" });
      return;
    }
    res.json({ status: "deleted", id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete bookmark", details: e instanceof Error ? e.message : String(e) });
  }
});

/** DELETE /api/bookmarks/ref/:type/:ref_id — Remove a bookmark by type+ref_id (convenient for toggle) */
router.delete("/bookmarks/ref/:type/:ref_id", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { type, ref_id } = req.params;

  try {
    const { error } = await supabase
      .from("bookmarks")
      .delete()
      .eq("user_id", userId)
      .eq("type", type)
      .eq("ref_id", ref_id);

    if (error) {
      res.status(500).json({ error: "Failed to delete bookmark" });
      return;
    }
    res.json({ status: "deleted" });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete bookmark", details: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/auth/logout — Logout user (clear any server-side sessions if needed) */
router.post("/auth/logout", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    console.error(`[API] User ${userId} logged out`);
    res.json({ status: "success", message: "Logged out successfully" });
  } catch (e) {
    console.error("[API] auth/logout error:", e);
    res.status(500).json({ error: "Failed to logout", details: e instanceof Error ? e.message : String(e) });
  }
});

// ── API Key Management ──────────────────────────────────────────────────────
import crypto from "crypto";

/** POST /api/api-keys — generate a new API key for the authenticated user */
router.post("/api-keys", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { name } = req.body || {};

  const raw = "hzn_" + crypto.randomBytes(32).toString("hex");
  const keyHash = crypto.createHash("sha256").update(raw).digest("hex");

  const { error } = await supabase
    .from("api_keys")
    .insert({ user_id: userId, key_hash: keyHash, name: name || "default" });

  if (error) {
    res.status(500).json({ error: "Failed to create API key", details: error.message });
    return;
  }

  // Return the raw key only once — it cannot be retrieved again
  res.json({ key: raw, name: name || "default" });
});

/** GET /api/api-keys — list API keys (without revealing the raw key) */
router.get("/api-keys", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, name, revoked, created_at")
    .eq("user_id", userId);

  if (error) {
    res.status(500).json({ error: "Failed to list API keys" });
    return;
  }
  res.json({ keys: data });
});

/** DELETE /api/api-keys/:id — revoke an API key */
router.delete("/api-keys/:id", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params;
  const { data, error } = await supabase
    .from("api_keys")
    .update({ revoked: true })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id");

  if (error && error.code === "22P02") {
    // Malformed id (not a uuid) can't match any key
    res.status(404).json({ error: "API key not found" });
    return;
  }
  if (error) {
    console.error("[API] api-keys revoke error:", error);
    res.status(500).json({ error: "Failed to revoke API key" });
    return;
  }
  if (!data || data.length === 0) {
    res.status(404).json({ error: "API key not found" });
    return;
  }

  res.json({ status: "revoked" });
});

// ─── Outline routes ───────────────────────────────────────────────────────────

/** POST /api/outline/connect — Store outline.uwaterloo.ca credentials and attempt headless login */
router.post("/outline/connect", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { username, password } = req.body || {};

  if (!username || !password) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  try {
    const encryptedPassword = await encryptPassword(password);
    await logCredentialAccess(userId, "outline_password", "write", "POST /outline/connect");
    const { error } = await supabase
      .from("user_credentials")
      .upsert({
        user_id: userId,
        service: "outline",
        host: "outline.uwaterloo.ca",
        username,
        password: encryptedPassword,
        // New credentials from the user lift outlineAuth's headless Duo hard stop.
        duo_required_at: null,
        notification_sent_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,service" });

    if (error) {
      console.error("[API] outline/connect upsert error:", error);
      res.status(500).json({ error: "Failed to store credentials" });
      return;
    }

    // Attempt immediate headless login to verify credentials and capture session cookie
    let loginStatus = "credentials_stored";
    try {
      const { loginToOutline } = await import("../study/outlineAuth.js");
      const cookie = await loginToOutline(userId);
      if (cookie) {
        loginStatus = "connected";
      } else {
        loginStatus = "credentials_stored_duo_required";
      }
    } catch (loginErr: any) {
      console.error("[API] outline/connect login attempt error:", loginErr?.message);
      loginStatus = "credentials_stored_login_pending";
    }

    res.json({
      status: loginStatus,
      message: loginStatus === "connected"
        ? "Connected to outline.uwaterloo.ca successfully"
        : "Credentials stored. Login will complete when outline tools are first used.",
    });
  } catch (e) {
    console.error("[API] outline/connect error:", e);
    res.status(500).json({ error: "Unexpected error", details: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/outline/connect-cookie — Store outline session cookie directly (from WebView) */
router.post("/outline/connect-cookie", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { cookies } = req.body || {};

  if (!cookies || typeof cookies !== "string") {
    res.status(400).json({ error: "cookies string is required" });
    return;
  }

  const sessionMatch = cookies.match(/sessionid=([^;]+)/);
  if (!sessionMatch) {
    res.status(400).json({ error: "Invalid cookies: sessionid not found" });
    return;
  }
  const sessionid = sessionMatch[1];

  // Validate cookie before storing
  try {
    const testResp = await fetch("https://outline.uwaterloo.ca/", {
      headers: { "Cookie": `sessionid=${sessionid}` },
      redirect: "manual",
    });
    const location = testResp.headers.get("location") || "";
    if (location.includes("oidc/login") || location.includes("duosecurity")) {
      res.status(400).json({ error: "Cookie is invalid or expired" });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: "Could not reach outline.uwaterloo.ca to validate cookie" });
    return;
  }

  const { error } = await supabase
    .from("user_credentials")
    .upsert({
      user_id: userId,
      service: "outline",
      host: "outline.uwaterloo.ca",
      token: JSON.stringify({ sessionid }),
      // Validated cookie from the user — clear any Duo hard stop.
      duo_required_at: null,
      notification_sent_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service" });

  if (error) {
    console.error("[API] outline/connect-cookie upsert error:", error);
    res.status(500).json({ error: "Failed to store cookie" });
    return;
  }

  res.json({ status: "connected", message: "outline.uwaterloo.ca connected via cookie" });
});

/** GET /api/outline/status — Check outline connection status */
router.get("/outline/status", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const { data } = await supabase
      .from("user_credentials")
      .select("token, duo_required_at, updated_at")
      .eq("user_id", userId)
      .eq("service", "outline")
      .limit(1);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      res.json({ connected: false });
      return;
    }

    let hasToken = false;
    try {
      const parsed = JSON.parse(row.token || "{}");
      hasToken = !!parsed.sessionid;
    } catch { /* no token yet */ }

    res.json({
      connected: hasToken && !row.duo_required_at,
      duoRequired: !!row.duo_required_at,
      lastUpdated: row.updated_at,
    });
  } catch (e) {
    res.json({ connected: false });
  }
});

/** GET /api/crowdmark/status — Is Crowdmark cookie stored? */
router.get("/crowdmark/status", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const { data } = await supabase
      .from("user_credentials")
      .select("token, updated_at")
      .eq("user_id", userId)
      .eq("service", "crowdmark")
      .single();
    const connected = !!(data?.token);
    res.json({ connected, lastUpdated: data?.updated_at || null });
  } catch {
    res.json({ connected: false, lastUpdated: null });
  }
});

/** POST /api/crowdmark/connect — Store Crowdmark session cookie for user */
router.post("/crowdmark/connect", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { cookie } = req.body || {};

  if (!cookie || typeof cookie !== "string") {
    res.status(400).json({ error: "cookie required (value of _crowdmark_session from browser DevTools)" });
    return;
  }

  try {
    const { error } = await supabase
      .from("user_credentials")
      .upsert({
        user_id: userId,
        service: "crowdmark",
        token: cookie,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,service" });

    if (error) {
      res.status(500).json({ error: "Failed to store Crowdmark cookie" });
      return;
    }

    // Quick validation: try to list assignments
    const cookieHeader = cookie.includes('=') ? cookie : `_crowdmark_session=${cookie}`;
    try {
      const testRes = await fetch("https://app.crowdmark.com/api/v2/student/assignments?fields[exam-masters][]=title", {
        headers: { Cookie: cookieHeader, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (testRes.status === 401 || testRes.status === 403) {
        res.status(400).json({ error: "Crowdmark cookie invalid or expired. Please copy a fresh _crowdmark_session cookie." });
        return;
      }
    } catch {
      // Network error on validation — still store the cookie
    }

    res.json({ success: true, message: "Crowdmark connected." });
  } catch (e) {
    console.error("[API] crowdmark/connect error:", e);
    res.status(500).json({ error: "Unexpected error" });
  }
});

/** GET /api/notion/status — Is Notion token stored? */
router.get("/notion/status", async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const { data } = await supabase
      .from("user_credentials")
      .select("token, updated_at")
      .eq("user_id", userId)
      .eq("service", "notion")
      .single();
    const connected = !!(data?.token);
    res.json({ connected, lastUpdated: data?.updated_at || null });
  } catch {
    res.json({ connected: false, lastUpdated: null });
  }
});

/** GET /api/notion/oauth-url — Build the Notion OAuth authorization URL for the current user */
router.get("/notion/oauth-url", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const clientId = process.env.NOTION_CLIENT_ID;
  const redirectUri = process.env.NOTION_REDIRECT_URI
    || (process.env.API_HOST
      ? `https://${process.env.API_HOST}/auth/notion/callback`
      : "https://horizon.hamzaammar.ca/auth/notion/callback");

  if (!clientId) {
    res.status(503).json({ error: "Notion OAuth is not configured on this server." });
    return;
  }

  // Must be HMAC-signed: the public callback rejects unsigned state (verifyNotionState).
  const state = signNotionState(userId);
  const url = `https://api.notion.com/v1/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  res.json({ url });
});

export default router;
