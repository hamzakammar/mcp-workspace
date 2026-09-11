import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const indexPath = path.join(repoRoot, 'src', 'index.ts');
const piazzaToolPath = path.join(repoRoot, 'src', 'tools', 'piazza.ts');

const indexSource = fs.readFileSync(indexPath, 'utf8');
const piazzaToolSource = fs.readFileSync(piazzaToolPath, 'utf8');

function extractRegisteredToolNames(source: string, registrarName: 'registerReadTool' | 'registerMutatingTool'): Set<string> {
  const names = new Set<string>();
  const regex = new RegExp(`${registrarName}\\(\\s*"([^"]+)"`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    names.add(match[1]);
  }
  return names;
}

const readOnlyToolNames = extractRegisteredToolNames(indexSource, 'registerReadTool');
const mutatingToolNames = extractRegisteredToolNames(indexSource, 'registerMutatingTool');

const expectedReadOnlyTools = [
  'get_assignments',
  'get_assignment',
  'get_assignment_submissions',
  'get_course_content',
  'get_course_topic',
  'get_course_modules',
  'get_course_module',
  'get_my_grades',
  'get_upcoming_due_dates',
  'get_announcements',
  'get_my_courses',
  'read_file',
  'tasks_list',
  'notes_search',
  'notes_suggest_for_item',
  'semantic_search_notes',
  'plan_week',
  'piazza_semantic_search',
  'piazza_suggest_for_item',
  'get_cached_outline',
  'get_quizzes',
  'get_assignment_rubric',
  'what_should_i_work_on',
  'what_should_i_work_on_global',
  'get_discussion_boards',
  'get_crowdmark_assignments',
  'get_crowdmark_feedback',
  'get_connection_guide',
  'get_horizon_status',
] as const;

const expectedMutatingTools = [
  'download_file',
  'delete_file',
  'tasks_complete',
  'notes_sync',
  'notes_embed_missing',
  'sync_all',
  'tasks_add',
  'piazza_sync',
  'piazza_embed_missing',
  'get_course_outline',
  'get_my_course_outlines',
  'connect_crowdmark',
  'connect_outline',
  'connect_piazza',
  'connect_notion',
  'sync_to_notion',
  'delete_my_data',
] as const;

describe('MCP tool annotations', () => {
  it('registers known read-only tools with readOnlyHint: true', () => {
    for (const toolName of expectedReadOnlyTools) {
      expect(readOnlyToolNames.has(toolName)).toBe(true);
    }
  });

  it('never registers known mutating tools as read-only', () => {
    for (const toolName of expectedMutatingTools) {
      expect(mutatingToolNames.has(toolName)).toBe(true);
      expect(readOnlyToolNames.has(toolName)).toBe(false);
    }
  });

  it('registers all legacy piazza get/search tools as read-only', () => {
    const piazzaToolNames = Array.from(
      piazzaToolSource.matchAll(/name:\s*"([^"]+)"/g),
      (match) => match[1]
    );

    expect(piazzaToolNames).toEqual([
      'piazza_get_classes',
      'piazza_get_posts',
      'piazza_get_post',
      'piazza_search',
    ]);

    expect(indexSource).toMatch(
      /registerReadTool\(\s*tool\.name,\s*tool\.description,\s*schema\.shape,\s*wrapToolHandler\(tool\.name,\s*tool\.handler\)\s*\)/m
    );
  });
});
