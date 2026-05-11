import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the client before importing tools
vi.mock('../d2l-mcp/src/client.js', () => ({
  client: {
    getMyGradeValues: vi.fn(),
    getNews: vi.fn(),
    getMyCalendarEvents: vi.fn(),
    getMyEnrollments: vi.fn(),
    getDropboxFolders: vi.fn(),
    getDropboxFolder: vi.fn(),
    getDropboxSubmissions: vi.fn(),
    getContentToc: vi.fn(),
    getContentTopic: vi.fn(),
    getContentModules: vi.fn(),
    getContentModule: vi.fn(),
  },
}));

import { client } from '../d2l-mcp/src/client.js';
import { gradeTools } from '../d2l-mcp/src/tools/grades.js';
import { newsTools } from '../d2l-mcp/src/tools/news.js';
import { calendarTools } from '../d2l-mcp/src/tools/calendar.js';
import { enrollmentTools } from '../d2l-mcp/src/tools/enrollments.js';
import { assignmentTools } from '../d2l-mcp/src/tools/dropbox.js';

import gradesFixture from '../fixtures/grades.json';
import announcementsFixture from '../fixtures/announcements.json';
import calendarFixture from '../fixtures/calendar.json';
import enrollmentsFixture from '../fixtures/enrollments.json';
import assignmentsFixture from '../fixtures/assignments.json';
import submissionsFixture from '../fixtures/submissions.json';

describe('gradeTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.D2L_COURSE_ID = '68929';
  });

  describe('get_my_grades', () => {
    it('returns marshalled grades', async () => {
      vi.mocked(client.getMyGradeValues).mockResolvedValue(gradesFixture);

      const result = await gradeTools.get_my_grades.handler({ orgUnitId: 68929 });
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(3);
      expect(parsed[0]).toHaveProperty('name', 'Weekly Report');
      expect(parsed[0]).toHaveProperty('score', '10/10');
    });

    it('uses provided course ID', async () => {
      vi.mocked(client.getMyGradeValues).mockResolvedValue([]);

      await gradeTools.get_my_grades.handler({ orgUnitId: 12345 });

      expect(client.getMyGradeValues).toHaveBeenCalledWith(12345);
    });

    it('throws when no course ID available', async () => {
      delete process.env.D2L_COURSE_ID;

      await expect(gradeTools.get_my_grades.handler({})).rejects.toThrow(
        'orgUnitId is required'
      );
    });
  });
});

describe('newsTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.D2L_COURSE_ID = '68929';
  });

  describe('get_announcements', () => {
    it('returns marshalled announcements', async () => {
      vi.mocked(client.getNews).mockResolvedValue(announcementsFixture);

      const result = await newsTools.get_announcements.handler({ orgUnitId: 68929 });
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toHaveProperty('title', 'Technology Report new submission date');
      expect(parsed[0].body).not.toContain('<');
    });
  });
});

describe('calendarTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.D2L_COURSE_ID = '68929';
  });

  describe('get_upcoming_due_dates', () => {
    it('returns marshalled calendar events', async () => {
      vi.mocked(client.getMyCalendarEvents).mockResolvedValue(calendarFixture);

      const result = await calendarTools.get_upcoming_due_dates.handler({
        orgUnitId: 68929,
        daysBack: 7,
        daysAhead: 30,
      });
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toHaveProperty('title', 'Weekly Report');
      expect(parsed[0]).toHaveProperty('type', 'assignment');
    });

    it('calculates date range correctly', async () => {
      vi.mocked(client.getMyCalendarEvents).mockResolvedValue({ Objects: [] });

      await calendarTools.get_upcoming_due_dates.handler({
        orgUnitId: 68929,
        daysBack: 7,
        daysAhead: 30,
      });

      expect(client.getMyCalendarEvents).toHaveBeenCalledWith(
        68929,
        expect.any(String),
        expect.any(String)
      );

      const [, startDate, endDate] = vi.mocked(client.getMyCalendarEvents).mock.calls[0];
      const start = new Date(startDate);
      const end = new Date(endDate);
      const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      
      expect(diffDays).toBe(37); // 7 days back + 30 days ahead
    });
  });
});

describe('enrollmentTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_my_courses', () => {
    it('returns marshalled courses filtered to Course Offerings', async () => {
      vi.mocked(client.getMyEnrollments).mockResolvedValue(enrollmentsFixture);

      const result = await enrollmentTools.get_my_courses.handler();
      const parsed = JSON.parse(result);

      // Should filter out Organization and Group types
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toHaveProperty('type', 'Course Offering');
      expect(parsed[0]).toHaveProperty('id', 68929);
    });
  });
});

describe('assignmentTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.D2L_COURSE_ID = '68929';
  });

  describe('get_assignments', () => {
    it('returns marshalled assignments', async () => {
      vi.mocked(client.getDropboxFolders).mockResolvedValue(assignmentsFixture);

      const result = await assignmentTools.get_assignments.handler({ orgUnitId: 68929 });
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toHaveProperty('name', 'Weekly Report');
      expect(parsed[0]).toHaveProperty('points', 10);
    });
  });

  describe('get_assignment', () => {
    it('returns marshalled single assignment', async () => {
      vi.mocked(client.getDropboxFolder).mockResolvedValue(assignmentsFixture[0]);

      const result = await assignmentTools.get_assignment.handler({
        orgUnitId: 68929,
        assignmentId: 37812,
      });
      const parsed = JSON.parse(result);

      expect(parsed).toHaveProperty('id', 37812);
      expect(parsed).toHaveProperty('name', 'Weekly Report');
    });
  });

  describe('get_assignment_submissions', () => {
    it('returns marshalled submissions', async () => {
      vi.mocked(client.getDropboxSubmissions).mockResolvedValue(submissionsFixture);

      const result = await assignmentTools.get_assignment_submissions.handler({
        orgUnitId: 68929,
        assignmentId: 37839,
      });
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toHaveProperty('submitted', true);
      expect(parsed[0]).toHaveProperty('grade', 45);
      expect(parsed[0].files).toHaveLength(1);
    });
  });
});
