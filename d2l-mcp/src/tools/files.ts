import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getAuthenticatedContext, getD2LToken, getToken } from '../auth.js';
import { getUserId } from '../utils/userContext.js';
import mammoth from 'mammoth';

// Extract text content from various file types
async function extractContent(data: Buffer, ext: string): Promise<string | null> {
  const lowerExt = ext.toLowerCase();
  
  // Text-based files - return as string
  if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h'].includes(lowerExt)) {
    return data.toString('utf-8');
  }
  
  // Word documents - extract text with multiple fallback methods
  if (lowerExt === '.docx') {
    // Method 1: Try macOS textutil (most reliable on Mac)
    if (os.platform() === 'darwin') {
      try {
        // Write buffer to temp file
        const tempFile = path.join(os.tmpdir(), `docx-extract-${Date.now()}.docx`);
        fs.writeFileSync(tempFile, data);
        
        // Use textutil to convert to plain text
        const textOutput = execSync(`textutil -convert txt -stdout "${tempFile}"`, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        });
        
        // Clean up temp file
        try {
          fs.unlinkSync(tempFile);
        } catch (err) { console.error('[FILES] Operation failed:', err); }
        
        if (textOutput && textOutput.trim().length > 0) {
          console.error(`[DOCX] Successfully extracted text using macOS textutil`);
          return textOutput.trim();
        }
      } catch (textutilError: any) {
        console.error(`[DOCX] textutil failed: ${textutilError?.message || textutilError}`);
        // Continue to next method
      }
    }
    
    // Method 2: Try mammoth extractRawText
    try {
      const result = await mammoth.extractRawText({ buffer: data });
      if (result.value && result.value.trim().length > 0) {
        console.error(`[DOCX] Successfully extracted text using mammoth.extractRawText`);
        return result.value;
      }
      
      if (result.messages && result.messages.length > 0) {
        console.error(`[DOCX] Warnings from extractRawText:`, result.messages.map((m: any) => m.message).join(', '));
      }
    } catch (mammothError: any) {
      console.error(`[DOCX] mammoth.extractRawText failed: ${mammothError?.message || mammothError}`);
    }
    
    // Method 3: Try mammoth convertToHtml
    try {
      const htmlResult = await mammoth.convertToHtml({ buffer: data });
      if (htmlResult.value) {
        // Strip HTML tags and decode entities
        const text = htmlResult.value
          .replace(/<style[^>]*>.*?<\/style>/gi, ' ') // Remove style tags
          .replace(/<script[^>]*>.*?<\/script>/gi, ' ') // Remove script tags
          .replace(/<[^>]*>/g, ' ') // Remove HTML tags
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/&[^;]+;/g, ' ') // Remove any remaining entities
          .replace(/\s+/g, ' ') // Normalize whitespace
          .trim();
        if (text.length > 0) {
          console.error(`[DOCX] Successfully extracted text using mammoth.convertToHtml`);
          return text;
        }
      }
      if (htmlResult.messages && htmlResult.messages.length > 0) {
        console.error(`[DOCX] Warnings from convertToHtml:`, htmlResult.messages.map((m: any) => m.message).join(', '));
      }
    } catch (htmlError: any) {
      console.error(`[DOCX] mammoth.convertToHtml failed: ${htmlError?.message || htmlError}`);
    }
    
    console.error(`[DOCX] All extraction methods failed - could not extract text from DOCX file`);
    return null;
  }
  
  // Old .doc format (not supported by mammoth)
  if (lowerExt === '.doc') {
    console.error(`[DOC] Old .doc format not supported by mammoth. Please convert to .docx or use a different tool.`);
    return null;
  }
  
  // PDF files - extract text with pdf-parse
  if (lowerExt === '.pdf') {
    try {
      const require = createRequire(import.meta.url);
      const pdfParse = require('pdf-parse');
      
      // Suppress stderr warnings from pdf-parse (like "TT: undefined function")
      const originalStderr = process.stderr.write;
      const stderrBuffer: string[] = [];
      process.stderr.write = function(chunk: any, encoding?: any, callback?: any) {
        const message = chunk?.toString() || '';
        // Filter out harmless pdf-parse warnings
        if (message.includes('TT: undefined function') || 
            message.includes('Warning:') && message.includes('pdf-parse')) {
          return true; // Suppress these warnings
        }
        stderrBuffer.push(message);
        return originalStderr.call(process.stderr, chunk, encoding, callback);
      };
      
      try {
        const pdfData = await pdfParse(data);
        // Restore stderr
        process.stderr.write = originalStderr;
        return pdfData?.text || null;
      } catch (parseError: any) {
        // Restore stderr
        process.stderr.write = originalStderr;
        throw parseError;
      }
    } catch (error: any) {
      console.error(`[PDF] Error parsing PDF: ${error?.message || error}`);
      return null;
    }
  }
  
  // For binary files, return null (could add base64 option later)
  return null;
}

