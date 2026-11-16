import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { z } from "zod";
import { chunkText as ragChunkText, embedChunks } from "../../rag/embeddings.js";
import { upsertChunks, deleteNoteChunks } from "../../rag/vectorStore.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text?: string; numpages?: number }>;
import { OpenAI } from "openai";
import { supabase } from "../../utils/supabase.js";
import notesMap from "../db/notes_map.json" with { type: "json" };

type NotesMap = Record<string, string[]>;

const CHUNK_SIZE = 2500;
const CHUNK_OVERLAP = 250;
const PREVIEW_LENGTH = 200;
const INSERT_BATCH_SIZE = 500;

function normalizeWhitespace(text: string): string {
	if (!text || typeof text !== 'string') {
		return '';
	}
	const cleanText = text
		.replace(/\\u[\dA-Fa-f]{4}/g, '') // Remove unicode escapes
		.replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control chars
		.replace(/\r/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return cleanText;
}

function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
	if (text.length === 0) return [];
	const chunks: string[] = [];
	let start = 0;

	while (start < text.length) {
		const end = Math.min(start + size, text.length);
		const chunk = text.slice(start, end).trim();
		if (chunk.length > 0) {
			chunks.push(chunk);
		}

		if (end === text.length) break;
		start = Math.max(end - overlap, start + 1);
	}

	return chunks;
}

function slugifyPdfName(pdfName: string): string {
	const withoutExt = pdfName.replace(/\.[^.]+$/, "");
	const slug = withoutExt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "pdf";
}

function resolvePdfPath(entry: string, repoPath?: string): { absolutePath: string; relativePath: string | null } {
	if (path.isAbsolute(entry)) {
		return { absolutePath: entry, relativePath: repoPath ? path.relative(repoPath, entry) : null };
	}

	const base = repoPath ? repoPath : homedir();
	const absolutePath = path.resolve(base, entry);
	const relativePath = repoPath ? path.relative(repoPath, absolutePath) : entry;

	return { absolutePath, relativePath };
}

function buildUrl(absolutePath: string, relativePath: string | null, webBase?: string): string {
	if (webBase && relativePath) {
		const normalizedBase = webBase.endsWith("/") ? webBase : `${webBase}/`;
		return `${normalizedBase}${relativePath.replace(/\\/g, "/")}`;
	}
	return absolutePath;
}

async function parsePdfBuffer(buffer: Buffer, logLabel = "PDF"): Promise<{ text: string; pageCount: number }> {
	try {
		const data = await pdfParse(buffer);
		const text = (data?.text || "") as string;
		const pageCount = typeof data?.numpages === "number" ? data.numpages : 0;
		console.error(`[${logLabel}] Extracted ${text.length} chars, ${pageCount} pages`);
		return { text: normalizeWhitespace(text), pageCount };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error(`[${logLabel}] PDF parse error:`, errorMsg);
		throw new Error(`Failed to parse PDF: ${errorMsg}. The file may be corrupted, encrypted, or in an unsupported format.`);
	}
}

async function parsePdfText(filePath: string): Promise<string> {
	const buffer = await fs.readFile(filePath);
	const { text } = await parsePdfBuffer(buffer, "PDF");
	if (!text) {
		console.error(`[PDF] Warning: No text extracted from ${filePath}`);
	}
	return text;
}

async function insertNoteSections(rows: Array<Record<string, string>>): Promise<void> {
	for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
		const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
		const { error } = await supabase.from("note_sections").insert(batch);
		if (error) {
			throw new Error(`Failed to insert note_sections batch: ${error.message}`);
		}
	}
}

export async function generateEmbedding(text: string): Promise<number[]> {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_API_KEY environment variable is not set");
	}

	const openai = new OpenAI({ apiKey });
	const response = await openai.embeddings.create({
		model: "text-embedding-3-small",
		input: text,
	});

	return response.data[0].embedding;
}

/** Count non-overlapping literal occurrences of `needle` in `haystack` (no regex, so query text can't throw or ReDoS). */
function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

