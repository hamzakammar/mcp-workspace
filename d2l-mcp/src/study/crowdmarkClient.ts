/**
 * CrowdmarkClient — student grade/feedback access via session cookie.
 *
 * Crowdmark has no public API. The student-facing endpoints are internal
 * REST routes used by the web app. Authentication is purely cookie-based:
 * the user must supply their session cookie from an authenticated browser
 * session at app.crowdmark.com.
 *
 * Supported endpoints (discovered via community reverse-engineering):
 *   GET /api/v2/student/courses      — list enrolled courses
 *   GET /api/v2/student/assignments  — list all assignments
 *   GET /api/v1/student/results/{id} — graded result for one assignment
 *
 * WARNING: These are undocumented internal APIs. They may change without notice.
 * Treat this integration as best-effort.
 */

import { supabase } from '../utils/supabase.js';

const CROWDMARK_BASE = 'https://app.crowdmark.com';
const CROWDMARK_SERVICE = 'crowdmark';
const REQUEST_TIMEOUT_MS = 15_000;

// ─── Token management ─────────────────────────────────────────────────────────

export async function getCrowdmarkCookie(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('user_credentials')
      .select('token')
      .eq('user_id', userId)
      .eq('service', CROWDMARK_SERVICE)
      .single();
    if (error || !data?.token) return null;
    return data.token as string;
  } catch {
    return null;
  }
}

export async function saveCrowdmarkCookie(userId: string, cookie: string): Promise<void> {
  await supabase.from('user_credentials').upsert({
    user_id: userId,
    service: CROWDMARK_SERVICE,
    token: cookie,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,service' });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function crowdmarkFetch<T>(path: string, cookieHeader: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${CROWDMARK_BASE}${path}`, {
      headers: {
        'Cookie': cookieHeader,
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new CrowdmarkAuthError();
    }
    if (!res.ok) {
      throw new Error(`Crowdmark API error ${res.status}: ${await res.text()}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export class CrowdmarkAuthError extends Error {
  constructor() {
    super('crowdmark_auth_required');
    this.name = 'CrowdmarkAuthError';
  }
}

// ─── API methods ──────────────────────────────────────────────────────────────

export interface CrowdmarkAssignment {
  id: string;
  title: string;
  type: string;
  courseName: string | null;
  courseId: string | null;
}

export interface CrowdmarkResult {
  assignmentId: string;
  title: string;
  totalPoints: number | null;
  earnedPoints: number | null;
  percentage: number | null;
  classAverage: number | null;
  questions: Array<{
    label: string;
    points: number | null;
    earnedPoints: number | null;
    feedback: string[];
  }>;
}

// Primary data: type="assignments", relationships["exam-master"] -> exam-masters id
// Included: type="exam-masters", attributes.title + attributes.type
interface V2AssignmentDoc {
  id: string;
  type: string;
  attributes?: {
    'submitted-at'?: string;
    'due'?: string;
    'marks-sent-at'?: string;
    'normalized-points'?: string;
  };
  relationships?: {
    'exam-master'?: { data?: { type?: string; id?: string } };
    course?: { data?: { id?: string }; meta?: { included?: boolean } };
  };
}
interface V2AssignmentResponse {
  data?: V2AssignmentDoc[];
  included?: Array<{ id: string; type: string; attributes?: { title?: string; type?: string; name?: string } }>;
}

// Fields on exam-masters (included) — title and type are the useful ones
const ASSIGNMENTS_URL = '/api/v2/student/assignments?fields[exam-masters][]=title&fields[exam-masters][]=type';

export async function fetchCrowdmarkAssignmentsRaw(cookieHeader: string): Promise<V2AssignmentResponse> {
  return crowdmarkFetch<V2AssignmentResponse>(ASSIGNMENTS_URL, cookieHeader);
}

export async function fetchCrowdmarkAssignments(
  cookieHeader: string
): Promise<CrowdmarkAssignment[]> {
  const raw = await fetchCrowdmarkAssignmentsRaw(cookieHeader);

  // Build a map of exam-master id -> { title, type } from the included array
  const examMasterMap = new Map<string, { title: string; type: string }>();
  for (const inc of (raw.included || [])) {
    if (inc.type === 'exam-masters' && inc.id) {
      examMasterMap.set(inc.id, {
        title: inc.attributes?.title || inc.id,
        type: inc.attributes?.type || 'unknown',
      });
    }
  }

  return (raw.data || []).map((a) => {
    const examMasterId = a.relationships?.['exam-master']?.data?.id || null;
    const examMaster = examMasterId ? examMasterMap.get(examMasterId) : null;
    return {
      id: a.id,
      title: examMaster?.title || a.id,
      type: examMaster?.type || 'unknown',
      courseName: null, // course is not included in this response
      courseId: null,
    };
  });
}

interface V1ResultDoc {
  data?: {
    id: string;
    attributes?: { total_points?: number; class_results?: { mean?: number } };
    relationships?: {
      'exam-questions'?: { data?: Array<{ id: string }> };
    };
  };
  included?: Array<{
    id: string;
    type: string;
    attributes?: {
      label?: string;
      points?: number;
      total_points?: number;
      earned_points?: number;
      annotations?: Array<{ comment?: string }>;
    };
  }>;
}

export async function fetchCrowdmarkResult(
  cookieHeader: string,
  assignmentId: string
): Promise<CrowdmarkResult> {
  const raw = await crowdmarkFetch<V1ResultDoc>(
    `/api/v1/student/results/${assignmentId}`,
    cookieHeader
  );
  const data = raw.data;
  const included = raw.included || [];

  const totalPoints = data?.attributes?.total_points ?? null;
  const classAverage = data?.attributes?.class_results?.mean ?? null;

  // Map included exam-questions to question details
  const questionIds = (data?.relationships?.['exam-questions']?.data || []).map((q) => q.id);
  const questionMap = new Map<string, (typeof included)[0]>();
  for (const inc of included) {
    if (inc.type === 'exam-questions') questionMap.set(inc.id, inc);
  }

  let earnedTotal = 0;
  const questions = questionIds.map((qId) => {
    const q = questionMap.get(qId);
    const earned = q?.attributes?.earned_points ?? null;
    const maxPts = q?.attributes?.points ?? q?.attributes?.total_points ?? null;
    if (earned != null) earnedTotal += earned;
    const feedback = (q?.attributes?.annotations || [])
      .map((a) => a.comment || '')
      .filter(Boolean);
    return {
      label: q?.attributes?.label || qId,
      points: maxPts,
      earnedPoints: earned,
      feedback,
    };
  });

  const earnedPoints = questionIds.length > 0 ? earnedTotal : null;
  const percentage =
    totalPoints && earnedPoints != null
      ? Math.round((earnedPoints / totalPoints) * 1000) / 10
      : null;

  return {
    assignmentId,
    title: assignmentId, // v1 doesn't include title — caller may enrich
    totalPoints,
    earnedPoints,
    percentage,
    classAverage: classAverage != null ? Math.round(classAverage * 10) / 10 : null,
    questions,
  };
}
