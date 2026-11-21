// DSH session transcript reader.
//
// A DSH session is stored as `<DSH_HOME>/sessions/<project-slug>/<session-id>/session.v4.jsonl.zstd`.
// The file is a sequence of independent zstd frames (one per write batch); a
// single record may be split across frames, so frames are decompressed one by
// one and their bytes concatenated before the JSONL split. Plain `.jsonl` files
// are read as text. Nothing here mutates the transcript.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const zlib = require('node:zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function sessionsRoot(home) {
  return path.join(home, 'sessions');
}

export function decodeTranscriptFile(file) {
  const buf = readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('node:zlib.zstdDecompressSync is unavailable on this runtime');
  }
  const offsets = [];
  let at = buf.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + 4);
  }
  if (offsets.length === 0) return '';
  offsets.push(buf.length);
  const parts = [];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[i], offsets[i + 1])));
    } catch {
      // A partial tail frame while the session is being written: skip it.
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

export function readRecords(file) {
  const text = decodeTranscriptFile(file);
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Tolerate a torn last line rather than failing the whole digest.
    }
  }
  return records;
}

function transcriptFileIn(dir) {
  for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

// Lists sessions newest-first. `project` filters by the recorded cwd; `all`
// ignores the filter. Sessions without a readable transcript are skipped.
export function listSessions({ home, project, all = false, limit = 200 }) {
  const root = sessionsRoot(home);
  if (!existsSync(root)) return [];
  const out = [];
  for (const slug of readdirSync(root)) {
    const slugDir = path.join(root, slug);
    let entries = [];
    try {
      entries = readdirSync(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(slugDir, entry.name);
      const file = transcriptFileIn(dir);
      if (!file) continue;
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      out.push({ id: entry.name, slug, dir, file, mtime });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const session of out.slice(0, limit)) {
    let head;
    let cwd;
    try {
      const text = decodeTranscriptFile(session.file);
      const firstLine = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 400);
      head = JSON.parse(firstLine);
      cwd = head?.cwd;
    } catch {
      continue;
    }
    if (!all && project && normalizePath(cwd) !== normalizePath(project)) continue;
    sessions.push({ ...session, cwd, createdAt: head?.createdAt, parent: head?.parentSession, origin: head?.origin });
  }
  return sessions;
}

export function normalizePath(value) {
  if (!value) return '';
  return path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
}

// Extracts the text of a message record's content array.
export function contentText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'reasoning' && typeof part.text === 'string') parts.push('');
  }
  return parts.filter(Boolean).join('\n').trim();
}
