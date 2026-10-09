import { supabase } from "../utils/supabase.js";

export interface SearchResult {
  id: string;
  noteId: string | null;
  courseId: string | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

const INSERT_BATCH_SIZE = 200;

/**
 * Upserts text chunks with their embedding vectors into the note_chunks table.
 */
export async function upsertChunks(
  userId: string,
  noteId: string | null,
  courseId: string | null,
  chunks: string[],
  embeddings: number[][],
  metadata: Record<string, unknown> = {}
): Promise<void> {
  if (chunks.length !== embeddings.length) {
    throw new Error(
      `chunks.length (${chunks.length}) must equal embeddings.length (${embeddings.length})`
    );
  }
  if (chunks.length === 0) return;

  const rows = chunks.map((content, idx) => ({
    user_id: userId,
    note_id: noteId,
    course_id: courseId,
    chunk_index: idx,
    content,
    embedding: embeddings[idx],
    metadata,
  }));

  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const { error } = await supabase.from("note_chunks").insert(batch);
    if (error) {
      throw new Error(
        `Failed to insert note_chunks batch (offset ${i}): ${error.message}`
      );
    }
  }
}

/**
 * Runs semantic (vector cosine) search against the note_chunks table
 * using the Supabase `semantic_search` RPC function.
 */
export async function semanticSearch(
  userId: string,
  queryEmbedding: number[],
  courseId?: string,
  limit = 10
): Promise<SearchResult[]> {
  const { data, error } = await supabase.rpc("semantic_search", {
    query_embedding: queryEmbedding,
    match_user_id: userId,
    match_course_id: courseId ?? null,
    match_count: limit,
    // text-embedding-3-small cosine similarities for genuinely relevant chunks sit
    // around 0.25–0.4, so 0.7 filtered out essentially everything.
    match_threshold: 0.3,
  });

  if (error) {
    throw new Error(`semantic_search RPC failed: ${error.message}`);
  }

  return (data ?? []).map((row: any) => ({
    id: row.id as string,
    noteId: row.note_id as string | null,
    courseId: row.course_id as string | null,
    chunkIndex: row.chunk_index as number,
    content: row.content as string,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    similarity: row.similarity as number,
  }));
}

/**
 * Deletes all chunks associated with a specific note (cleanup on re-ingest or deletion).
 */
export async function deleteNoteChunks(noteId: string): Promise<void> {
  const { error } = await supabase
    .from("note_chunks")
    .delete()
    .eq("note_id", noteId);

  if (error) {
    throw new Error(`Failed to delete note_chunks for noteId ${noteId}: ${error.message}`);
  }
}
