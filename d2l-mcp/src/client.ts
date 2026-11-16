import { getToken, forceRefreshToken, getD2LToken } from "./auth.js";
import { DEFAULT_D2L_HOST, resolveAllowedD2LHost } from "./utils/d2lHost.js";
import type { RawQuizAttempt } from "./utils/marshal.js";

const API_VERSION = "1.57";

/** Abort any single D2L API call that takes longer than this. */
export const D2L_REQUEST_TIMEOUT_MS = 30_000;

/** Upper bound on pages followed for paged list endpoints. */
const MAX_PAGES = 20;

/** Cache of each user's stored D2L host so we don't hit the DB on every API call. */
const HOST_CACHE_TTL_MS = 5 * 60 * 1000;
const HOST_CACHE_MAX = 1000;
const hostCache = new Map<string, { host: string; expires: number }>();

/** Cache of whoami Identifier per user+host, with a TTL and a size bound. */
const WHOAMI_CACHE_TTL_MS = 60 * 60 * 1000;
const WHOAMI_CACHE_MAX = 1000;
const whoamiCache = new Map<string, { id: string; expires: number }>();

/** Bounded insert: evict the oldest entry once the map is full. */
function boundedSet<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Forget a user's cached D2L host (call after they reconnect / change host). */
export function clearD2LHostCache(userId: string): void {
  hostCache.delete(userId);
  for (const key of whoamiCache.keys()) {
    if (key.endsWith(`|${userId}`)) whoamiCache.delete(key);
  }
}

/** Error thrown for a non-2xx D2L response; carries the HTTP status. */
export class D2LApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`D2L API error ${status}: ${body}`);
    this.name = "D2LApiError";
    this.status = status;
  }
}

/** Test hook: forget cached hosts / whoami identifiers. */
export function clearD2LClientCaches(): void {
  hostCache.clear();
  whoamiCache.clear();
}

interface ApiResponse<T = unknown> {
  data: T;
  status: number;
}

export class D2LClient {
  private userId?: string;
  private host?: string;

  constructor(userId?: string, host?: string) {
    this.userId = userId;
    this.host = host;
  }

  /**
   * The D2L host for this client: the explicit constructor host, else the
   * user's stored host, else DEFAULT_D2L_HOST. Always allowlist-checked — a
   * host that isn't allowed is refused rather than silently replaced.
   */
  async resolveHost(): Promise<string> {
    if (this.host) {
      const allowed = resolveAllowedD2LHost(this.host);
      if (!allowed) {
        throw new Error(`D2L host "${this.host}" is not an allowed D2L host; refusing to send requests to it.`);
      }
      return allowed;
    }
    if (!this.userId) return DEFAULT_D2L_HOST;

    const cached = hostCache.get(this.userId);
    if (cached && cached.expires > Date.now()) return cached.host;

    const row = await getD2LToken(this.userId).catch(() => null);
    const raw = row?.host || DEFAULT_D2L_HOST;
    const allowed = resolveAllowedD2LHost(raw);
    if (!allowed) {
      throw new Error(`Stored D2L host "${raw}" is not an allowed D2L host; reconnect D2L with a supported host.`);
    }
    // Cache the result, including the DEFAULT_D2L_HOST fallback, so users with no
    // stored host don't cost a DB lookup per API call.
    boundedSet(hostCache, this.userId, { host: allowed, expires: Date.now() + HOST_CACHE_TTL_MS }, HOST_CACHE_MAX);
    return allowed;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    isRetry = false
  ): Promise<ApiResponse<T>> {
    const requestStartTime = Date.now();
    const host = await this.resolveHost();
    const url = `https://${host}${path}`;

    console.error(`[API] Starting ${method} request to: ${path}`);

    const tokenStartTime = Date.now();
    const token = await getToken(this.userId);
    const tokenTime = Date.now() - tokenStartTime;
    console.error(`[API] Token obtained (${tokenTime}ms)`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (token) {
      // Try to parse stored cookie token (JSON: { d2lSessionVal, d2lSecureSessionVal })
      try {
        const parsed = JSON.parse(token);
        if (parsed.d2lSessionVal && parsed.d2lSecureSessionVal) {
          headers["Cookie"] = `d2lSessionVal=${parsed.d2lSessionVal}; d2lSecureSessionVal=${parsed.d2lSecureSessionVal}`;
        } else {
          headers["Authorization"] = `Bearer ${token}`;
        }
      } catch {
        // Plain token string — use as Bearer
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    const options: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(D2L_REQUEST_TIMEOUT_MS),
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const fetchStartTime = Date.now();
    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`D2L API request timed out after ${D2L_REQUEST_TIMEOUT_MS / 1000}s: ${method} ${path}`);
      }
      throw err;
    }
    const fetchTime = Date.now() - fetchStartTime;

    console.error(
      `[API] ${method} ${path} - Status: ${response.status} (${fetchTime}ms)`
    );

    if (!response.ok) {
      const errorText = await response.text();
      const totalTime = Date.now() - requestStartTime;
      console.error(
        `[API] ${method} ${path} - Error ${response.status} (${totalTime}ms): ${errorText}`
      );

      // On 403, the server-side D2L session may have expired before the scheduler ran.
      // Attempt an immediate headless re-login and retry the request once.
      if (response.status === 403 && this.userId && !isRetry) {
        console.error(`[API] 403 on ${path} for user ${this.userId} — attempting immediate re-auth`);
        const newToken = await forceRefreshToken(this.userId);
        if (newToken) {
          console.error(`[API] Re-auth succeeded, retrying ${method} ${path}`);
          return this.request<T>(method, path, body, true);
        }
      }

      throw new D2LApiError(response.status, errorText);
    }

    const parseStartTime = Date.now();
    const data = (await response.json()) as T;
    const parseTime = Date.now() - parseStartTime;
    const totalTime = Date.now() - requestStartTime;

    console.error(
      `[API] ${method} ${path} - Completed (parse: ${parseTime}ms, total: ${totalTime}ms)`
    );

    return { data, status: response.status };
  }