export function calculateLexicalScore(section: any, queryWords: string[]): number {
	let score = 0;

	// +10 if word appears in title
	for (const word of queryWords) {
		if (section.title && section.title.toLowerCase().includes(word)) {
			score += 10;
		}
	}

	// Search in content or preview
	const searchText = section.content || section.preview || "";
	const firstChars = searchText.slice(0, 300);

	// +2 per occurrence in text, +5 bonus if in first 300 chars
	for (const word of queryWords) {
		const textLower = searchText.toLowerCase();
		const matches = countOccurrences(textLower, word);
		score += matches * 2;

		if (firstChars.toLowerCase().includes(word)) {
			score += 5;
		}
	}

	return score;
}

export interface IngestPdfOptions {
	courseId?: string;
	title?: string;
	noteId: string;
	url?: string;
}

/** Ingest PDF buffer into note_sections (e.g. from S3). Returns chunkCount and pageCount. */
export async function ingestPdfBuffer(
	userId: string,
	buffer: Buffer,
	opts: IngestPdfOptions
): Promise<{ chunkCount: number; pageCount: number }> {
	if (!userId || typeof userId !== 'string') {
		throw new Error("userId is required and must be a string");
	}
	if (!buffer || !Buffer.isBuffer(buffer)) {
		throw new Error("buffer is required and must be a Buffer");
	}
	if (!opts.noteId) {
		throw new Error("noteId is required in opts");
	}
	
	const { courseId = "default", title = "Untitled PDF", noteId, url = "" } = opts;
	console.error(`[INGEST] Starting PDF parse for noteId: ${noteId}, title: ${title}, buffer size: ${buffer.length}`);
	
	const { text, pageCount } = await parsePdfBuffer(buffer, "INGEST");
	console.error(`[INGEST] PDF parsed: ${text.length} chars, ${pageCount} pages`);
	
	const chunks = chunkText(text);
	console.error(`[INGEST] Text chunked into ${chunks.length} chunks`);
	
	const slug = slugifyPdfName(title);
	const rows: Array<Record<string, unknown>> = [];
	chunks.forEach((chunk, idx) => {
		const anchor = `${noteId}-${slug}-chunk-${idx + 1}`;
		if (!anchor || anchor.length === 0) {
			throw new Error(`Invalid anchor generated for chunk ${idx + 1}`);
		}
		// Ensure note_id is a valid UUID string (not undefined/null)
		if (!noteId || typeof noteId !== 'string') {
			throw new Error(`Invalid noteId: ${noteId}. Must be a valid UUID string.`);
		}
		rows.push({
			user_id: userId,
			note_id: noteId, // UUID from notes table
			course_id: courseId,
			title: `${title} — Chunk ${idx + 1}`,
			anchor: anchor,
			url: url || `s3://${process.env.S3_BUCKET || 'unknown'}/${opts.url || ''}`,
			preview: chunk.slice(0, PREVIEW_LENGTH) || '',
			content: chunk || '',
		});
	});
	
	if (rows.length === 0) {
		console.error("[INGEST] No chunks generated from PDF");
		return { chunkCount: 0, pageCount };
	}
	console.error(`[INGEST] Prepared ${rows.length} rows for database insert`);

	for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
		const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
		console.error(`[INGEST] Inserting batch ${i / INSERT_BATCH_SIZE + 1}, rows: ${batch.length}`);
		
		// Validate batch data before insert
		for (const row of batch) {
			if (!row.user_id || !row.course_id || !row.anchor || !row.title || !row.url) {
				throw new Error(`Invalid row data: missing required fields. Row: ${JSON.stringify(row)}`);
			}
		}
		
		// For app uploads, each note_id/anchor set is new; use insert to avoid
		// requiring a specific ON CONFLICT unique constraint in every deployment.
		const { error } = await supabase.from("note_sections").insert(batch);
		
		if (error) {
			console.error(`[INGEST] Supabase error:`, error);
			console.error(`[INGEST] Error details:`, JSON.stringify(error, null, 2));
			console.error(`[INGEST] Batch sample:`, JSON.stringify(batch[0], null, 2));
			throw new Error(`ingest upsert failed: ${error.message}. Code: ${error.code}, Details: ${error.details || 'none'}`);
		}
		console.error(`[INGEST] Batch ${i / INSERT_BATCH_SIZE + 1} inserted successfully`);
	}

	// --- RAG: embed chunks into note_chunks for semantic search ---
	try {
		console.error(`[INGEST] Embedding ${chunks.length} chunks into note_chunks...`);
		// Delete any previously stored chunks for this note to avoid duplicates
		await deleteNoteChunks(noteId, userId);
		// Use smaller RAG chunk size (500 chars) for better semantic precision
		const ragChunks = ragChunkText(text, 500, 50);
		const embeddings = await embedChunks(ragChunks);
		await upsertChunks(userId, noteId, courseId, ragChunks, embeddings, {
			title,
			source: url || `s3://${process.env.S3_BUCKET || 'unknown'}/${opts.url || ''}`,
		});
		console.error(`[INGEST] Successfully embedded ${ragChunks.length} RAG chunks for noteId: ${noteId}`);
	} catch (ragError) {
		// RAG errors are non-fatal — existing note_sections ingest succeeded
		console.error(`[INGEST] RAG embedding failed (non-fatal):`, ragError instanceof Error ? ragError.message : String(ragError));
	}

	return { chunkCount: rows.length, pageCount };
}