const extToMime: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

function saveBuffer(data: Buffer, filename: string, downloadsDir: string, savePath?: string): string {
  // Ensure the target directory exists
  const targetDir = savePath && !fs.existsSync(savePath) ? path.dirname(savePath) : downloadsDir;
  fs.mkdirSync(targetDir, { recursive: true });

  let finalPath = savePath && fs.existsSync(savePath) && !fs.statSync(savePath).isDirectory()
    ? savePath
    : path.join(downloadsDir, filename);

  let counter = 1;
  const ext = path.extname(finalPath);
  const base = path.basename(finalPath, ext);
  const dirPath = path.dirname(finalPath);
  while (fs.existsSync(finalPath)) {
    finalPath = path.join(dirPath, `${base} (${counter})${ext}`);
    counter++;
  }

  fs.writeFileSync(finalPath, data);
  return finalPath;
}

export async function downloadFile(url: string, savePath?: string) {
  const userId = getUserId();

  // Resolve host for this user, and get a fresh token (triggers re-login if stale)
  const d2lTokenData = await getD2LToken(userId);
  const d2lHost = d2lTokenData?.host || process.env.D2L_HOST || 'learn.ul.ie';

  const fullUrl = url.startsWith('http') ? url : `https://${d2lHost}${url}`;
  const urlPath = new URL(fullUrl).pathname;
  const urlFilename = decodeURIComponent(urlPath.split('/').pop() || 'download');

  const downloadsDir = savePath && fs.existsSync(savePath) && fs.statSync(savePath).isDirectory()
    ? savePath
    : path.join(os.homedir(), 'Downloads');

  // Strategy 0: Direct HTTP fetch using D2L session cookies — no browser needed.
  // Use getToken() (not getD2LToken) so stale tokens trigger a silent re-login first.
  const freshTokenStr = await getToken(userId).catch(() => null);
  if (freshTokenStr) {
    try {
      let cookieHeader = '';
      try {
        const parsed = JSON.parse(freshTokenStr);
        if (parsed.d2lSessionVal && parsed.d2lSecureSessionVal) {
          cookieHeader = `d2lSessionVal=${parsed.d2lSessionVal}; d2lSecureSessionVal=${parsed.d2lSecureSessionVal}`;
        }
      } catch { /* not a cookie token */ }

      if (cookieHeader) {
        console.error(`[DOWNLOAD] Direct fetch: ${fullUrl}`);
        const response = await fetch(fullUrl, {
          headers: { Cookie: cookieHeader },
          redirect: 'follow',
        });

        const contentType = response.headers.get('content-type') || '';
        console.error(`[DOWNLOAD] Direct fetch status: ${response.status}, content-type: ${contentType}`);

        if (response.ok && !contentType.includes('text/html')) {
          const data = Buffer.from(await response.arrayBuffer());

          const contentDisposition = response.headers.get('content-disposition') || '';
          let filename = urlFilename;
          const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
          if (filenameMatch) filename = filenameMatch[1].replace(/['"]/g, '').trim();

          const finalPath = saveBuffer(data, filename, downloadsDir, savePath);
          console.error(`[DOWNLOAD] File saved: ${finalPath} (${(data.length / 1024).toFixed(1)} KB)`);

          const ext = path.extname(finalPath).toLowerCase();
          const finalContentType = contentType.includes('octet-stream') ? (extToMime[ext] || contentType) : contentType;
          const textContent = await extractContent(data, ext);

          return {
            path: finalPath,
            filename: path.basename(finalPath),
            size: data.length,
            contentType: finalContentType,
            content: textContent,
          };
        }

        if (!response.ok) {
          console.error(`[DOWNLOAD] Direct fetch got ${response.status} — falling back to browser`);
        } else {
          console.error(`[DOWNLOAD] Direct fetch returned HTML — session may be expired, falling back to browser`);
        }
      }
    } catch (fetchErr: any) {
      console.error(`[DOWNLOAD] Direct fetch error: ${fetchErr?.message} — falling back to browser`);
    }
  }

  // Fallback: browser-based download (handles complex auth/redirect flows)
  const browser = await getAuthenticatedContext(userId);

  try {
    const page = await browser.newPage();

    console.error(`[DOWNLOAD] Browser navigating to: ${fullUrl}`);
    const navResponse = await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });

    const navContentType = navResponse?.headers()['content-type'] || '';
    if (navResponse && navResponse.ok() && !navContentType.includes('text/html')) {
      const data = await navResponse.body();

      const contentDisposition = navResponse.headers()['content-disposition'] || '';
      let filename = urlFilename;
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch) filename = filenameMatch[1].replace(/['"]/g, '');

      const finalPath = saveBuffer(Buffer.from(data), filename, downloadsDir, savePath);
      console.error(`[DOWNLOAD] Browser: file saved: ${finalPath} (${(data.length / 1024).toFixed(1)} KB)`);

      const ext = path.extname(finalPath).toLowerCase();
      const finalContentType = navContentType.includes('octet-stream') ? (extToMime[ext] || navContentType) : navContentType;
      const textContent = await extractContent(Buffer.from(data), ext);

      return {
        path: finalPath,
        filename: path.basename(finalPath),
        size: data.length,
        contentType: finalContentType,
        content: textContent,
      };
    }

    // HTML page — look for a download button/link
    await page.waitForTimeout(2000);

    const downloadSelectors = [
      'a[download]',
      'a:has-text("Download")',
      'button:has-text("Download")',
      '[data-download]',
      'a.download',
      'button.download',
      'a[href*="download"]',
      'a[href*="ViewFile"]',
      'a[href*="FileDownload"]',
    ];

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);

    for (const selector of downloadSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 2000 })) {
          console.error(`[DOWNLOAD] Found download element: ${selector}`);
          await element.click();
          break;
        }
      } catch { /* try next selector */ }
    }

    const download = await downloadPromise;
    if (download) {
      const suggestedFilename = download.suggestedFilename() || urlFilename;
      let finalPath = path.join(downloadsDir, suggestedFilename);

      let counter = 1;
      const ext = path.extname(finalPath);
      const base = path.basename(finalPath, ext);
      const dirPath = path.dirname(finalPath);
      while (fs.existsSync(finalPath)) {
        finalPath = path.join(dirPath, `${base} (${counter})${ext}`);
        counter++;
      }

      await download.saveAs(finalPath);
      console.error(`[DOWNLOAD] Browser download saved: ${finalPath}`);

      const data = fs.readFileSync(finalPath);
      const fileExt = path.extname(finalPath).toLowerCase();
      const contentType = extToMime[fileExt] || 'application/octet-stream';
      const textContent = await extractContent(data, fileExt);

      return {
        path: finalPath,
        filename: path.basename(finalPath),
        size: data.length,
        contentType,
        content: textContent,
      };
    }

    throw new Error('Could not trigger file download. The page may not have a download button, or the file may require manual download.');

  } finally {
    await browser.close();
  }
}