  async get<T>(path: string): Promise<T> {
    const { data } = await this.request<T>("GET", path);
    return data;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const { data } = await this.request<T>("POST", path, body);
    return data;
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const { data } = await this.request<T>("PUT", path, body);
    return data;
  }

  async delete<T>(path: string): Promise<T> {
    const { data } = await this.request<T>("DELETE", path);
    return data;
  }

  // Dropbox/Assignment endpoints
  async getDropboxFolders(orgUnitId: number) {
    return this.get(`/d2l/api/le/${API_VERSION}/${orgUnitId}/dropbox/folders/`);
  }

  async getDropboxFolder(orgUnitId: number, folderId: number) {
    return this.get(
      `/d2l/api/le/${API_VERSION}/${orgUnitId}/dropbox/folders/${folderId}`
    );
  }

  async getDropboxSubmissions(orgUnitId: number, folderId: number) {
    return this.get(
      `/d2l/api/le/${API_VERSION}/${orgUnitId}/dropbox/folders/${folderId}/submissions/`
    );
  }

  // Content endpoints
  async getContentToc(orgUnitId: number) {
    return this.get(`/d2l/api/le/${API_VERSION}/${orgUnitId}/content/toc`);
  }

  async getContentTopic(orgUnitId: number, topicId: number) {
    return this.get(
      `/d2l/api/le/${API_VERSION}/${orgUnitId}/content/topics/${topicId}`
    );
  }

  async getContentModules(orgUnitId: number) {
    return this.get(`/d2l/api/le/${API_VERSION}/${orgUnitId}/content/root/`);
  }

  async getContentModule(orgUnitId: number, moduleId: number) {
    return this.get(
      `/d2l/api/le/${API_VERSION}/${orgUnitId}/content/modules/${moduleId}/structure/`
    );
  }

  // User info
  async whoami() {
    return this.get(`/d2l/api/lp/1.43/users/whoami`);
  }

  // Grades endpoints
  async getMyGradeValues(orgUnitId: number) {
    return this.get(
      `/d2l/api/le/${API_VERSION}/${orgUnitId}/grades/values/myGradeValues/`
    );
  }

  async getGradeObjects(orgUnitId: number) {
    return this.get(`/d2l/api/le/${API_VERSION}/${orgUnitId}/grades/`);
  }

  // Calendar endpoints
  async getMyCalendarEvents(
    orgUnitId: number,
    startDateTime: string,
    endDateTime: string
  ) {
    const params = new URLSearchParams({
      startDateTime,
      endDateTime,
    });
    return this.get(
      `/d2l/api/le/${API_VERSION}/${orgUnitId}/calendar/events/myEvents/?${params}`
    );
  }

  // News/Announcements endpoints
  async getNews(orgUnitId: number) {
    return this.get(`/d2l/api/le/${API_VERSION}/${orgUnitId}/news/`);
  }

