// Weighted memory units.
//
// `digest` produces fine-grained notes: one per conclusion or fix. Across months
// that is hundreds of rows, most of them saying nearly the same thing from
// different sessions ("UnknownHostException -> check the proxy port" appears in
// three of them). Reading that raw list is not useful, so this module folds
// notes into *units*:
//
//   * duplicate/near-duplicate notes merge into one unit, and the unit's weight
//     grows with how often the same lesson was learned (timesSeen), how many
//     sessions taught it (sessionsSeen), and how recently it came up;
//   * a cluster big enough to cross the configured thresholds is promoted to a
//     `playbook` 鈥?a single compressed entry that keeps the merged lesson and
//     links back to every source note, so nothing is lost.
//
// Weights are 0..1 so a UI can render them as bars without knowing the domain.

import { terms as termTokens } from './recall.js';

export const DEFAULT_CONFIG = {
  // Promote a cluster to a playbook once this many notes agree.
  compactThreshold: 2,
  // ...and once the merged weight reaches this value.
  compactWeight: 0.4,
  // Near-duplicate detection: share of tokens two notes must have in common.
  similarity: 0.55,
  // How many units the page asks for by default.
  limit: 80,
};

export function normalizeConfig(input) {
  const cfg = { ...DEFAULT_CONFIG };
  if (!input || typeof input !== 'object') return cfg;
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  cfg.compactThreshold = Math.round(num(input.compactThreshold, cfg.compactThreshold, 1, 20));
  cfg.compactWeight = num(input.compactWeight, cfg.compactWeight, 0, 1);
  cfg.similarity = num(input.similarity, cfg.similarity, 0.2, 0.9);
  cfg.limit = Math.round(num(input.limit, cfg.limit, 10, 500));
  return cfg;
}

function titleOf(note) {
  const text = String(note.title || note.body || '').replace(/\s+/g, ' ').trim();
  return text.length > 96 ? `${text.slice(0, 96)}...` : text;
}

function bodyOf(note) {
  return String(note.body || note.title || '').trim();
}

function recencyOf(note, now) {
  const at = Number(note.lastSeenAt || note.at || note.createdAt || 0);
  if (!at) return 0.3;
  const days = Math.max(0, (now - at) / 86400000);
  return 1 / (1 + days / 45);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  if (inter < 2) return 0;
  // Containment, not Jaccard: a short "UnknownHostException -> proxy port" note should
  // still match a long note that says the same thing inside a paragraph.
  return inter / Math.min(a.size, b.size);
}

function tokenSet(text) {
  const set = new Set();
  for (const t of termTokens(text)) if (t.length >= 2 || /[\u4e00-\u9fa5]/.test(t)) set.add(t);
  return set;
}

/**
 * Fold notes into weighted units.
 *
 * @param {object[]} notes stored note records
 * @param {object} [options]
 * @param {number} [options.now] clock override (tests)
 * @param {object} [options.config] thresholds, see DEFAULT_CONFIG
 * @param {string} [options.query] optional free-text filter
 * @returns {{units: object[], stats: object, config: object}}
 */
