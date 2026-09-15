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
      // Assessment deliverables — these are graded work, not scheduled meetings.
      /\bassignment\b/i,
      /\bhomework\b/i,
      /\bproblem set\b/i,
      /\bpset\b/i,
      /\bproject\b/i,
      /\bmilestone\b/i,
    ],
    medium: [
      /\bsubmit\b/i,
      /\bhand in\b/i,
      /\bturn in\b/i,
    ],
  },
  available_from: {
    high: [
      /\bavailable from\b/i,
      /\bopens\b/i,
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
      /\bcloses\b/i,
      /\bavailable until\b/i,
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

/**
 * Classify a date event based on title, description, and context
 */
export function classifyDateEvent(
  title: string,
  description: string = '',
  eventType: string | null = null
): { dateType: DateType; confidence: Confidence; snippet: string } {
  const text = `${title} ${description}`.toLowerCase();
  
  // Check each pattern category in priority order
  for (const [type, levels] of Object.entries(PATTERNS)) {
    // Check high confidence patterns first
    if (levels.high) {
      for (const pattern of levels.high) {
        if (pattern.test(text)) {
          const match = text.match(pattern);
          return {
            dateType: type as DateType,
            confidence: Confidence.HIGH,
            snippet: match ? match[0] : text.substring(0, 50),
          };
        }
      }
    }
    
    // Then medium confidence patterns
    if ('medium' in levels && levels.medium) {
      for (const pattern of levels.medium) {
        if (pattern.test(text)) {
          const match = text.match(pattern);
          return {
            dateType: type as DateType,
            confidence: Confidence.MEDIUM,
            snippet: match ? match[0] : text.substring(0, 50),
          };
        }
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

/**
 * Deduplicate date events by assignment ID, prioritizing due dates
 */
export function deduplicateDateEvents(events: DateEvent[]): DateEvent[] {
  // Group by assignmentId
  const grouped = new Map<number, DateEvent[]>();
  const nonAssignment: DateEvent[] = [];
  
  for (const event of events) {
    if (event.assignmentId) {
      const group = grouped.get(event.assignmentId) || [];
      group.push(event);
      grouped.set(event.assignmentId, group);
    } else {
      nonAssignment.push(event);
    }
  }
  
  // For each assignment, pick the best date
  const deduplicated: DateEvent[] = [];
  
  for (const [_, group] of grouped) {
    if (group.length === 1) {
      deduplicated.push(group[0]);
      continue;
    }
    
    // Priority: DUE with high confidence > DUE with medium > other types
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
