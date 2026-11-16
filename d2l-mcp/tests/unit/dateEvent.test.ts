import { describe, it, expect } from 'vitest';
import {
  classifyDateEvent,
  deduplicateDateEvents,
  DateType,
  Confidence,
  type DateEvent,
} from '../../src/utils/dateEvent.js';

describe('classifyDateEvent — availability phrases beat deliverable nouns', () => {
  it('"Assignment 1 - Availability Starts" is an opening date, not a deadline', () => {
    const r = classifyDateEvent('Assignment 1 - Availability Starts');
    expect(r.dateType).toBe(DateType.AVAILABLE_FROM);
  });

  it('plain "available"/"posted" do not beat deliverable nouns', () => {
    expect(classifyDateEvent('Assignment 1 (available on Crowdmark)').dateType).toBe(DateType.DUE);
    expect(classifyDateEvent('Project 2 - Available').dateType).toBe(DateType.DUE);
    expect(classifyDateEvent('Homework 3 posted').dateType).toBe(DateType.DUE);
    // …but still classify when there is no deliverable noun
    expect(classifyDateEvent('Solutions posted').dateType).toBe(DateType.AVAILABLE_FROM);
  });

  it('explicit opening phrases beat deliverable nouns', () => {
    expect(classifyDateEvent('Assignment 4 opens').dateType).toBe(DateType.AVAILABLE_FROM);
    expect(classifyDateEvent('Project available from Monday').dateType).toBe(DateType.AVAILABLE_FROM);
  });

  it('"Assignment 2 – Availability Ends" closes', () => {
    expect(classifyDateEvent('Assignment 2 – Availability Ends').dateType).toBe(DateType.CLOSES);
  });

  it('"Quiz 1 - Availability Ends" closes', () => {
    expect(classifyDateEvent('Quiz 1 - Availability Ends').dateType).toBe(DateType.CLOSES);
  });

  it('"Assignment 3 available until Friday" closes', () => {
    expect(classifyDateEvent('Assignment 3 available until Friday').dateType).toBe(DateType.CLOSES);
  });

  it('explicit due phrases still win', () => {
    expect(classifyDateEvent('Assignment 1 - Due').dateType).toBe(DateType.DUE);
    expect(classifyDateEvent('Assignment 1 - Due').confidence).toBe(Confidence.HIGH);
    expect(classifyDateEvent('Quiz 2 deadline').dateType).toBe(DateType.DUE);
  });

  it('bare deliverable nouns still imply a due date', () => {
    const r = classifyDateEvent('Project Milestone');
    expect(r.dateType).toBe(DateType.DUE);
    expect(r.confidence).toBe(Confidence.HIGH);
    expect(classifyDateEvent('Assignment 4').dateType).toBe(DateType.DUE);
  });

  it('meetings and exams are unchanged', () => {
    expect(classifyDateEvent('Weekly Lecture').dateType).toBe(DateType.LECTURE);
    expect(classifyDateEvent('Midterm Exam').dateType).toBe(DateType.EXAM);
  });
});

function ev(partial: Partial<DateEvent>): DateEvent {
  const title = partial.title ?? 'x';
  const c = classifyDateEvent(title);
  return {
    courseId: 1,
    courseName: 'CS 1',
    title,
    datetime: '2026-11-20T04:59:00Z',
    dateType: c.dateType,
    confidence: c.confidence,
    rawSnippet: c.snippet,
    source: 'calendar',
    url: null,
    ...partial,
  };
}

describe('deduplicateDateEvents', () => {
  it('prefers a real due phrase over a noun-only DUE in the same entity group', () => {
    const out = deduplicateDateEvents([
      ev({ title: 'Assignment 1', datetime: '2026-11-10T00:00:00Z', assignmentId: 7, entityType: 'D2L.LE.Dropbox.Dropbox' }),
      ev({ title: 'Assignment 1 - Due', datetime: '2026-11-20T00:00:00Z', assignmentId: 7, entityType: 'D2L.LE.Dropbox.Dropbox' }),
      ev({ title: 'Assignment 1 - Availability Starts', datetime: '2026-11-01T00:00:00Z', assignmentId: 7, entityType: 'D2L.LE.Dropbox.Dropbox' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Assignment 1 - Due');
  });

  it('treats a Dropbox folder\'s only CLOSES date as its deadline', () => {
    const DB = 'D2L.LE.Dropbox.Dropbox';
    const single = deduplicateDateEvents([
      ev({ title: 'Assignment 2 – Availability Ends', assignmentId: 8, entityType: DB }),
    ]);
    expect(single[0].dateType).toBe(DateType.DUE);
    const pair = deduplicateDateEvents([
      ev({ title: 'Assignment 2 – Availability Starts', datetime: '2026-11-01T00:00:00Z', assignmentId: 8, entityType: DB }),
      ev({ title: 'Assignment 2 – Availability Ends', datetime: '2026-11-21T00:00:00Z', assignmentId: 8, entityType: DB }),
    ]);
    expect(pair).toHaveLength(1);
    expect(pair[0].title).toBe('Assignment 2 – Availability Ends');
    expect(pair[0].dateType).toBe(DateType.DUE);
    // Non-Dropbox entities keep CLOSES
    const quiz = deduplicateDateEvents([
      ev({ title: 'Quiz 1 - Availability Ends', assignmentId: 9, entityType: 'D2L.LE.Quizzing.Quiz' }),
    ]);
    expect(quiz[0].dateType).toBe(DateType.CLOSES);
  });

  it('does not merge a Dropbox and a Quiz that share a numeric id', () => {
    const out = deduplicateDateEvents([
      ev({ title: 'Assignment 5 - Due', assignmentId: 5, entityType: 'D2L.LE.Dropbox.Dropbox' }),
      ev({ title: 'Quiz 5 - Due', assignmentId: 5, entityType: 'D2L.LE.Quizzing.Quiz' }),
    ]);
    expect(out.map((e) => e.title).sort()).toEqual(['Assignment 5 - Due', 'Quiz 5 - Due']);
  });
});
