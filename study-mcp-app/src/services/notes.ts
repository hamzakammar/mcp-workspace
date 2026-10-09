import { apiClient } from '../config/api';
import {
  PresignUploadRequest,
  PresignUploadResponse,
  ProcessNoteRequest,
  ProcessNoteResponse,
  Note,
} from '../types';

/** Map REST/PostgREST note row (snake_case) to app Note. */
export function mapNoteRowFromApi(row: Record<string, unknown>): Note {
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? 'Untitled'),
    courseId: (row.course_id as string) || (row.courseId as string | undefined),
    course_id: row.course_id as string | undefined,
    createdAt: (row.created_at as string) || (row.createdAt as string) || '',
    created_at: row.created_at as string | undefined,
    updatedAt: (row.updated_at as string) || (row.updatedAt as string) || '',
    updated_at: row.updated_at as string | undefined,
    pageCount: (row.page_count as number) ?? (row.pageCount as number | undefined),
    page_count: row.page_count as number | undefined,
    chunkCount: (row.chunk_count as number) ?? (row.chunkCount as number | undefined),
    status: row.status as string | undefined,
  };
}

export class NotesService {
  async presignUpload(data: PresignUploadRequest): Promise<PresignUploadResponse> {
    const response = (await apiClient.post(
      '/notes/presign-upload',
      data
    )) as { data: PresignUploadResponse };
    return response.data;
  }

  async processNote(data: ProcessNoteRequest): Promise<ProcessNoteResponse> {
    const response = (await apiClient.post(
      '/notes/process',
      data
    )) as { data: ProcessNoteResponse };
    return response.data;
  }

  async getNotes(courseId?: string): Promise<Note[]> {
    const params = courseId ? { courseId } : {};
    const response = (await apiClient.get('/notes', { params })) as {
      data: { notes: Record<string, unknown>[] };
    };
    const rows = response.data?.notes ?? [];
    return rows.map((row) => mapNoteRowFromApi(row));
  }

  async deleteNote(noteId: string): Promise<void> {
    await apiClient.delete(`/notes/${noteId}`);
  }

  async uploadFile(
    uploadUrl: string,
    fileUri: string,
    contentType: string
  ): Promise<void> {
    // Read file and upload to S3
    const response = await fetch(fileUri);
    const blob = await response.blob();

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: {
        'Content-Type': contentType,
      },
    });
    if (!uploadRes.ok) {
      throw new Error(`Upload failed (HTTP ${uploadRes.status})`);
    }
  }

  /**
   * Embed missing note sections
   * Triggers embedding generation for notes that haven't been embedded yet
   */
  async embedMissing(): Promise<{ status: string; message: string }> {
    const response = (await apiClient.post('/notes/embed-missing')) as {
      data: { status: string; message: string };
    };
    return response.data;
  }

  /**
   * Search notes using semantic search
   */
  async searchNotes(query: string, courseId?: string): Promise<any[]> {
    const params: Record<string, string> = { q: query };
    if (courseId) {
      params.courseId = courseId;
    }
    const response = (await apiClient.get('/search', { params })) as {
      data: { hits: any[] };
    };
    return response.data?.hits ?? [];
  }
}

export const notesService = new NotesService();
