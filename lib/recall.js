// Recall scoring.
//
// Deterministic and inspectable on purpose: exact matching first (an error
// string, a command, a file name is what actually identifies a memory), then
// recency, frequency, cross-session trust and manual weight. Character trigrams
// stand in for embeddings in v1 — they catch rephrasings without a vector store,
// and they are cheap enough to run on every call.
const WEIGHTS = { exact: 0.4, semantic: 0.15, recency: 0.15, freq: 0.1, trust: 0.1, manual: 0.1 };
const PENALTIES = { conflict: 0.2, stale: 0.15 };

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

export function terms(query) {
  const raw = String(query || '').toLowerCase();
  const out = new Set();
  for (const word of raw.split(/[^\p{L}\p{N}_-]+/u)) {
    if (!word) continue;
    if (CJK.test(word)) {
      for (const char of word) out.add(char);
      for (let i = 0; i + 1 < word.length; i += 1) out.add(word.slice(i, i + 2));
    } else if (word.length >= 2) {
      out.add(word);
    }
  }
  return [...out].slice(0, 16);
}

function trigrams(text) {
  const clean = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  const grams = new Set();
  for (let i = 0; i + 2 < clean.length; i += 1) grams.add(clean.slice(i, i + 3));
  return grams;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function blobOf(record) {
  if (record.kind === 'run') {
    return [
      record.user,
      ...(record.conclusions || []),
      ...(record.summary || []),
      ...(record.commands || []),
      ...(record.files || []),
      ...(record.errors || []).map((error) => error.signature),
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [record.title, record.body, ...(record.tags || [])].filter(Boolean).join('\n');
}

export function scoreRecord(record, queryTerms, now) {
  const blob = blobOf(record);
  const lower = blob.toLowerCase();
  const gramQuery = trigrams(String(queryTerms.query || ''));
  const gramBlob = trigrams(blob);

  let hits = 0;
  for (const term of queryTerms.list) if (lower.includes(term)) hits += 1;
  const exact = queryTerms.list.length ? hits / queryTerms.list.length : 0;
  const semantic = jaccard(gramQuery, gramBlob);

  const at = record.at || now;
  const ageDays = Math.max(0, (now - at) / 86400000);
  const recency = Math.pow(0.5, ageDays / 30);
  const freq = Math.min(1, Math.log1p(record.timesSeen || 1) / Math.log(10));
  const trust = 1 - Math.pow(0.5, record.sessionsSeen || 1);
  const manual = Math.max(0, Math.min(1, record.weight ?? 0.5));

  let score =
    WEIGHTS.exact * exact +
    WEIGHTS.semantic * semantic +
    WEIGHTS.recency * recency +
    WEIGHTS.freq * freq +
    WEIGHTS.trust * trust +
    WEIGHTS.manual * manual;
  score -= PENALTIES.conflict * Math.min(1, (record.conflicts || []).length);
  if (record.staleReason) score -= PENALTIES.stale;

  return {
    score: Math.max(0, Math.min(1, score)),
    parts: { exact, semantic, recency, freq, trust, manual },
  };
}

export function recall(records, query, options = {}) {
  const now = options.now || Date.now();
  const limit = Math.max(1, Math.min(20, options.limit || 5));
  const floor = options.floor ?? 0.35;
  const project = options.project;
  const queryTerms = { list: terms(query), query };

  const scored = [];
  for (const record of records) {
    if (record.active === false) continue;
    if (record.staleReason) continue;
    if (project && project !== '*' && record.project && record.project !== project) continue;
    const { score, parts } = scoreRecord(record, queryTerms, now);
    if (score < floor) continue;
    scored.push({ record, score, parts });
  }
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ record, score, parts }) => ({
    id: record.id,
    kind: record.kind === 'run' ? 'run' : record.noteKind || 'note',
    score: Number(score.toFixed(3)),
    parts: Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, Number(value.toFixed(2))])),
    at: record.at,
    project: record.project,
    title: record.kind === 'run' ? (record.user || record.conclusions?.[0] || record.commands?.[0] || '') : record.title,
    snippet: record.kind === 'run'
      ? [record.user, ...(record.conclusions || []), ...(record.commands || []).slice(0, 3)].filter(Boolean).join(' · ').slice(0, 400)
      : String(record.body || '').slice(0, 400),
    tags: record.tags || [],
  }));
}

// A brief is the always-first payload: a handful of durable notes for a project,
// bounded so it can sit in the stable prefix without costing much.
export function brief(records, options = {}) {
  const now = options.now || Date.now();
  const budget = options.budgetTokens || 1200;
  const project = options.project;
  const pool = records
    .filter((record) => record.active !== false && !record.staleReason)
    .filter((record) => !project || project === '*' || !record.project || record.project === project)
    .map((record) => {
      const at = record.at || now;
      const ageDays = Math.max(0, (now - at) / 86400000);
      const rank =
        (record.noteKind === 'fix' ? 0.5 : 0.4) +
        0.2 * Math.pow(0.5, ageDays / 30) +
        0.15 * (1 - Math.pow(0.5, record.sessionsSeen || 1)) +
        0.1 * Math.min(1, Math.log1p(record.timesSeen || 1) / Math.log(10));
      return { record, rank };
    })
    .sort((a, b) => b.rank - a.rank);

  const picked = [];
  let used = 0;
  for (const { record } of pool) {
    const line = `- [${record.noteKind || 'note'}] ${record.title || ''} :: ${String(record.body || '').replace(/\s+/g, ' ').slice(0, 200)}`;
    const cost = Math.max(1, Math.round(line.length / 3.5));
    if (used + cost > budget) break;
    used += cost;
    picked.push({ id: record.id, kind: record.noteKind || 'note', title: record.title, body: record.body, at: record.at, project: record.project });
  }
  return { tokens: used, items: picked };
}