  // Enrollments endpoints (uses LP API v1.43)
  // myenrollments is a PagedResultSet ({ PagingInfo: { Bookmark, HasMoreItems }, Items }).
  // Follow bookmarks so users with many org units don't lose courses past page 1;
  // returns the same shape with all Items merged.
  async getMyEnrollments() {
    const base = `/d2l/api/lp/1.43/enrollments/myenrollments/`;
    const items: unknown[] = [];
    let bookmark: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const path: string = bookmark ? `${base}?bookmark=${encodeURIComponent(bookmark)}` : base;
      const res = (await this.get(path)) as {
        Items?: unknown[];
        PagingInfo?: { Bookmark?: string | null; HasMoreItems?: boolean };
      };
      if (Array.isArray(res?.Items)) items.push(...res.Items);
      const next = res?.PagingInfo?.HasMoreItems ? res.PagingInfo.Bookmark : null;
      if (!next || next === bookmark) break;
      bookmark = next;
    }
    return { Items: items, PagingInfo: { Bookmark: null, HasMoreItems: false } };
  }

  /**
   * Fetch every page of an ObjectListPage endpoint ({ Objects, Next }), where
   * Next is an absolute URL on the same host (or null). Returns { Objects, Next: null }.
   * A bare-array response is returned as-is.
   */
  async getAllObjectPages<T = unknown>(firstPath: string): Promise<{ Objects: T[]; Next: null } | T[]> {
    const objects: T[] = [];
    let path: string | null = firstPath;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES && path; page++) {
      seen.add(path);
      const res = (await this.get(path)) as { Objects?: T[]; Next?: string | null } | T[];
      if (Array.isArray(res)) return page === 0 ? res : objects.concat(res);
      if (Array.isArray(res?.Objects)) objects.push(...res.Objects);
      path = null;
      if (res?.Next) {
        try {
          const host = await this.resolveHost();
          const u = new URL(res.Next, `https://${host}`);
          if (u.hostname.toLowerCase() === host) {
            const nextPath = `${u.pathname}${u.search}`;
            if (!seen.has(nextPath)) path = nextPath;
          }
        } catch {
          // malformed Next — stop paging
        }
      }
    }
    return { Objects: objects, Next: null };
  }

  /** whoami Identifier for the current user (cached). Null if unavailable. */
  async getMyUserIdentifier(): Promise<string | null> {
    const key = `${await this.resolveHost()}|${this.userId ?? ""}`;
    const cached = whoamiCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.id;
    try {
      const me = (await this.whoami()) as { Identifier?: string | number };
      const id = me?.Identifier != null ? String(me.Identifier) : null;
      if (id) boundedSet(whoamiCache, key, { id, expires: Date.now() + WHOAMI_CACHE_TTL_MS }, WHOAMI_CACHE_MAX);
      return id;
    } catch {
      return null;
    }
  }

  // Quiz endpoints (LE API v1.67)
  // ObjectListPage of QuizReadData — follow Next so later pages aren't dropped.
  async getQuizzes(orgUnitId: number) {
    return this.getAllObjectPages(`/d2l/api/le/1.67/${orgUnitId}/quizzes/`);
  }

  async getQuiz(orgUnitId: number, quizId: number) {
    return this.get(`/d2l/api/le/1.67/${orgUnitId}/quizzes/${quizId}`);
  }

  // Documented route: GET .../quizzes/(quizId)/attempts/?userId= → ObjectListPage
  // of QuizAttemptData. Scoped to the caller's own user id (from whoami) so a
  // user with staff rights doesn't get everyone's attempts. Throws on error —
  // callers should treat only a 404 as "no attempts".
  async getQuizAttempts(orgUnitId: number, quizId: number) {
    const me = await this.getMyUserIdentifier();
    const qs = me ? `?userId=${encodeURIComponent(me)}` : "";
    return this.getAllObjectPages<RawQuizAttempt>(
      `/d2l/api/le/1.67/${orgUnitId}/quizzes/${quizId}/attempts/${qs}`
    );
  }

  // Rubric endpoints (LE API v1.67). With objectType/objectId (e.g. "Dropbox",
  // folderId) returns the array of Rubric blocks associated with that object.
  async getRubrics(orgUnitId: number, objectType?: string, objectId?: number) {
    const params = new URLSearchParams();
    if (objectType) params.set("objectType", objectType);
    if (objectId != null) params.set("objectId", String(objectId));
    const qs = params.toString();
    return this.get(`/d2l/api/le/1.67/${orgUnitId}/rubrics/${qs ? `?${qs}` : ""}`);
  }

  // Submission status — check if the current user has submitted a specific assignment
  async getMySubmissions(orgUnitId: number, folderId: number) {
    return this.get(
      `/d2l/api/le/${API_VERSION}/${orgUnitId}/dropbox/folders/${folderId}/submissions/mysubmissions/`
    );
  }

  // Discussion endpoints
  async getDiscussionForums(orgUnitId: number) {
    return this.get(`/d2l/api/le/${API_VERSION}/${orgUnitId}/discussions/forums/`);
  }

  async getDiscussionTopics(orgUnitId: number, forumId: number) {
    return this.get(`/d2l/api/le/${API_VERSION}/${orgUnitId}/discussions/forums/${forumId}/topics/`);
  }
}

// Lazy proxy — picks up the current request's userId from AsyncLocalStorage on each call.
import { getUserId } from "./utils/userContext.js";

export const client: D2LClient = new Proxy({} as D2LClient, {
  get(_target, prop) {
    const instance = new D2LClient(getUserId());
    return (instance as any)[prop]?.bind(instance);
  },
});