export function buildUnits(notes, options = {}) {
  const cfg = normalizeConfig(options.config);
  const now = options.now || Date.now();
  const query = String(options.query || '').trim().toLowerCase();

  // 1. Merge exact duplicates first: same project + same normalised text.
  const merged = new Map();
  for (const note of notes || []) {
    if (note && note.active === false) continue;
    const text = bodyOf(note);
    if (!text) continue;
    const key = `${note.project || ''}\u0000${text.toLowerCase().replace(/\s+/g, ' ')}`;
    const prev = merged.get(key);
    const seen = Number(note.timesSeen) || 1;
    const sessions = Array.isArray(note.sessionsSeen) ? note.sessionsSeen.length : Number(note.sessionsSeen) || 1;
    if (!prev) {
      merged.set(key, {
        id: note.id,
        kind: note.kind || 'note',
        project: note.project || '',
        text,
        title: titleOf(note),
        timesSeen: seen,
        sessionsSeen: sessions,
        manual: Number(note.weight) || 0,
        firstSeenAt: Number(note.at || 0) || now,
        lastSeenAt: Number(note.lastSeenAt || note.at || 0) || now,
        sources: [note.id],
        tags: Array.isArray(note.tags) ? note.tags.slice(0, 6) : [],
      });
    } else {
      prev.timesSeen += seen;
      prev.sessionsSeen = Math.max(prev.sessionsSeen, sessions);
      prev.manual = Math.max(prev.manual, Number(note.weight) || 0);
      prev.lastSeenAt = Math.max(prev.lastSeenAt, Number(note.lastSeenAt || note.at || 0) || 0);
      prev.firstSeenAt = Math.min(prev.firstSeenAt, Number(note.at || 0) || prev.firstSeenAt);
      if (!prev.sources.includes(note.id)) prev.sources.push(note.id);
    }
  }

  let rows = [...merged.values()].map((row) => {
    const freq = Math.min(1, Math.log2(1 + row.timesSeen) / Math.log2(7)); // 1鈫?36, 3鈫?71, 6鈫?
    const trust = Math.min(1, row.sessionsSeen / 4);
    return {
      ...row,
      weight: Math.min(1, freq * 0.35 + trust * 0.25 + row.manual * 0.2 + recencyOf(row, now) * 0.2),
    };
  });

  // 2. Cluster near-duplicates into playbooks.
  const clusters = [];
  const used = new Set();
  const sets = rows.map((r) => tokenSet(r.text));
  for (let i = 0; i < rows.length; i += 1) {
    if (used.has(i)) continue;
    const group = [i];
    used.add(i);
    for (let j = i + 1; j < rows.length; j += 1) {
      if (used.has(j)) continue;
      if (rows[j].project !== rows[i].project) continue;
      if (jaccard(sets[i], sets[j]) >= cfg.similarity) {
        group.push(j);
        used.add(j);
      }
    }
    clusters.push(group);
  }

  const units = clusters.map((group) => {
    const members = group.map((idx) => rows[idx]);
    const weight = Math.min(1, members.reduce((sum, m) => sum + m.weight, 0) / Math.max(1, members.length) + (members.length - 1) * 0.15);
    const sessionsSeen = members.reduce((max, m) => Math.max(max, m.sessionsSeen), 0);
    const timesSeen = members.reduce((sum, m) => sum + m.timesSeen, 0);
    const sources = members.flatMap((m) => m.sources);
    // Lead sentence: the longest member text is usually the most informative one.
    const lead = members.slice().sort((a, b) => bodyOf(b).length - bodyOf(a).length)[0];
    const promote = members.length >= cfg.compactThreshold && weight >= cfg.compactWeight;
    return {
      id: `u-${lead.id}`,
      kind: promote ? 'playbook' : lead.kind,
      project: lead.project,
      title: promote ? lead.title : lead.title,
      text: lead.text,
      weight: Number(weight.toFixed(3)),
      timesSeen,
      sessionsSeen,
      members: members.length,
      sources: [...new Set(sources)].slice(0, 24),
      folded: promote
        ? members
            .map((m) => m.text)
            .filter((t) => t !== lead.text)
            .slice(0, 6)
        : [],
      tags: [...new Set(members.flatMap((m) => m.tags || []))].slice(0, 8),
      lastSeenAt: Math.max(...members.map((m) => m.lastSeenAt || 0)),
      firstSeenAt: Math.min(...members.map((m) => m.firstSeenAt || now)),
    };
  });

  let out = units;
  if (query) {
    const terms = [...tokenSet(query)];
    out = out.filter((u) => {
      const hay = `${u.title} ${u.text} ${(u.tags || []).join(' ')}`.toLowerCase();
      return terms.every((t) => hay.includes(t.toLowerCase())) || hay.includes(query);
    });
  }

  out.sort((a, b) => b.weight - a.weight || b.sessionsSeen - a.sessionsSeen || b.lastSeenAt - a.lastSeenAt);
  const total = out.length;
  const playbooks = out.filter((u) => u.kind === 'playbook').length;
  return {
    units: out.slice(0, cfg.limit),
    config: cfg,
    stats: {
      notes: (notes || []).length,
      merged: rows.length,
      units: total,
      playbooks,
      returned: Math.min(out.length, cfg.limit),
      avgWeight: Number((out.reduce((s, u) => s + u.weight, 0) / Math.max(1, total)).toFixed(3)),
    },
  };
}

