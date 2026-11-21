// Append-only JSONL store for dsh-rosemary-memory.
//
// Layout (all under the store root, see storeRoot() in index.js):
//   runs.jsonl   one record per digested turn
//   notes.jsonl  decisions / fixes / manually remembered facts
//   state.json   small mutable bookkeeping (last digest, briefed sessions)
//
// JSONL append keeps a torn write recoverable (the bad line is skipped on read)
// and leaves the human able to inspect or hand-edit everything. Nothing here
// ever rewrites or deletes an original transcript record.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export function ensureStore(root) {
  mkdirSync(root, { recursive: true });
  return root;
}

function fileFor(root, kind) {
  return path.join(ensureStore(root), `${kind}.jsonl`);
}

export function readAll(root, kind) {
  const file = fileFor(root, kind);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip torn line
    }
  }
  return out;
}

export function appendAll(root, kind, records) {
  if (!records.length) return;
  const file = fileFor(root, kind);
  appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

export function loadState(root) {
  const file = path.join(ensureStore(root), 'state.json');
  if (!existsSync(file)) return { briefed: {}, lastDigestAt: null, digests: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { briefed: {}, lastDigestAt: null, digests: [], ...parsed };
  } catch {
    return { briefed: {}, lastDigestAt: null, digests: [] };
  }
}

export function saveState(root, state) {
  const dir = ensureStore(root);
  const file = path.join(dir, 'state.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

// Merges freshly digested records with what is already stored. Runs are keyed by
// id; notes are keyed by id too, and seeing the same fact in another session
// bumps `sessionsSeen` (used by the trust term of the recall score) instead of
// creating a duplicate.
export function mergeRuns(root, runs) {
  const existing = new Map(readAll(root, 'runs').map((r) => [r.id, r]));
  const fresh = [];
  for (const run of runs) {
    if (existing.has(run.id)) continue;
    existing.set(run.id, run);
    fresh.push(run);
  }
  appendAll(root, 'runs', fresh);
  return { added: fresh.length, total: existing.size };
}

export function mergeNotes(root, notes) {
  const existing = new Map(readAll(root, 'notes').map((n) => [n.id, n]));
  const fresh = [];
  const touched = [];
  for (const note of notes) {
    const prior = existing.get(note.id);
    if (!prior) {
      existing.set(note.id, note);
      fresh.push(note);
      continue;
    }
    if (!prior.sessionsSeenList?.includes(note.sessionId)) {
      prior.sessionsSeenList = [...(prior.sessionsSeenList || []), note.sessionId];
      prior.sessionsSeen = (prior.sessionsSeen || 1) + 1;
      prior.timesSeen = (prior.timesSeen || 1) + 1;
      prior.at = Math.max(prior.at || 0, note.at || 0);
      touched.push(prior);
    }
  }
  appendAll(root, 'notes', [...fresh, ...touched]);
  return { added: fresh.length, seenAgain: touched.length, total: existing.size };
}
