// DateEvent classification system for Learn API dates

export enum DateType {
  DUE = 'due',
  AVAILABLE_FROM = 'available_from',
  CLOSES = 'closes',
  OPENS = 'opens',
  FEEDBACK_RELEASE = 'feedback_release',
  EXAM = 'exam',
  LECTURE = 'lecture',
  UNKNOWN = 'unknown',
}

export enum Confidence {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

export interface DateEvent {
  courseId: number;
  courseName: string;
  title: string;
  datetime: string; // ISO 8601 format
  dateType: DateType;
  source: string; // e.g., "calendar", "assignment", "quiz"
  url: string | null;
  confidence: Confidence;
  rawSnippet: string; // Original text used for classification
  assignmentId?: number | null;
  /** D2L AssociatedEntityType (e.g. "D2L.LE.Dropbox.Dropbox"); ids are only unique per type. */
  entityType?: string | null;
}

// Classification patterns
const PATTERNS = {
  due: {
    high: [
      /\bdue\b/i,
      /\bdeadline\b/i,
      /\bsubmit by\b/i,
      /\bmust be submitted\b/i,
      /\bno later than\b/i,
      /\bdue date\b/i,
      /\bsubmission deadline\b/i,
    ],
    medium: [
      /\bsubmit\b/i,
      /\bhand in\b/i,
      /\bturn in\b/i,
    ],
  },
  // Assessment deliverables — these are graded work, not scheduled meetings. Only
  // checked after explicit availability phrases, so "Assignment 1 - Availability
  // Starts" is an opening date, not a deadline.
  dueNouns: {
    high: [
      /\bassignment\b/i,
      /\bhomework\b/i,
      /\bproblem set\b/i,
      /\bpset\b/i,
      /\bproject\b/i,
      /\bmilestone\b/i,
    ],
  },
  // Explicit "this opens now" phrases — strong enough to beat deliverable nouns.
  available_from_explicit: {
    high: [
      /\bavailability\s+(?:starts|begins|opens)\b/i,
      /\bavailable from\b/i,
      /\bopens\b/i,
    ],
  },
  // Weaker availability words ("Assignment 1 (available on Crowdmark)",
  // "Project posted") — only used when no deliverable noun matched.
  available_from: {
    high: [
      /\breleased\b/i,
      /\bposted\b/i,
      /\bwill be available\b/i,
      /\bstarts\b/i,
      /\bbegins\b/i,
      /\bavailability\b/i,
    ],
    medium: [
      /\bavailable\b/i,
    ],
  },
  closes: {
    high: [
      /\bavailability ends?\b/i,
      /\bcloses\b/i,
      /\bavailable until\b/i,
      /\bopen until\b/i,
      /\bwindow closes\b/i,
      /\bwill close\b/i,
      /\bends\b/i,
      /\bexpires\b/i,
      /\bfinal date\b/i,
      /\blast day\b/i,
    ],
    medium: [
      /\buntil\b/i,
      /\bby\b/i,
    ],
  },
  feedback_release: {
    high: [
      /\bfeedback\b/i,
      /\bgrade release\b/i,
      /\bresults available\b/i,
      /\bscores posted\b/i,
    ],
  },
  exam: {
    high: [
      /\bexam\b/i,
      /\btest\b/i,
      /\bmidterm\b/i,
      /\bfinal\b/i,
      /\bquiz\b/i,
    ],
  },
  lecture: {
    high: [
      /\blecture\b/i,
      /\bclass\b/i,
      /\blesson\b/i,
      /\bseminar\b/i,
      /\btutorial\b/i,
      // Scheduled meetings that are NOT assessments. A graded lab deliverable is
      // still included via stronger signals (Dropbox entity, or "assignment"/"due"
      // in the title, which are checked before this category), so a bare "lab" here
      // only excludes lab meetings that carry no assessment signal.
      /\boffice hours?\b/i,
      /\blab\b/i,
      /\blaboratory\b/i,
      /\brecitation\b/i,
      /\bworkshop\b/i,
    ],
  },
};

type Rule = { dateType: DateType; confidence: Confidence; patterns: RegExp[] };

/**
 * Ordered classification rules. Explicit deadline phrases ("due", "deadline")
 * win; then explicit availability phrases (ends/until → CLOSES, then
 * "availability starts" / "opens" / "available from" → AVAILABLE_FROM); then
 * deliverable nouns ("assignment", "project") imply a due date. Plain
 * "available"/"posted"/"released" never beat a deliverable noun.
 */
const RULES: Rule[] = [
  { dateType: DateType.DUE, confidence: Confidence.HIGH, patterns: PATTERNS.due.high },
  { dateType: DateType.CLOSES, confidence: Confidence.HIGH, patterns: PATTERNS.closes.high },
  { dateType: DateType.AVAILABLE_FROM, confidence: Confidence.HIGH, patterns: PATTERNS.available_from_explicit.high },
  { dateType: DateType.DUE, confidence: Confidence.HIGH, patterns: PATTERNS.dueNouns.high },
  { dateType: DateType.DUE, confidence: Confidence.MEDIUM, patterns: PATTERNS.due.medium },
  { dateType: DateType.AVAILABLE_FROM, confidence: Confidence.HIGH, patterns: PATTERNS.available_from.high },
  { dateType: DateType.AVAILABLE_FROM, confidence: Confidence.MEDIUM, patterns: PATTERNS.available_from.medium },
  { dateType: DateType.CLOSES, confidence: Confidence.MEDIUM, patterns: PATTERNS.closes.medium },
  { dateType: DateType.FEEDBACK_RELEASE, confidence: Confidence.HIGH, patterns: PATTERNS.feedback_release.high },
  { dateType: DateType.EXAM, confidence: Confidence.HIGH, patterns: PATTERNS.exam.high },
  { dateType: DateType.LECTURE, confidence: Confidence.HIGH, patterns: PATTERNS.lecture.high },
];

/** True when `text` contains an explicit deadline phrase ("due", "deadline", …). */
export function hasDuePhrase(text: string | null | undefined): boolean {
  return !!text && PATTERNS.due.high.some((p) => p.test(text));
}

/**
 * Classify a date event based on title, description, and context
 */
export function classifyDateEvent(
  title: string,
  description: string = '',
  eventType: string | null = null
): { dateType: DateType; confidence: Confidence; snippet: string } {
  const text = `${title} ${description}`.toLowerCase();

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (match) {
        return { dateType: rule.dateType, confidence: rule.confidence, snippet: match[0] };
      }
    }
  }
  
  // Fallback based on event type
  if (eventType) {
    if (eventType.includes('Dropbox') || eventType.includes('Assignment')) {
      return {
        dateType: DateType.DUE,
        confidence: Confidence.MEDIUM,
        snippet: 'inferred from assignment type',
      };
    }
    if (eventType.includes('Quiz')) {
      return {
        dateType: DateType.EXAM,
        confidence: Confidence.MEDIUM,
        snippet: 'inferred from quiz type',
      };
    }
  }
  
  return {
    dateType: DateType.UNKNOWN,
    confidence: Confidence.LOW,
    snippet: text.substring(0, 50),
  };
}

