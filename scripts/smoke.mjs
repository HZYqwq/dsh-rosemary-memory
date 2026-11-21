// Offline smoke test: digest a real transcript, then recall against it.
// Usage: node scripts/smoke.mjs [sessionIdPrefix]
import os from 'node:os';
import path from 'node:path';
import { listSessions, readRecords } from '../lib/transcript.js';
import { digestRecords } from '../lib/digest.js';
import { recall, brief } from '../lib/recall.js';

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const project = process.argv[3] || process.cwd();
const prefix = process.argv[2] || '';

const sessions = listSessions({ home, all: true, limit: 200 });
console.log('sessions found:', sessions.length);
const target = sessions.find((session) => session.id.includes(prefix)) || sessions[0];
if (!target) {
  console.log('no session transcript found');
  process.exit(1);
}
console.log('target:', target.id, '| cwd:', target.cwd);

const records = readRecords(target.file);
console.log('records:', records.length);
const result = digestRecords(records, { sessionId: target.id, project: target.cwd || project });
console.log('stats:', JSON.stringify(result.stats));
console.log('first run:', JSON.stringify(result.runs[0], null, 2).slice(0, 900));
console.log('last run:', JSON.stringify(result.runs.at(-1), null, 2).slice(0, 900));
console.log('notes:', result.notes.length);
for (const note of result.notes.slice(0, 5)) console.log(' -', note.noteKind, '|', note.title);

const queries = ['zstd', 'Failed to fetch', 'billion-context', 'adminRelay'];
for (const q of queries) {
  const hits = recall([...result.notes, ...result.runs], q, { limit: 3, project: target.cwd });
  console.log(`recall "${q}" ->`, hits.map((hit) => `${hit.score}:${(hit.title || '').slice(0, 40)}`).join(' | ') || '(none)');
}
const digestBrief = brief(result.notes, { project: target.cwd, budgetTokens: 400 });
console.log('brief tokens:', digestBrief.tokens, 'items:', digestBrief.items.length);
