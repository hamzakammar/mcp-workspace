import "dotenv/config";
import { describe, it, expect } from "vitest";
import { client } from "../d2l-mcp/src/client.js";

const SKIP = !process.env.D2L_INTEGRATION_TESTS;
const COURSE_ID = parseInt(process.env.D2L_COURSE_ID || "68929");

describe.skipIf(SKIP)("D2L API Integration Tests", () => {
  describe("Grades API", () => {
    it("fetches grades with expected shape", async () => {
      const grades = await client.getMyGradeValues(COURSE_ID);

      expect(Array.isArray(grades)).toBe(true);

      if ((grades as any[]).length > 0) {
        const grade = (grades as any[])[0];
        expect(grade).toHaveProperty("GradeObjectName");
        expect(grade).toHaveProperty("PointsNumerator");
        expect(grade).toHaveProperty("PointsDenominator");
        expect(grade).toHaveProperty("DisplayedGrade");
      }
    });
  });

  describe("Announcements API", () => {
    it("fetches announcements with expected shape", async () => {
      const news = await client.getNews(COURSE_ID);

      expect(Array.isArray(news)).toBe(true);

      if ((news as any[]).length > 0) {
        const announcement = (news as any[])[0];
        expect(announcement).toHaveProperty("Id");
        expect(announcement).toHaveProperty("Title");
        expect(announcement).toHaveProperty("Body");
        expect(announcement.Body).toHaveProperty("Text");
      }
    });
  });

  describe("Calendar API", () => {
    it("fetches calendar events with expected shape", async () => {
      const now = new Date();
      const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const events = await client.getMyCalendarEvents(
        COURSE_ID,
        startDate.toISOString(),
        endDate.toISOString()
      );

      expect(events).toHaveProperty("Objects");
      expect(Array.isArray((events as any).Objects)).toBe(true);

      if ((events as any).Objects.length > 0) {
        const event = (events as any).Objects[0];
        expect(event).toHaveProperty("Title");
        expect(event).toHaveProperty("StartDateTime");
        expect(event).toHaveProperty("CalendarEventViewUrl");
      }
    });
  });

  describe("Enrollments API", () => {
    it("fetches enrollments with expected shape", async () => {
      const enrollments = await client.getMyEnrollments();

      expect(enrollments).toHaveProperty("Items");
      expect(Array.isArray((enrollments as any).Items)).toBe(true);

      if ((enrollments as any).Items.length > 0) {
        const enrollment = (enrollments as any).Items[0];
        expect(enrollment).toHaveProperty("OrgUnit");
        expect(enrollment.OrgUnit).toHaveProperty("Id");
        expect(enrollment.OrgUnit).toHaveProperty("Name");
        expect(enrollment).toHaveProperty("Access");
      }
    });
  });

  describe("Assignments API", () => {
    it("fetches assignments with expected shape", async () => {
      const assignments = await client.getDropboxFolders(COURSE_ID);

      expect(Array.isArray(assignments)).toBe(true);

      if ((assignments as any[]).length > 0) {
        const assignment = (assignments as any[])[0];
        expect(assignment).toHaveProperty("Id");
        expect(assignment).toHaveProperty("Name");
        expect(assignment).toHaveProperty("DueDate");
        expect(assignment).toHaveProperty("Assessment");
      }
    });
  });

  describe("Content API", () => {
    it("fetches content TOC with expected shape", async () => {
      const toc = await client.getContentToc(COURSE_ID);

      expect(toc).toHaveProperty("Modules");
      expect(Array.isArray((toc as any).Modules)).toBe(true);
    });

    it("fetches content modules with expected shape", async () => {
      const modules = await client.getContentModules(COURSE_ID);

      expect(Array.isArray(modules)).toBe(true);
    });
  });

  describe("User API", () => {
    it("fetches whoami with expected shape", async () => {
      const user = await client.whoami();

      expect(user).toHaveProperty("Identifier");
      expect(user).toHaveProperty("FirstName");
      expect(user).toHaveProperty("LastName");
    });
  });
});
