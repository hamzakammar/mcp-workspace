import { getToken, forceRefreshToken } from "./auth.js";

const D2L_HOST = process.env.D2L_HOST || "learn.ul.ie";
const BASE_URL = `https://${D2L_HOST}`;
const API_VERSION = "1.57";

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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    isRetry = false
  ): Promise<ApiResponse<T>> {
    const requestStartTime = Date.now();
    const baseUrl = this.host ? `https://${this.host}` : BASE_URL;
    const url = `${baseUrl}${path}`;

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
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const fetchStartTime = Date.now();
    const response = await fetch(url, options);
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

      throw new Error(`D2L API error ${response.status}: ${errorText}`);
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
  async getMyEnrollments() {
    return this.get(`/d2l/api/lp/1.43/enrollments/myenrollments/`);
  }

  // Quiz endpoints (LE API v1.67)
  async getQuizzes(orgUnitId: number) {
    return this.get(`/d2l/api/le/1.67/${orgUnitId}/quizzes/`);
  }

  async getQuiz(orgUnitId: number, quizId: number) {
    return this.get(`/d2l/api/le/1.67/${orgUnitId}/quizzes/${quizId}`);
  }

  async getQuizAttempts(orgUnitId: number, quizId: number) {
    return this.get(`/d2l/api/le/1.67/${orgUnitId}/quizzes/${quizId}/attempts/myAttempts/`);
  }

  // Rubric endpoints (LE API v1.67)
  async getRubrics(orgUnitId: number) {
    return this.get(`/d2l/api/le/1.67/${orgUnitId}/rubrics/`);
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