/**
 * Resolve a user-provided path or filename to an absolute file path.
 * Mirrors the logic used by readFile so download/read/delete all agree.
 */
function resolveFilePath(filePath: string): string {
  let finalPath = filePath;

  // If path doesn't exist and doesn't start with /, try Downloads folder
  if (!fs.existsSync(filePath) && !path.isAbsolute(filePath)) {
    const downloadsPath = path.join(os.homedir(), "Downloads", filePath);
    if (fs.existsSync(downloadsPath)) {
      finalPath = downloadsPath;
    }
  }

  // If still not found, try to find by filename in Downloads
  if (!fs.existsSync(finalPath)) {
    const downloadsDir = path.join(os.homedir(), "Downloads");
    if (fs.existsSync(downloadsDir)) {
      try {
        const files = fs.readdirSync(downloadsDir);
        const matchingFile = files.find(
          (f) =>
            f.toLowerCase().includes(filePath.toLowerCase()) || f === filePath
        );
        if (matchingFile) {
          finalPath = path.join(downloadsDir, matchingFile);
        }
      } catch {
        // Ignore readdir errors
      }
    }
  }

  // Check if file exists
  if (!fs.existsSync(finalPath)) {
    throw new Error(
      `File not found: ${filePath}. Searched in Downloads folder: ${path.join(
        os.homedir(),
        "Downloads"
      )}`
    );
  }

  // Check if it's a directory
  const stats = fs.statSync(finalPath);
  if (stats.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${finalPath}`);
  }

  return finalPath;
}

/**
 * Read a file from disk and extract its text content
 * Supports PDF, DOCX, TXT, and other text-based formats
 */
export async function readFile(filePath: string): Promise<{
  path: string;
  filename: string;
  size: number;
  contentType: string;
  content: string | null;
  exists: boolean;
}> {
  // Check if this is a note ID (UUID) or S3 key — fetch from S3
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filePath);
  const isS3Key = filePath.startsWith('users/') || filePath.startsWith('s3://');

  if (isUUID || isS3Key) {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3Bucket = process.env.S3_BUCKET || 'study-mcp-notes';
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

    let s3Key = isS3Key ? filePath.replace('s3://', '').replace(`${s3Bucket}/`, '') : '';

    // If UUID, look up the S3 key from the notes table
    if (isUUID) {
      const userId = getUserId();
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
      if (sbUrl && sbKey) {
        const resp = await fetch(`${sbUrl}/rest/v1/notes?id=eq.${filePath}&select=s3_key,title&limit=1`, {
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
        });
        if (resp.ok) {
          const rows = await resp.json() as Array<{ s3_key: string; title: string }>;
          if (rows.length > 0 && rows[0].s3_key) {
            s3Key = rows[0].s3_key;
          } else {
            throw new Error(`Note not found: ${filePath}`);
          }
        }
      }
    }

    if (!s3Key) throw new Error(`Could not resolve S3 key for: ${filePath}`);

    console.error(`[READ_FILE] Fetching from S3: ${s3Key}`);
    const s3Resp = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }));
    const rawBytes = await s3Resp.Body?.transformToByteArray();
    if (!rawBytes || rawBytes.length === 0) throw new Error(`Empty file in S3: ${s3Key}`);

    const data = Buffer.from(rawBytes);
    const filename = path.basename(s3Key);
    const ext = path.extname(filename);
    const contentType = s3Resp.ContentType || 'application/octet-stream';
    const textContent = await extractContent(data, ext);

    return {
      path: `s3://${s3Bucket}/${s3Key}`,
      filename,
      size: data.length,
      contentType,
      content: textContent,
      exists: true,
    };
  }

  const finalPath = resolveFilePath(filePath);

  // Read file
  const data = fs.readFileSync(finalPath);
  const ext = path.extname(finalPath);

  // Determine content type
  const extToMime: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".json": "application/json",
    ".csv": "text/csv",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
  };

  const contentType = extToMime[ext.toLowerCase()] || "application/octet-stream";

  // Extract text content
  const textContent = await extractContent(data, ext);

  return {
    path: finalPath,
    filename: path.basename(finalPath),
    size: data.length,
    contentType,
    content: textContent,
    exists: true,
  };
}

/**
 * Delete a file from disk.
 * Uses the same resolution rules as readFile (Downloads search, etc).
 */
export async function deleteFile(filePath: string): Promise<{
  path: string;
  filename: string;
  deleted: boolean;
}> {
  const finalPath = resolveFilePath(filePath);

  try {
    fs.unlinkSync(finalPath);
    return {
      path: finalPath,
      filename: path.basename(finalPath),
      deleted: true,
    };
  } catch (error: any) {
    console.error(
      `[FILE] Failed to delete file ${finalPath}: ${error?.message || error}`
    );
    throw new Error(`Failed to delete file: ${finalPath}`);
  }
}
