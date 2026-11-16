import { supabase } from "../../utils/supabase.js";
import { D2LClient } from '../../client.js';
import { marshalAssignments, RawAssignment } from '../../utils/marshal.js';

interface Enrollment {
  OrgUnit: {
    Id: number;
    Type: {
      Code: string;
      Name: string;
    };
    Name: string;
  };
  Access: {
    IsActive: boolean;
    CanAccess: boolean;
  };
}

export const SyncTools = {
  sync_all: {
    description: `Sync all assignments from all enrolled courses on Learn and add them as tasks in the database`,
    schema: {},
    handler: async ({ userId }: { userId: string }) => {
      try {
        console.log('[SYNC] Starting sync_all for user:', userId);
        
        // Create D2L client with userId (needed for auth)
        const client = new D2LClient(userId);
        
        // Get all enrollments
        const enrollmentsResponse = await client.getMyEnrollments() as { Items: Enrollment[] };
        console.log('[SYNC] Found enrollments:', enrollmentsResponse.Items.length);
        
        // Filter for active courses only
        const courses = enrollmentsResponse.Items.filter(
          (enrollment) =>
            enrollment.OrgUnit.Type.Code === "Course Offering" &&
            enrollment.Access.IsActive &&
            enrollment.Access.CanAccess
        );
        console.log('[SYNC] Active courses:', courses.length);

        let totalAssignments = 0;
        let totalAdded = 0;
        let totalUpdated = 0;
        const results: Array<{ course: string; assignments: number; added: number; updated: number }> = [];

        // For each course, get assignments and add to database
        for (const course of courses) {
          const orgUnitId = course.OrgUnit.Id;
          const courseName = course.OrgUnit.Name;
          console.log(`[SYNC] Processing course: ${courseName} (${orgUnitId})`);

          try {
            // Get assignments for this course
            const folders = await client.getDropboxFolders(orgUnitId) as RawAssignment[];
            const assignments = marshalAssignments(folders);
            console.log(`[SYNC] Found ${assignments.length} assignments in ${courseName}`);
            totalAssignments += assignments.length;

            // Add each assignment to database
            let addedCount = 0;
            let updatedCount = 0;
            for (const assignment of assignments) {
              console.log(`[SYNC] Processing assignment: ${assignment.name}, dueDate: ${assignment.dueDate}`);
              
              if (assignment.dueDate) {
                // Use assignment ID as source_ref (unique identifier from D2L)
                const sourceRef = `${orgUnitId}-${assignment.id}`;
                // Prefer the raw ISO timestamp; `dueDate` is a human-formatted display string.
                const dueAt = assignment.dueDateIso ?? assignment.dueDate;
                
                // Check if already exists by user_id + source_ref
                const { data: existing, error: selectError } = await supabase
                  .from('tasks')
                  .select('id, title, due_at')
                  .eq('user_id', userId)
                  .eq('source_ref', sourceRef)
                  .maybeSingle();

                console.log(`[SYNC] Existing check - found: ${!!existing}, error: ${selectError?.message}`);

                if (existing && !selectError) {
                  // Propagate D2L title / due-date changes. Never touch status
                  // (the user may have completed the task).
                  const changes: Record<string, string> = {};
                  if (existing.title !== assignment.name) changes.title = assignment.name;
                  const existingDue = existing.due_at ? Date.parse(existing.due_at) : NaN;
                  const newDue = Date.parse(dueAt);
                  if (existingDue !== newDue && !(Number.isNaN(existingDue) && Number.isNaN(newDue))) {
                    changes.due_at = dueAt;
                  }
                  if (Object.keys(changes).length > 0) {
                    const { data: updatedRows, error: updateError } = await supabase
                      .from('tasks')
                      .update(changes)
                      .eq('user_id', userId)
                      .eq('source_ref', sourceRef)
                      .select('id');
                    if (updateError) {
                      console.error(`[SYNC] Update error:`, updateError);
                    } else if (!updatedRows || updatedRows.length === 0) {
                      console.log(`[SYNC] Update matched no rows for ${sourceRef}`);
                    } else {
                      console.log(`[SYNC] Updated task ${sourceRef}: ${Object.keys(changes).join(', ')}`);
                      updatedCount++;
                      totalUpdated++;
                    }
                  }
                } else if (!existing && !selectError) {
                  console.log(`[SYNC] Inserting new task: ${assignment.name} (source_ref: ${sourceRef})`);
                  const courseId = String(orgUnitId);

                  // Insert new task (schema: user_id, title, course_id, source, source_ref, due_at, status)
                  const { data, error } = await supabase
                    .from('tasks')
                    .insert({
                      user_id: userId,
                      title: assignment.name,
                      course_id: courseId,
                      source: `d2l-${orgUnitId}`,
                      source_ref: sourceRef,
                      due_at: dueAt,
                      status: 'open',
                    })
                    .select();

                  if (error) {
                    console.error(`[SYNC] Insert error:`, error);
                  } else {
                    console.log(`[SYNC] Successfully inserted:`, data);
                    addedCount++;
                    totalAdded++;
                  }
                }
              } else {
                console.log(`[SYNC] Skipping assignment ${assignment.name} - no due date`);
              }
            }

            results.push({
              course: courseName,
              assignments: assignments.length,
              added: addedCount,
              updated: updatedCount,
            });
          } catch (error) {
            console.error(`[SYNC] Error syncing course ${courseName}:`, error);
            results.push({
              course: courseName,
              assignments: 0,
              added: 0,
              updated: 0,
            });
          }
        }

        return JSON.stringify({
          success: true,
          totalCourses: courses.length,
          totalAssignments,
          totalAdded,
          totalUpdated,
          results,
        }, null, 2);
      } catch (error) {
        console.error('[SYNC] Fatal error:', error);
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2);
      }
    },
  },
};