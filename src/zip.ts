import { HttpError, MAX_BYTES, MAX_FILES, readBounded, safePath } from "./common";

export interface SiteFile { path: string; data: Uint8Array<ArrayBuffer> }
interface Entry {
  path: string;
  start: number;
  compressedSize: number;
  size: number;
  method: number;
  crc: number;
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[i] = value;
}
function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function invalid(): never { throw new HttpError(400, "Invalid, encrypted, or unsupported ZIP"); }

/** Read the central directory before allocating any decompressed file buffers. */
function entries(bytes: Uint8Array<ArrayBuffer>): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
  }
  if (end < 0 || u32(end) !== 0x06054b50) invalid();
  const count = u16(end + 10);
  const centralStart = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count ||
      count === 0 || count === 0xffff || centralStart + u32(end + 12) !== end) invalid();
  if (count > 1000) throw new HttpError(413, "ZIP has too many entries (maximum 1000)");

  const files: Entry[] = [];
  const names = new Set<string>();
  const ranges: [number, number][] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const decode = (at: number, length: number, flags: number) => {
    const name = bytes.subarray(at, at + length);
    if (!(flags & 0x800) && name.some(byte => byte > 127)) {
      throw new HttpError(400, "ZIP filenames must use UTF-8");
    }
    return decoder.decode(name);
  };
  let offset = centralStart;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) invalid();
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const compressedSize = u32(offset + 20);
    const size = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const next = offset + 46 + nameLength + u16(offset + 30) + u16(offset + 32);
    const local = u32(offset + 42);
    const kind = (u32(offset + 38) >>> 16) & 0xf000;
    if (next > end || flags & ~0x80e || ![0, 8].includes(method) ||
        u16(offset + 34) || ![0, 0x8000, 0x4000].includes(kind) ||
        size === 0xffffffff || compressedSize === 0xffffffff) invalid();
    const name = decode(offset + 46, nameLength, flags);
    const directory = name.endsWith("/");
    const path = safePath(directory ? name.slice(0, -1) : name);
    if (names.has(path) || (kind === 0x4000 && !directory)) invalid();
    names.add(path);
    if (local + 30 > centralStart || u32(local) !== 0x04034b50 ||
        u16(local + 6) !== flags || u16(local + 8) !== method) invalid();
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start > centralStart || start + compressedSize > centralStart ||
        decode(local + 30, u16(local + 26), flags) !== name) invalid();
    ranges.push([local, start + compressedSize]);
    if (directory) {
      if (size !== 0) invalid();
    } else {
      total += size;
      if (total > MAX_BYTES || files.length >= MAX_FILES) {
        throw new HttpError(413, "Expanded ZIP exceeds 20 MiB or 500 files");
      }
      files.push({ path, start, compressedSize, size, method, crc: u32(offset + 16) });
    }
    offset = next;
  }
  if (offset !== end) invalid();
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1])) invalid();

  // ZIPs made by Finder often have one wrapper directory and __MACOSX entries.
  const usable = files.filter(file => !file.path.split("/").some(
    part => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"),
  ));
  if (!usable.some(file => file.path === "index.html")) {
    const root = usable[0]?.path.split("/")[0];
    if (root && usable.every(file => file.path.startsWith(`${root}/`))) {
      for (const file of usable) file.path = safePath(file.path.slice(root.length + 1));
    }
  }
  if (!usable.some(file => file.path === "index.html")) {
    throw new HttpError(400, "ZIP must contain index.html at its root (or in one wrapper directory)");
  }
  return usable;
}

export async function extractZip(bytes: Uint8Array<ArrayBuffer>): Promise<SiteFile[]> {
  try {
    const files: SiteFile[] = [];
    for (const entry of entries(bytes)) {
      const compressed = bytes.subarray(entry.start, entry.start + entry.compressedSize);
      // Native streaming inflate bounds actual output even if a hostile ZIP lies about size.
      const data = entry.method === 0 ? compressed : await readBounded(
        new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
        entry.size,
      );
      if (data.byteLength !== entry.size || crc32(data) !== entry.crc) invalid();
      files.push({ path: entry.path, data });
    }
    return files;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid();
  }
}