/** Embed note_sections for a given note_id. Used after ingest for app uploads. */
export async function embedNoteSections(userId: string, noteId: string, minChars = 200): Promise<number> {
	const { data: rows, error } = await supabase
		.from("note_sections")
		.select("id, content, preview")
		.eq("user_id", userId)
		.eq("note_id", noteId)
		.is("embedding", null);

	if (error) throw new Error(`embed fetch failed: ${error.message}`);
	if (!rows?.length) return 0;

	let embedded = 0;
	for (const row of rows) {
		const text = (row.content || row.preview || "") as string;
		if (text.length < minChars) continue;
		try {
			const embedding = await generateEmbedding(text);
			const { error: upErr } = await supabase
				.from("note_sections")
				.update({ embedding })
				.eq("id", row.id);
			if (!upErr) embedded++;
		} catch (e) {
			console.error(`[EMBED] Failed section ${row.id}:`, e);
		}
	}
	return embedded;
}

export const NotesTools = {
	notes_sync: {
		description:
			"Extract PDFs into note_sections (text chunks). For each course PDF: extract text, lightly clean whitespace, chunk into 2500-char segments with 250-char overlap, and upsert rows in Supabase.",
		schema: {
			courseId: z.string().optional().describe("Limit sync to a specific course ID (e.g., MATH119)."),
		},
		handler: async ({ courseId, userId }: { courseId?: string; userId: string }): Promise<string> => {
			const map = notesMap as NotesMap;
			const selectedCourses = courseId
				? { [courseId]: map[courseId] }
				: map;

			if (courseId && !map[courseId]) {
				return JSON.stringify({ success: false, error: `Course ${courseId} not found in notes_map.json` }, null, 2);
			}

			const repoPath = process.env.NOTES_REPO_PATH ? path.resolve(process.env.NOTES_REPO_PATH) : undefined;
			const repoWebBase = process.env.NOTES_REPO_WEB_BASE;

			let totalCourses = 0;
			let totalPdfs = 0;
			let totalChunks = 0;
			const courseResults: Array<Record<string, unknown>> = [];

			for (const [course, pdfEntries] of Object.entries(selectedCourses)) {
				if (!pdfEntries || pdfEntries.length === 0) {
					courseResults.push({ course, pdfs: 0, chunks: 0, status: "skipped", reason: "No PDFs listed" });
					continue;
				}

				totalCourses += 1;
				let processedPdfCount = 0;
				let courseChunkCount = 0;
				const rows: Array<Record<string, string>> = [];

				for (const entry of pdfEntries) {
					try {
						const { absolutePath, relativePath } = resolvePdfPath(entry, repoPath);
						
						// Check if file exists before attempting to parse
						if (!fsSync.existsSync(absolutePath)) {
							courseResults.push({
								course,
								pdf: entry,
								status: "error",
								error: `File not found: ${absolutePath}`,
							});
							continue;
						}
						
						const pdfName = path.basename(absolutePath);
						const pdfSlug = slugifyPdfName(pdfName);
						const url = buildUrl(absolutePath, relativePath, repoWebBase);
						const text = await parsePdfText(absolutePath);
						const chunks = chunkText(text);

						chunks.forEach((chunk, idx) => {
							rows.push({
								user_id: userId,
								course_id: course,
								title: `${pdfName} — Chunk ${idx + 1}`,
								anchor: `${pdfSlug}-chunk-${idx + 1}`,
								url,
								preview: chunk.slice(0, PREVIEW_LENGTH),
								content: chunk,
							});
						});

						processedPdfCount += 1;
						courseChunkCount += chunks.length;
					} catch (error) {
						courseResults.push({
							course,
							pdf: entry,
							status: "error",
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}

				if (rows.length > 0) {
					// Use upsert instead of delete+insert to preserve embeddings for unchanged chunks
					// Unique constraint: (user_id, course_id, anchor)
					for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
						const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
						console.error(`[SYNC] Upserting batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1}/${Math.ceil(rows.length / INSERT_BATCH_SIZE)} for ${course} (${batch.length} rows)`);
						const { error: upsertError } = await supabase
							.from("note_sections")
							.upsert(batch, {
								onConflict: "user_id,course_id,anchor",
								ignoreDuplicates: false,
							});

						if (upsertError) {
							console.error(`[SYNC] Upsert error for ${course}:`, upsertError);
							return JSON.stringify({ success: false, error: upsertError.message }, null, 2);
						}
					}

					// Delete any chunks that are no longer in the PDFs (e.g., if PDFs were removed or shortened)
					// TODO: Implement proper cleanup that handles large anchor lists
					// const currentAnchors = rows.map((r) => r.anchor);
					// if (currentAnchors.length > 0) {
					// 	const { error: cleanupError } = await supabase
					// 		.from("note_sections")
					// 		.delete()
					// 		.eq("course_id", course)
					// 		.not("anchor", "in", `(${currentAnchors.map((a) => `'${a.replace(/'/g, "''")}'`).join(",")})`);
					// 	if (cleanupError) {
					// 		console.error(`[SYNC] Cleanup error for ${course}:`, cleanupError);
					// 	}
					// }

					totalPdfs += processedPdfCount;
					totalChunks += courseChunkCount;
					courseResults.push({ course, pdfs: processedPdfCount, chunks: courseChunkCount, status: "synced" });
				} else {
					courseResults.push({ course, pdfs: processedPdfCount, chunks: courseChunkCount, status: "skipped", reason: "No rows generated" });
				}
			}

			return JSON.stringify(
				{
					success: true,
					courses: totalCourses,
					pdfs: totalPdfs,
					chunks: totalChunks,
					details: courseResults,
				},
				null,
				2
			);
		},
	},
	notes_search: {
		description:
			"Search note sections for a course by query. Supports lexical (keyword), vector (semantic), or hybrid (both) modes. Hybrid mode uses vector search for candidates + lexical scoring for reranking.",
		schema: {
			courseId: z.string().describe("The course ID to search in (e.g., MATH119)."),
			query: z.string().describe("The search query (e.g., 'integration by parts')."),
			topK: z.number().optional().describe("Number of top results to return. Defaults to 5."),
			mode: z.enum(["lexical", "vector", "hybrid"]).optional().describe("Search mode: lexical (keyword), vector (semantic), or hybrid (both). Defaults to hybrid."),
		},
		handler: async ({ courseId, query, topK = 5, mode = "hybrid", userId }: { courseId: string; query: string; topK?: number; mode?: "lexical" | "vector" | "hybrid"; userId: string }): Promise<string> => {
			if (!courseId || !query) {
				return JSON.stringify({ success: false, error: "Both courseId and query are required" }, null, 2);
			}

			try {
				const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);

				if (mode === "lexical") {
					// Lexical mode: fetch all sections and score with keywords
					const { data: sections, error } = await supabase
						.from("note_sections")
						.select("id, title, url, anchor, preview, content")
						.eq("user_id", userId)
						.eq("course_id", courseId);

					if (error) {
						return JSON.stringify({ success: false, error: error.message }, null, 2);
					}

					if (!sections || sections.length === 0) {
						return JSON.stringify({ success: true, results: [], message: "No sections found for this course" }, null, 2);
					}

					const scored = sections.map((section: any) => ({
						...section,
						score: calculateLexicalScore(section, queryWords),
					}));

					const topResults = scored
						.sort((a: any, b: any) => b.score - a.score)
						.slice(0, topK)
						.map(({ id, score, content, ...rest }: any) => rest);

					return JSON.stringify({ success: true, query, courseId, mode, count: topResults.length, results: topResults }, null, 2);
				} else if (mode === "vector") {
					// Vector mode: embed query and use RPC
					const queryEmbedding = await generateEmbedding(query);
					const { data: sections, error } = await supabase.rpc("match_note_sections", {
						query_embedding: queryEmbedding,
						match_count: topK,
						course_filter: courseId,
						user_filter: userId,
					});

					if (error) {
						return JSON.stringify({ success: false, error: error.message }, null, 2);
					}

					const results = (sections || []).map((s: any) => ({
						title: s.title,
						url: s.url,
						anchor: s.anchor,
						preview: s.preview,
						similarity: s.similarity,
					}));

					return JSON.stringify({ success: true, query, courseId, mode, count: results.length, results }, null, 2);
				} else {
					// Hybrid mode: vector candidates + lexical reranking
					const queryEmbedding = await generateEmbedding(query);
					const candidateCount = Math.max(topK * 6, 30);
					const { data: candidates, error } = await supabase.rpc("match_note_sections", {
						query_embedding: queryEmbedding,
						match_count: candidateCount,
						course_filter: courseId,
						user_filter: userId,
					});

					if (error) {
						return JSON.stringify({ success: false, error: error.message }, null, 2);
					}

					if (!candidates || candidates.length === 0) {
						return JSON.stringify({ success: true, results: [], message: "No matching sections found" }, null, 2);
					}

					const scored = candidates.map((section: any) => ({
						...section,
						combined_score: calculateLexicalScore(section, queryWords) * 10 + (section.similarity || 0),
					}));

					const topResults = scored
						.sort((a: any, b: any) => b.combined_score - a.combined_score)
						.slice(0, topK)
						.map(({ id, content, combined_score, similarity, ...rest }: any) => rest);

					return JSON.stringify({ success: true, query, courseId, mode, count: topResults.length, results: topResults }, null, 2);
				}
			} catch (error) {
				return JSON.stringify(
					{
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
					null,
					2
				);
			}
		},
	},
	notes_suggest_for_item: {
		description:
			"Suggest relevant note sections for an assignment, task, or item. Combines title and description into a search query and returns top 3 results.",
		schema: {
			courseId: z.string().describe("The course ID (e.g., MATH119)."),
			title: z.string().describe("The item title (e.g., 'Assignment: Calculus Integration')."),
			description: z.string().optional().describe("Optional item description to include in search."),
		},
		handler: async ({ courseId, title, description, userId }: { courseId: string; title: string; description?: string; userId: string }): Promise<string> => {
			if (!courseId || !title) {
				return JSON.stringify({ success: false, error: "Both courseId and title are required" }, null, 2);
			}

			// Combine title and description into a search query
			const query = description ? `${title} ${description}` : title;

			// Call notes_search with topK=3
			const searchHandler = NotesTools.notes_search.handler;
			return await searchHandler({ courseId, query, topK: 3, userId });
		},
	},
	notes_embed_missing: {
		description:
			"Generate embeddings for note_sections rows that are missing embeddings. Fetches rows with null embedding vectors, generates embeddings via OpenAI, and updates them in batches. Resumable and skips short chunks.",
		schema: {
			courseId: z.string().optional().describe("Optionally filter by course ID (e.g., MATH119)."),
			limit: z.number().optional().describe("Maximum rows to process in this batch. Defaults to 100."),
			minChars: z.number().optional().describe("Skip chunks shorter than this. Defaults to 200."),
		},
		handler: async ({ courseId, limit = 100, minChars = 200, userId }: { courseId?: string; limit?: number; minChars?: number; userId: string }): Promise<string> => {
			try {
				// Page through rows with null embeddings using an id cursor. Rows that are
				// skipped (too short / embed failure) keep a null embedding, so a plain
				// `.is(null).limit(n)` would re-select them forever and stall progress.
				const PAGE_SIZE = Math.max(limit, 100);
				const MAX_PAGES = 50;
				let lastId: string | null = null;
				let scanned = 0;
				let embedded = 0;
				let skipped = 0;
				const updates: Array<{ id: string; embedding: number[] }> = [];

				for (let page = 0; page < MAX_PAGES && updates.length < limit; page++) {
					let query = supabase
						.from("note_sections")
						.select("id, content, preview")
						.eq("user_id", userId)
						.is("embedding", null);

					if (courseId) {
						query = query.eq("course_id", courseId);
					}
					if (lastId !== null) {
						query = query.gt("id", lastId);
					}

					const { data: rows, error } = await query.order("id", { ascending: true }).limit(PAGE_SIZE);

					if (error) {
						return JSON.stringify({ success: false, error: error.message }, null, 2);
					}
					if (!rows || rows.length === 0) break;
					scanned += rows.length;

					for (const row of rows) {
						lastId = row.id;
						if (updates.length >= limit) break;
						const text = row.content || row.preview || "";

						// Skip if too short
						if (text.length < minChars) {
							skipped++;
							continue;
						}

						try {
							// Generate embedding
							const embedding = await generateEmbedding(text);
							updates.push({ id: row.id, embedding });
							embedded++;
							console.error(`[EMBED] Generated embedding for row ${row.id}`);
						} catch (embedError) {
							console.error(`[EMBED] Failed to embed row ${row.id}:`, embedError);
							skipped++;
						}
					}

					if (rows.length < PAGE_SIZE) break;
				}

				if (scanned === 0) {
					return JSON.stringify({
						success: true,
						embedded: 0,
						skipped: 0,
						remaining: 0,
						message: "No rows with missing embeddings found",
					}, null, 2);
				}

				// Batch update rows with embeddings
				if (updates.length > 0) {
					for (const update of updates) {
						const { error: updateError } = await supabase
							.from("note_sections")
							.update({ embedding: update.embedding })
							.eq("id", update.id)
							.eq("user_id", userId);

						if (updateError) {
							console.error(`[EMBED] Update error for row ${update.id}:`, updateError);
						}
					}
				}

				// Get count of remaining rows with null embeddings
				let remainingQuery = supabase
					.from("note_sections")
					.select("id", { count: "exact", head: true })
					.eq("user_id", userId)
					.is("embedding", null);

				if (courseId) {
					remainingQuery = remainingQuery.eq("course_id", courseId);
				}

				const { count: remaining } = await remainingQuery;

				return JSON.stringify(
					{
						success: true,
						embedded,
						skipped,
						remaining: remaining ?? 0,
						message: `Embedded ${embedded} rows, skipped ${skipped} (too short)`,
					},
					null,
					2
				);
			} catch (error) {
				return JSON.stringify(
					{
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
					null,
					2
				);
			}
		},
	},
};

