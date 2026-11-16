import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/client.js', () => ({
  client: { getDropboxFolder: vi.fn(), getRubrics: vi.fn() },
}));

import { client } from '../../src/client.js';
import { rubricTools, flattenRubrics, type RawRubric } from '../../src/tools/rubric.js';

const c = vi.mocked(client);
const rubric: RawRubric = {
  RubricId: 1,
  Name: 'A1 Rubric',
  CriteriaGroups: [{
    Name: 'Main',
    Levels: [{ Id: 1, Name: 'Excellent', Points: 4 }, { Id: 2, Name: 'Poor', Points: 1 }],
    Criteria: [{ Id: 10, Name: 'Correctness', Cells: [
      { Description: { Text: 'All correct' }, Points: 10 },
      { Description: { Text: 'Mostly wrong' }, Points: 2 },
    ] }],
  }],
};

beforeEach(() => {
  c.getDropboxFolder.mockReset();
  c.getRubrics.mockReset();
});

describe('flattenRubrics', () => {
  it('walks CriteriaGroups → Criteria → Cells aligned with Levels', () => {
    const out = flattenRubrics([rubric]);
    expect(out).toEqual([{
      rubric: 'A1 Rubric',
      group: 'Main',
      name: 'Correctness',
      description: '',
      maxPoints: 10,
      levels: [
        { name: 'Excellent', points: 10, description: 'All correct' },
        { name: 'Poor', points: 2, description: 'Mostly wrong' },
      ],
    }]);
  });
});

describe('get_assignment_rubric', () => {
  const folder = { Id: 5, Name: 'A1', CustomInstructions: null, DueDate: null };

  it('prefers folder.Assessment.Rubrics', async () => {
    c.getDropboxFolder.mockResolvedValue({ ...folder, Assessment: { ScoreDenominator: 10, Rubrics: [rubric] } });
    const out = JSON.parse(await rubricTools.get_assignment_rubric.handler({ orgUnitId: 9, folderId: 5 }));
    expect(out.rubricCriteria).toHaveLength(1);
    expect(c.getRubrics).not.toHaveBeenCalled();
  });

  it('falls back to rubrics?objectType=Dropbox&objectId=folderId', async () => {
    c.getDropboxFolder.mockResolvedValue({ ...folder, Assessment: { ScoreDenominator: 10, Rubrics: [] } });
    c.getRubrics.mockResolvedValue([rubric]);
    const out = JSON.parse(await rubricTools.get_assignment_rubric.handler({ orgUnitId: 9, folderId: 5 }));
    expect(c.getRubrics).toHaveBeenCalledWith(9, 'Dropbox', 5);
    expect(out.rubricCriteria[0].name).toBe('Correctness');
  });

  it('returns an explicit note when the rubric lookup fails', async () => {
    c.getDropboxFolder.mockResolvedValue({ ...folder, Assessment: null });
    c.getRubrics.mockRejectedValue(new Error('D2L API error 403: forbidden'));
    const out = JSON.parse(await rubricTools.get_assignment_rubric.handler({ orgUnitId: 9, folderId: 5 }));
    expect(out.rubricCriteria).toEqual([]);
    expect(out.rubricNote).toMatch(/Could not load rubric.*403/);
  });
});
