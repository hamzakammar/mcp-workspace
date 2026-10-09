import { supabase } from '../lib/supabase';

const BASE_URL = 'https://horizon.hamzaammar.ca/api';

/** Error thrown by apiClient for non-2xx responses: `status` is the HTTP status, `data` the parsed error body. */
export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** The backend returns 401 with these codes when the user's D2L session (not their Horizon session) needs re-auth. */
function isD2LReauthBody(body: any): boolean {
  return body?.error === 'REAUTH_REQUIRED' || body?.error === 'AUTH_REQUIRED';
}

async function getAuthHeader(forceRefresh = false): Promise<string> {
  if (forceRefresh) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session?.access_token) throw new Error('Not authenticated');
    return `Bearer ${data.session.access_token}`;
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  return `Bearer ${session.access_token}`;
}

async function request<T>(method: string, path: string, body?: any, options?: any, isRetry = false): Promise<{ data: T }> {
  const authHeader = await getAuthHeader(isRetry);
  const cleanPath = path.startsWith('/') ? path.substring(1) : path;

  let url = `${BASE_URL}/${cleanPath}`;

  if (options?.params) {
    const params = new URLSearchParams(options.params);
    url += `?${params.toString()}`;
  }

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      ...options?.headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    // On 401, force-refresh the Horizon session and retry once — unless the 401 is a D2L re-auth
    // signal, which a new Supabase token won't fix.
    if (response.status === 401 && !isRetry && !isD2LReauthBody(errorBody)) {
      return request<T>(method, path, body, options, true);
    }
    throw new ApiError(errorBody?.error || errorBody?.message || `HTTP ${response.status}`, response.status, errorBody);
  }

  const data = await response.json() as T;
  return { data };
}

export const apiClient = {
  get: <T = any>(path: string, options?: any) => request<T>('GET', path, undefined, options),
  post: <T = any>(path: string, body?: any, options?: any) => request<T>('POST', path, body, options),
  delete: <T = any>(path: string, options?: any) => request<T>('DELETE', path, undefined, options),
  invoke: <T = any>(path: string, method: string, body?: any, options?: any) => request<T>(method, path, body, options),
};

export default apiClient;
