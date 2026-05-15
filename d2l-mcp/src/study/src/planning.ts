import { z } from "zod";
import { supabase } from "../../utils/supabase.js";
import { NotesTools } from "./notes.js";

export const PlanningTools = {
    tasks_list: {
        description: `Retrieve a list of tasks for a specified course. Returns task title, due date, status (completed/pending), and priority. Use to answer: "What tasks do I have for this course?", "What are my upcoming deadlines?", "Which tasks are high priority?"`,
        schema: {
            taskTitle: z.string().optional().describe("Filter by task title"),
            status: z.enum(["completed", "pending"]).optional().describe("Filter by task status"),
            source: z.string().optional().describe("Filter by task source"),
            dueBefore: z.string().optional().describe("Filter tasks due before this date (ISO 8601 format)"),
        },
        handler: async (args: { taskTitle?: string; status?: "completed" | "pending"; source?: string; dueBefore?: string; userId: string }): Promise<string> => {
            const taskTitle = args.taskTitle;
            const status = args.status;
            const source = args.source;
            const dueBefore = args.dueBefore;
            const userId = args.userId;

            try {
                let query = supabase
                    .from('tasks')
                    .select('*')
                    .eq('user_id', userId);

                if (taskTitle) {
                    query = query.ilike('title', `%${taskTitle}%`);
                }

                if (status) {
                    const s = status === 'completed' ? 'done' : 'open';
                    query = query.eq('status', s);
                }

                if (source) {
                    query = query.eq('source', source);
                }

                if (dueBefore) {
                    query = query.lte('due_at', dueBefore);
                }

                // Order by due date
                query = query.order('due_at', { ascending: true });

                const { data: tasks, error } = await query;
                
                if (error) {
                    console.error('[TASKS_LIST] Supabase error:', JSON.stringify(error, null, 2));
                    return `Error fetching tasks: ${error.message || JSON.stringify(error, null, 2)}`;
                }
                
                if (!tasks || tasks.length === 0) {
                    return JSON.stringify({ message: "No tasks found", tasks: [] }, null, 2);
                }
                
                return JSON.stringify(tasks, null, 2);
            } catch (error) {
                console.error('[TASKS_LIST] Exception:', error);
                if (error instanceof Error) {
                    return `Error fetching tasks: ${error.message}\nStack: ${error.stack}`;
                }
                return `Error fetching tasks: ${JSON.stringify(error, null, 2)}`;
            }
        }
    },
    tasks_add: {
        description: `Add a new task manually. Use to answer: "Add a task for X", "Create a task called Y due on Z"`,
        schema: {
            taskTitle: z.string().describe("The title of the task"),
            courseId: z.string().describe("The course ID this task belongs to (e.g., MATH119, ECE140)"),
            dueAt: z.string().describe("Due date in ISO 8601 format (e.g., 2026-01-20T23:59:59Z)"),
            source: z.string().optional().describe("Source of the task (e.g., 'manual', 'piazza', 'd2l')"),
            description: z.string().optional().describe("Optional description or details about the task"),
        },
        handler: async (args: { taskTitle: string; courseId: string; dueAt: string; source?: string; description?: string; userId: string }): Promise<string> => {
            const { taskTitle, courseId, dueAt, source = 'manual', description, userId } = args;

            try {
                const { data, error } = await supabase
                    .from('tasks')
                    .insert({
                        user_id: userId,
                        title: taskTitle,
                        course_id: courseId,
                        due_at: dueAt,
                        source,
                        source_ref: `${source}:${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                        status: 'open',
                        description: description ?? null,
                    })
                    .select();
                
                if (error) {
                    console.error('[TASKS_ADD] Supabase error:', JSON.stringify(error, null, 2));
                    return `Error adding task: ${error.message || JSON.stringify(error, null, 2)}`;
                }
                
                return JSON.stringify({ success: true, task: data[0] }, null, 2);
            } catch (error) {
                console.error('[TASKS_ADD] Exception:', error);
                if (error instanceof Error) {
                    return `Error adding task: ${error.message}\nStack: ${error.stack}`;
                }
                return `Error adding task: ${JSON.stringify(error, null, 2)}`;
            }
        }
    },
    tasks_complete: {
        description: `Mark a specified task as completed. Use to answer: "Mark task X as completed."`,
        schema: {
            taskId: z.string().describe("The unique identifier of the task to mark as completed"),
            taskName: z.string().optional().describe("The name of the task to mark as completed"),
        },
        handler: async (args: { taskId: string; taskName?: string; userId: string }): Promise<string> => {
            const { taskId, taskName, userId } = args;

            try {
                const { error } = await supabase
                    .from('tasks')
                    .update({ status: 'done' })
                    .eq('id', taskId)
                    .eq('user_id', userId);

                if (error) throw error;

                return `Task ${taskName ? `"${taskName}" ` : ''}with ID ${taskId} marked as completed.`;
            } catch (error) {
                return `Error marking task as completed: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
    },
    plan_week: {
        description: `Generate a weekly study plan based on upcoming tasks and deadlines. Use to answer: "Create a study plan for the week."`,
        schema: {
            windowDays: z.number().optional().describe("Number of days to plan for, default is 7"),
            courseId: z.string().optional().describe("Filter tasks by course ID"),
            includeNotes: z.boolean().optional().describe("Whether to include notes in the plan, default is true"),
        },
        handler: async (args: { windowDays?: number; courseId?: string; includeNotes?: boolean; userId: string }): Promise<string> => {
            const windowDays = args.windowDays ?? 7;
            const courseId = args.courseId;
            const includeNotes = args.includeNotes ?? true;
            const userId = args.userId;

            try {
                let query = supabase
                    .from('tasks')
                    .select('*')
                    .eq('user_id', userId)
                    .gte('due_at', new Date().toISOString())
                    .lte('due_at', new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000).toISOString())
                    .eq('status', 'open');

                if (courseId) {
                    query = query.eq('course_id', courseId);
                }

                const { data: tasks, error } = await query.order('due_at', { ascending: true });
                
                if (error) {
                    console.error('[PLAN_WEEK] Supabase error:', JSON.stringify(error, null, 2));
                    return `Error generating study plan: ${error.message || JSON.stringify(error, null, 2)}`;
                }
                
                if (!tasks || tasks.length === 0) {
                    return JSON.stringify({ overdue: [], due_soon: [], this_week: [] }, null, 2);
                }

                const now = new Date();
                const in72h = new Date(now.getTime() + 72 * 60 * 60 * 1000);
                const endWindow = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

                // Bucket tasks by time
                const overdue: any[] = [];
                const due_soon: any[] = [];
                const this_week: any[] = [];

                for (const task of tasks) {
                    const dueDate = new Date(task.due_at);
                    const taskObj = {
                        id: task.id,
                        title: task.title,
                        dueDate: task.due_at,
                        courseId: task.course_id,
                    };

                    if (dueDate < now) {
                        overdue.push(taskObj);
                    } else if (dueDate <= in72h) {
                        due_soon.push(taskObj);
                    } else if (dueDate <= endWindow) {
                        this_week.push(taskObj);
                    }
                }

                // Enrich due_soon tasks with notes if requested
                if (includeNotes && due_soon.length > 0) {
                    const enrichedDueSoon = [];
                    for (const task of due_soon) {
                        const notesResult = await NotesTools.notes_suggest_for_item.handler({
                            courseId: task.courseId,
                            title: task.title,
                            description: undefined,
                            userId,
                        });
                        const notes = JSON.parse(notesResult);
                        enrichedDueSoon.push({
                            task,
                            notes
                        });
                    }
                    return JSON.stringify({ overdue, due_soon: enrichedDueSoon, this_week }, null, 2);
                }

                return JSON.stringify({ overdue, due_soon, this_week }, null, 2);

            } catch (error) {
                console.error('[PLAN_WEEK] Exception:', error);
                if (error instanceof Error) {
                    return `Error generating study plan: ${error.message}\nStack: ${error.stack}`;
                }
                return `Error generating study plan: ${JSON.stringify(error, null, 2)}`;
            }
        }
    }
};