import { describe, it, expect } from 'vitest';
import {
  stripHtml,
  formatDate,
  formatRelativeDate,
  formatFileSize,
  removeEmpty,
  marshalGrades,
  marshalAnnouncements,
  marshalCalendarEvents,
  marshalEnrollments,
  marshalAssignments,
  marshalAssignment,
  marshalSubmissions,
} from '../d2l-mcp/src/utils/marshal.js';

import gradesFixture from '../fixtures/grades.json';
import announcementsFixture from '../fixtures/announcements.json';
import calendarFixture from '../fixtures/calendar.json';
import enrollmentsFixture from '../fixtures/enrollments.json';
import assignmentsFixture from '../fixtures/assignments.json';
import submissionsFixture from '../fixtures/submissions.json';

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <strong>World</strong></p>')).toBe('Hello World');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#39;')).toBe("& < > \" '");
  });

  it('replaces &nbsp; with space', () => {
    expect(stripHtml('Hello&nbsp;World')).toBe('Hello World');
  });

  it('collapses multiple newlines', () => {
    expect(stripHtml('Line1\n\n\n\nLine2')).toBe('Line1\n\nLine2');
  });

  it('handles null/undefined', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });

  it('trims whitespace', () => {
    expect(stripHtml('  \n  Hello  \n  ')).toBe('Hello');
  });
});

describe('formatDate', () => {
  it('formats ISO date to readable string', () => {
    const result = formatDate('2025-11-24T17:00:00.000Z');
    expect(result).toMatch(/Nov 24, 2025/);
  });

  it('returns null for null input', () => {
    expect(formatDate(null)).toBe(null);
  });

  it('returns null for undefined input', () => {
    expect(formatDate(undefined)).toBe(null);
  });
});

describe('formatRelativeDate', () => {
  it('returns "today" for current date', () => {
    const now = new Date().toISOString();
    expect(formatRelativeDate(now)).toBe('today');
  });

  it('returns null for null input', () => {
    expect(formatRelativeDate(null)).toBe(null);
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(2048)).toBe('2.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(2007067)).toBe('1.9 MB');
  });
});