function isDropboxEntity(entityType: string | null | undefined): boolean {
  return !!entityType && /Dropbox/i.test(entityType);
}

/**
 * Deduplicate date events by associated entity (type + id), prioritizing due dates
 */
export function deduplicateDateEvents(events: DateEvent[]): DateEvent[] {
  // Group by entity type + id — a Dropbox folder and a Quiz can share a numeric id.
  const grouped = new Map<string, DateEvent[]>();
  const nonAssignment: DateEvent[] = [];
  
  for (const event of events) {
    if (event.assignmentId) {
      const key = `${event.entityType || ''}#${event.assignmentId}`;
      const group = grouped.get(key) || [];
      group.push(event);
      grouped.set(key, group);
    } else {
      nonAssignment.push(event);
    }
  }
  
  // For each assignment, pick the best date
  const deduplicated: DateEvent[] = [];
  
  for (const [_, group] of grouped) {
    // A Dropbox folder whose only end-type date is "availability ends"/"closes"
    // has that as its effective deadline.
    if (isDropboxEntity(group[0].entityType) && !group.some((e) => e.dateType === DateType.DUE)) {
      const closes = group
        .filter((e) => e.dateType === DateType.CLOSES)
        .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())[0];
      if (closes) {
        deduplicated.push({ ...closes, dateType: DateType.DUE, confidence: Confidence.MEDIUM });
        continue;
      }
    }

    if (group.length === 1) {
      deduplicated.push(group[0]);
      continue;
    }

    // Priority: an explicit "due"/"deadline" phrase > DUE high > DUE medium > other
    const duePhrase = group.find(
      (e) => e.dateType === DateType.DUE && (hasDuePhrase(e.rawSnippet) || hasDuePhrase(e.title)),
    );
    if (duePhrase) {
      deduplicated.push(duePhrase);
      continue;
    }

    const dueHighConf = group.find(e => e.dateType === DateType.DUE && e.confidence === Confidence.HIGH);
    if (dueHighConf) {
      deduplicated.push(dueHighConf);
      continue;
    }
    
    const dueMedConf = group.find(e => e.dateType === DateType.DUE && e.confidence === Confidence.MEDIUM);
    if (dueMedConf) {
      deduplicated.push(dueMedConf);
      continue;
    }
    
    // If no clear due date, take the middle date (sorted chronologically)
    const sorted = [...group].sort((a, b) => 
      new Date(a.datetime).getTime() - new Date(b.datetime).getTime()
    );
    const middleIndex = Math.floor(sorted.length / 2);
    deduplicated.push(sorted[middleIndex]);
  }
  
  return [...deduplicated, ...nonAssignment];
}

