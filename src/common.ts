export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 500;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function safePath(path: string): string {
  if (!path || new TextEncoder().encode(path).length > 900 ||
      /[\\%\x00-\x1f\x7f?#:]/u.test(path) || path.startsWith("/")) {
    throw new HttpError(400, "Unsafe file path");
  }
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) {
    throw new HttpError(400, "Unsafe file path");
  }
  return path;
}

export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "Upload or expanded ZIP exceeds 20 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", wasm: "application/wasm", pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
  webmanifest: "application/manifest+json",
};

export function contentType(path: string): string {
  return MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export function validateFolder(folder: string): string {
  if (typeof folder !== "string") throw new HttpError(400, "folder must be a string");
  const trimmed = folder.trim();
  if (!trimmed) throw new HttpError(400, "folder cannot be empty");
  if (trimmed.length > 120) throw new HttpError(400, "folder length must be at most 120 characters");
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new HttpError(400, "folder cannot contain control characters");
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw new HttpError(400, "folder cannot start or end with slash");
  }
  if (trimmed.includes("//")) {
    throw new HttpError(400, "folder cannot contain consecutive slashes");
  }
  if (trimmed !== "uncategorized") {
    const parts = trimmed.split("/");
    if (parts.length > 2) throw new HttpError(400, "folder must be uncategorized or project/task format");
    for (const part of parts) {
      const p = part.trim();
      if (!p || p === "." || p === "..") throw new HttpError(400, "Invalid folder segment");
    }
  }
  return trimmed.split("/").map(part => part.trim().normalize("NFC")).join("/");
}

export function validateTitle(title?: string | null): string | undefined {
  if (title === undefined || title === null) return undefined;
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 200 || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new HttpError(400, "title must be at most 200 characters without control characters");
  }
  return trimmed;
}

export function validateCategory(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Name must be text");
  const name = value.trim().normalize("NFC");
  if (!name || name.length > 58 || /[\/\\\x00-\x1f\x7f]/.test(name) ||
      [".", "..", "uncategorized"].includes(name)) {
    throw new HttpError(400, "Use a name of 1–58 characters without slashes or control characters");
  }
  return name;
}