describe('removeEmpty', () => {
  it('removes null values', () => {
    expect(removeEmpty({ a: 1, b: null })).toEqual({ a: 1 });
  });

  it('removes undefined values', () => {
    expect(removeEmpty({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('removes empty strings', () => {
    expect(removeEmpty({ a: 'hello', b: '' })).toEqual({ a: 'hello' });
  });

  it('removes empty arrays', () => {
    expect(removeEmpty({ a: [1, 2], b: [] })).toEqual({ a: [1, 2] });
  });

  it('keeps falsy but valid values', () => {
    expect(removeEmpty({ a: 0, b: false })).toEqual({ a: 0, b: false });
  });
});

describe('marshalGrades', () => {
  it('transforms raw grades to clean format', () => {
    const result = marshalGrades(gradesFixture as any);
    
    expect(result[0]).toHaveProperty('name', 'Weekly Report');
    expect(result[0]).toHaveProperty('score', '10/10');
    expect(result[0]).toHaveProperty('percentage', '100 %');
    expect(result[0]).toHaveProperty('lastModified');
  });

  it('includes feedback when present', () => {
    const result = marshalGrades(gradesFixture as any);
    expect(result[1]).toHaveProperty('feedback', 'Good work!');
  });

  it('handles null scores gracefully', () => {
    const result = marshalGrades(gradesFixture as any);
    // Score is removed by removeEmpty when null, so it's undefined
    expect(result[2].score).toBeUndefined();
  });

  it('excludes empty feedback', () => {
    const result = marshalGrades(gradesFixture as any);
    expect(result[0].feedback).toBeUndefined();
  });
});

describe('marshalAnnouncements', () => {
  it('transforms raw announcements to clean format', () => {
    const result = marshalAnnouncements(announcementsFixture as any);
    
    expect(result[0]).toHaveProperty('id', 118403);
    expect(result[0]).toHaveProperty('title', 'Technology Report new submission date');
    expect(result[0].body).not.toContain('<');
    expect(result[0]).toHaveProperty('date');
  });

  it('includes attachments when present', () => {
    const result = marshalAnnouncements(announcementsFixture as any);
    expect(result[1].attachments).toHaveLength(1);
    expect(result[1].attachments![0]).toEqual({
      name: 'syllabus.pdf',
      size: '100.0 KB',
    });
  });

  it('strips HTML from body', () => {
    const result = marshalAnnouncements(announcementsFixture as any);
    expect(result[0].body).not.toContain('<strong>');
    expect(result[0].body).toContain('Technology Report');
  });
});

describe('marshalCalendarEvents', () => {
  it('transforms raw calendar events to clean format', () => {
    const result = marshalCalendarEvents(calendarFixture as any);
    
    expect(result[0]).toHaveProperty('title', 'Weekly Report');
    expect(result[0]).toHaveProperty('dueDate');
    expect(result[0]).toHaveProperty('dueDateRelative');
    expect(result[0]).toHaveProperty('course', 'CS4444 - RESIDENCY 2');
    expect(result[0]).toHaveProperty('type', 'assignment');
    expect(result[0]).toHaveProperty('assignmentId', 37826);
    expect(result[0]).toHaveProperty('viewUrl');
  });

  it('detects quiz type', () => {
    const result = marshalCalendarEvents(calendarFixture as any);
    expect(result[1].type).toBe('quiz');
  });

  it('includes submit URL when available', () => {
    const result = marshalCalendarEvents(calendarFixture as any);
    expect(result[1].submitUrl).toContain('quiz_summary');
  });
});

describe('marshalEnrollments', () => {
  it('filters to Course Offerings only', () => {
    const result = marshalEnrollments(enrollmentsFixture as any);
    
    // Should only include Course Offerings, not Organizations or Groups
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('Course Offering');
  });

  it('transforms to flat structure', () => {
    const result = marshalEnrollments(enrollmentsFixture as any);
    
    expect(result[0]).toHaveProperty('id', 68929);
    expect(result[0]).toHaveProperty('name');
    expect(result[0]).toHaveProperty('code', 'CS4444_SEM1_2025_6');
    expect(result[0]).toHaveProperty('homeUrl');
    expect(result[0]).toHaveProperty('isActive', true);
    expect(result[0]).toHaveProperty('canAccess', true);
  });
});

describe('marshalAssignments', () => {
  it('transforms raw assignments to clean format', () => {
    const result = marshalAssignments(assignmentsFixture as any);
    
    expect(result[0]).toHaveProperty('id', 37812);
    expect(result[0]).toHaveProperty('name', 'Weekly Report');
    expect(result[0]).toHaveProperty('dueDate');
    expect(result[0]).toHaveProperty('points', 10);
    expect(result[0]).toHaveProperty('allowedFileTypes', '.docx');
  });

  it('includes instructions without HTML', () => {
    const result = marshalAssignments(assignmentsFixture as any);
    expect(result[0].instructions).toBe('Submit your weekly report in .docx format.');
  });

  it('includes attachments when present', () => {
    const result = marshalAssignments(assignmentsFixture as any);
    expect(result[1].attachments).toHaveLength(1);
  });

  it('includes link attachments when present', () => {
    const result = marshalAssignments(assignmentsFixture as any);
    expect(result[1].links).toHaveLength(1);
    expect(result[1].links![0].name).toBe('Citation Guide');
  });

  it('sets allowedFileTypes to "any" when AllowableFileType is 0', () => {
    const result = marshalAssignments(assignmentsFixture as any);
    expect(result[1].allowedFileTypes).toBe('any');
  });
});

describe('marshalAssignment', () => {
  it('transforms single assignment', () => {
    const result = marshalAssignment(assignmentsFixture[0] as any);
    
    expect(result).toHaveProperty('id', 37812);
    expect(result).toHaveProperty('name', 'Weekly Report');
  });
});

describe('marshalSubmissions', () => {
  it('transforms raw submissions to clean format', () => {
    const result = marshalSubmissions(submissionsFixture as any);
    
    expect(result[0]).toHaveProperty('submitted', true);
    expect(result[0]).toHaveProperty('submittedBy', 'Test User');
    expect(result[0]).toHaveProperty('submissionDate');
    expect(result[0]).toHaveProperty('submissionDateRelative');
    expect(result[0]).toHaveProperty('grade', 45);
    expect(result[0]).toHaveProperty('feedback', 'Excellent work on the analysis!');
  });

  it('includes file information', () => {
    const result = marshalSubmissions(submissionsFixture as any);
    expect(result[0].files).toHaveLength(1);
    expect(result[0].files[0]).toEqual({
      name: 'TechnologyAnalysis.pdf',
      size: '1.9 MB',
    });
  });

  it('includes submission comment when present', () => {
    const result = marshalSubmissions(submissionsFixture as any);
    expect(result[0].comment).toBe('Here is my submission');
  });
});