/**
 * Group date events by category for presentation
 */
export function groupDateEventsByCategory(events: DateEvent[]): {
  dueSoon: DateEvent[];
  opensSoon: DateEvent[];
  closesSoon: DateEvent[];
  needsConfirmation: DateEvent[];
  other: DateEvent[];
} {
  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  
  const dueSoon: DateEvent[] = [];
  const opensSoon: DateEvent[] = [];
  const closesSoon: DateEvent[] = [];
  const needsConfirmation: DateEvent[] = [];
  const other: DateEvent[] = [];
  
  for (const event of events) {
    const eventDate = new Date(event.datetime);
    const isWithinWeek = eventDate <= sevenDaysFromNow;
    
    if (event.dateType === DateType.UNKNOWN || event.confidence === Confidence.LOW) {
      needsConfirmation.push(event);
    } else if (event.dateType === DateType.DUE && isWithinWeek) {
      dueSoon.push(event);
    } else if (event.dateType === DateType.AVAILABLE_FROM && isWithinWeek) {
      opensSoon.push(event);
    } else if (event.dateType === DateType.CLOSES && isWithinWeek) {
      closesSoon.push(event);
    } else {
      other.push(event);
    }
  }
  
  // Sort each group by date
  const sortByDate = (a: DateEvent, b: DateEvent) => 
    new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
  
  return {
    dueSoon: dueSoon.sort(sortByDate),
    opensSoon: opensSoon.sort(sortByDate),
    closesSoon: closesSoon.sort(sortByDate),
    needsConfirmation: needsConfirmation.sort(sortByDate),
    other: other.sort(sortByDate),
  };
}

/**
 * Convert DateEvent to Task (only for high-confidence due dates)
 */
export function shouldConvertToTask(event: DateEvent): boolean {
  return event.dateType === DateType.DUE && event.confidence === Confidence.HIGH;
}
