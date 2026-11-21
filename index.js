// dsh-rosemary-memory — manual, deterministic cross-session memory for DeepSeek Harness.
//
// Host side:
//   tools   memory_digest / memory_recall / memory_remember / memory_brief
//   routes  /dsh-rosemary-memory/{status,digest,notes,remember,recall,brief,units,compress,settings}
//           (/dsh-memory/* stays as a legacy alias)
//
// The digest runs only when someone asks (the composer-dock button, a tool call
// or the CLI). It reads finished turns from the session transcripts on disk and
// writes append-only run/note records; it never rewrites a transcript and never
// calls a model.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, readRecords } from './lib/transcript.js';
import { digestRecords } from './lib/digest.js';
import { readAll, mergeRuns, mergeNotes, loadState, saveState } from './lib/store.js';
import { recall, brief } from './lib/recall.js';
import { buildUnits, normalizeConfig, DEFAULT_CONFIG } from './lib/units.js';

export const name = 'dsh-rosemary-memory';
export const inject = ['tools'];

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

function hash32(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// Where runs/notes/state live. Defaults to `<plugin>/data`, which keeps the
// memory on the same drive as the checkout instead of growing the user profile
// on C:. Overridable by DSH_ROSEMARY_MEMORY_DIR (env), the legacy DSH_MEMORY_DIR,
// or `storeDir` in the bundle config.
let configuredStoreDir = '';

function storeRoot() {
  return (
    process.env.DSH_ROSEMARY_MEMORY_DIR ||
    process.env.DSH_MEMORY_DIR ||
    configuredStoreDir ||
    path.join(PLUGIN_DIR, 'data')
  );
}

function normalizePath(value) {
  if (!value) return '';
  try {
    return path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function projectOf(exec, args) {
  return args?.project || exec?.cwd || exec?.session?.cwd || '';
}

// Collects sessions to digest: an explicit session id, otherwise every session
// of the project, newest first. With neither, it falls back to the newest
// session — a button click or a bare tool call must never sweep the machine.
function digestSessions({ sessionId, project, all, limit }) {
  const home = homeDir();
  const scope = { home, project, all: all === true, limit: limit || 40 };
  if (sessionId) {
    return { home, sessions: listSessions(scope).filter((session) => session.id === sessionId) };
  }
  if (!project && all !== true) {
    const newest = listSessions({ home, all: true, limit: 1 })[0];
    if (newest) return { home, sessions: [newest] };
  }
  return { home, sessions: listSessions(scope) };
}

export function planDigest({ sessionId, project, all, limit } = {}) {
  const { home, sessions } = digestSessions({ sessionId, project, all, limit });
  const plans = [];
  for (const session of sessions) {
    let records;
    try {
      records = readRecords(session.file);
    } catch (error) {
      plans.push({ sessionId: session.id, error: String(error?.message || error) });
      continue;
    }
    const digested = digestRecords(records, { sessionId: session.id, project: session.cwd || project || '' });
    plans.push({
      sessionId: session.id,
      project: session.cwd || '',
      cwd: session.cwd,
      mtime: session.mtime,
      ...digested,
    });
  }
  return { home, plans };
}

export function applyDigest({ sessionId, project, all, limit } = {}) {
  const { plans } = planDigest({ sessionId, project, all, limit });
  const root = storeRoot();
  const summary = { sessions: 0, runsAdded: 0, notesAdded: 0, skippedSessions: [] };
  for (const plan of plans) {
    if (plan.error) {
      summary.skippedSessions.push({ sessionId: plan.sessionId, error: plan.error });
      continue;
    }
    const runs = mergeRuns(root, plan.runs);
    const notes = mergeNotes(root, plan.notes);
    summary.sessions += 1;
    summary.runsAdded += runs.added;
    summary.notesAdded += notes.added;
  }
  const state = loadState(root);
  state.lastDigestAt = Date.now();
  state.digests = [...(state.digests || []).slice(-19), { at: state.lastDigestAt, ...summary }];
  saveState(root, state);
  return { ...summary, storeDir: root, lastDigestAt: state.lastDigestAt };
}

function previewDigest({ sessionId, project, all, limit } = {}) {
  const { plans } = planDigest({ sessionId, project, all, limit });
  const root = storeRoot();
  const existingRuns = new Set(readAll(root, 'runs').map((record) => record.id));
  const existingNotes = new Set(readAll(root, 'notes').map((record) => record.id));
  const preview = plans.map((plan) => {
    if (plan.error) return { sessionId: plan.sessionId, error: plan.error };
    const newRuns = plan.runs.filter((run) => !existingRuns.has(run.id));
    const newNotes = plan.notes.filter((note) => !existingNotes.has(note.id));
    const dropped = plan.runs.filter((run) => newRuns.includes(run) && !(run.conclusions?.length || run.errors?.length || run.commands?.length));
    return {
      sessionId: plan.sessionId,
      project: plan.project,
      turns: plan.stats.turns,
      newRuns: newRuns.length,
      newNotes: newNotes.length,
      droppedTurns: dropped.map((run) => ({ turn: run.turn, user: (run.user || '').slice(0, 80) })),
      sampleRuns: newRuns.slice(-5).map((run) => ({
        turn: run.turn,
        user: (run.user || '').slice(0, 120),
        conclusions: (run.conclusions || []).slice(0, 2),
        errors: (run.errors || []).map((error) => error.signature).slice(0, 2),
        files: (run.files || []).slice(0, 3),
        tokens: run.tokens,
      })),
      sampleNotes: newNotes.slice(0, 10).map((note) => ({ kind: note.noteKind, title: note.title, body: (note.body || '').slice(0, 160) })),
    };
  });
  return { dryRun: true, storeDir: storeRoot(), plans: preview };
}

function makeNote({ title, body, tags, project, noteKind = 'manual', weight = 0.8, sessionId = 'manual' }) {
  return {
    kind: 'note',
    noteKind,
    id: `note_${hash32(`${noteKind}:${title}:${body}`.slice(0, 200))}`,
    sessionId,
    project: project || '',
    title: String(title || '').slice(0, 120),
    body: String(body || '').slice(0, 4000),
    tags: Array.isArray(tags) ? tags.slice(0, 8).map(String) : [],
    at: Date.now(),
    origin: 'manual',
    weight,
    sessionsSeen: 1,
    sessionsSeenList: [sessionId],
    timesSeen: 1,
    active: true,
    staleReason: null,
    conflicts: [],
  };
}

function status() {
  const root = storeRoot();
  const runs = readAll(root, 'runs');
  const notes = readAll(root, 'notes');
  const state = loadState(root);
  const projects = new Map();
  for (const record of [...runs, ...notes]) {
    const key = record.project || '(none)';
    projects.set(key, (projects.get(key) || 0) + 1);
  }
  return {
    ok: true,
    home: homeDir(),
    storeDir: root,
    runs: runs.length,
    notes: notes.length,
    sessions: new Set(runs.map((run) => run.sessionId)).size,
    projects: [...projects.entries()].map(([project, count]) => ({ project, count })),
    lastDigestAt: state.lastDigestAt,
    recentDigests: (state.digests || []).slice(-5),
  };
}

// ---- settings -----------------------------------------------------------------
// Memory thresholds live in the store state, so they travel with the data to
// whichever drive it sits on. The context-window thresholds belong to
// billion-context (the HTTP compression proxy), so they are read from and
// written to that plugin's own config file: one page, two owners.
function memoryConfig() {
  return normalizeConfig(loadState(storeRoot()).config);
}

function saveMemoryConfig(patch) {
  const root = storeRoot();
  const state = loadState(root);
  state.config = normalizeConfig({ ...(state.config || {}), ...(patch || {}) });
  saveState(root, state);
  return state.config;
}

function biliConfigPath() {
  return process.env.BILI_CONFIG_FILE || path.join(os.homedir(), '.config', 'billion-context', 'billion-context.json');
}

function readBiliConfig() {
  try {
    return JSON.parse(fs.readFileSync(biliConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function contextSettings() {
  const compress = readBiliConfig().compress || {};
  const nudge = Number(compress.nudgeGrowthTokens);
  return {
    path: biliConfigPath(),
    nudgeGrowthTokens: Number.isFinite(nudge) && nudge > 0 ? nudge : 50000,
    // "60%" or a raw token count, exactly as billion-context spells it.
    maxContextLimit: compress.maxContextLimit ?? '75%',
    tierNudgeTokens: compress.tierNudgeTokens ?? null,
  };
}

function saveContextSettings(patch) {
  const file = biliConfigPath();
  const cfg = readBiliConfig();
  const compress = { ...(cfg.compress || {}) };
  if (patch?.nudgeGrowthTokens !== undefined) {
    const n = Number(patch.nudgeGrowthTokens);
    if (!Number.isFinite(n) || n < 1000 || n > 4000000) throw new Error('nudgeGrowthTokens must be 1000..4000000');
    compress.nudgeGrowthTokens = Math.round(n);
  }
  if (patch?.maxContextLimit !== undefined) {
    const raw = String(patch.maxContextLimit).trim();
    const ok = /^\d{1,3}%$/.test(raw) ? Number(raw.slice(0, -1)) <= 100 : Number(raw) > 0;
    if (!ok) throw new Error('maxContextLimit must be a percentage like "60%" or a positive token count');
    compress.maxContextLimit = /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  cfg.compress = compress;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return contextSettings();
}

function unitsPayload(query = {}) {
  const root = storeRoot();
  const config = memoryConfig();
  const notes = readAll(root, 'notes').filter(
    (note) => !query.project || query.project === '*' || note.project === query.project,
  );
  const built = buildUnits(notes, {
    config: { ...config, limit: Number(query.limit) || config.limit },
    query: query.q || query.query || '',
  });
  return { ok: true, storeDir: root, ...built, stats: { ...built.stats, runs: readAll(root, 'runs').length } };
}

// Snapshot of the compressed view, so "re-compress" produces a dated file next to
// the raw records instead of only a number in the UI.
function compactSnapshot() {
  const payload = unitsPayload({ limit: DEFAULT_CONFIG.limit });
  const file = path.join(storeRoot(), 'units.json');
  fs.mkdirSync(storeRoot(), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ generatedAt: Date.now(), config: payload.config, stats: payload.stats, units: payload.units }, null, 2)}\n`,
    'utf8',
  );
  return { ok: true, file, generatedAt: Date.now(), stats: payload.stats, config: payload.config };
}

function toolParameters(properties, required = []) {
  return { type: 'object', properties, additionalProperties: false, required };
}

// Every tool must declare how its structured result is turned into model text.
// Keeping one renderer (pretty JSON) means the schema stays the single source of
// truth for both validation and display.
function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function makeRouteHandler() {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    // Both prefixes land here: /dsh-rosemary-memory is canonical, /dsh-memory is
    // kept so old bookmarks and a stale client bundle keep working.
    const route = url.pathname.replace(/^\/dsh-(?:rosemary-)?memory/, '') || '/';
    const query = Object.fromEntries(url.searchParams.entries());
    try {
      if (route === '/' || route === '/status') {
        return jsonResponse(res, 200, status());
      }
      if (route === '/notes') {
        const root = storeRoot();
        const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
        const notes = readAll(root, 'notes')
          .filter((note) => !query.project || query.project === '*' || note.project === query.project)
          .sort((a, b) => (b.at || 0) - (a.at || 0))
          .slice(0, limit);
        return jsonResponse(res, 200, { ok: true, notes });
      }
      if (route === '/digest' && (req.method === 'POST' || req.method === 'GET')) {
        const body = req.method === 'POST' ? await readBody(req) : query;
        const dryRun = body.dryRun !== false && body.apply !== true;
        // The composer button never knows the project path; without a session id
        // or project it would otherwise sweep every session on the machine. Default
        // it to the most recently written session, which is the one on screen.
        const request = { ...body };
        if (request.all !== true && !request.sessionId && !request.project) {
          const newest = listSessions({ home: homeDir(), all: true, limit: 1 })[0];
          if (newest) request.sessionId = newest.id;
        }
        const payload = dryRun ? previewDigest(request) : applyDigest(request);
        return jsonResponse(res, 200, { ok: true, ...payload });
      }
      if (route === '/remember' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.title || !body.body) return jsonResponse(res, 400, { ok: false, error: 'title and body are required' });
        const note = makeNote(body);
        mergeNotes(storeRoot(), [note]);
        return jsonResponse(res, 200, { ok: true, note });
      }
      if (route === '/recall') {
        const root = storeRoot();
        const q = query.q || query.query || '';
        if (!q) return jsonResponse(res, 400, { ok: false, error: 'q is required' });
        const records = [...readAll(root, 'notes'), ...readAll(root, 'runs')];
        const items = recall(records, q, { limit: Number(query.limit) || 5, project: query.project });
        return jsonResponse(res, 200, { ok: true, query: q, items });
      }
      if (route === '/brief') {
        const result = brief(readAll(storeRoot(), 'notes'), { project: query.project, budgetTokens: Number(query.budget) || 1200 });
        return jsonResponse(res, 200, { ok: true, ...result });
      }
      if (route === '/units') {
        return jsonResponse(res, 200, unitsPayload(query));
      }
      if (route === '/compress' && req.method === 'POST') {
        return jsonResponse(res, 200, compactSnapshot());
      }
      if (route === '/settings' && req.method === 'GET') {
        return jsonResponse(res, 200, { ok: true, memory: memoryConfig(), context: contextSettings() });
      }
      if (route === '/settings' && req.method === 'POST') {
        const body = await readBody(req);
        const memory = body.memory ? saveMemoryConfig(body.memory) : memoryConfig();
        const context = body.context ? saveContextSettings(body.context) : contextSettings();
        return jsonResponse(res, 200, { ok: true, memory, context });
      }
      return jsonResponse(res, 404, { ok: false, error: `unknown route: ${route}` });
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: String(error?.message || error) });
    }
  };
}

export function apply(ctx, config = {}) {
  const disposers = [];

  // The bundle config wins over the default location, so the store can live on a
  // data drive without touching code (see dsh.bundle.patch.yml).
  configuredStoreDir = String(config?.storeDir || '');

  const tools = [
    {
      name: 'memory_digest',
      description:
        'Digest finished turns of this (or another) DSH session into durable memory records: one run per turn plus decision/fix notes. Deterministic and offline — no model call. Defaults to a dry run that only previews what would be written; pass dryRun:false to store. 中文：把已完成回合归纳成 run/note 记忆记录（离线、确定性），默认只预览不写入。',
      parameters: toolParameters(
        {
          dryRun: { type: 'boolean', description: 'Preview only (default true). Set false to write records.' },
          sessionId: { type: 'string', description: 'Digest only this session id. Default: every session of the project.' },
          project: { type: 'string', description: 'Project (session cwd) to digest. Default: none — the newest session is previewed unless sessionId, project or all is given.' },
          all: { type: 'boolean', description: 'Ignore the project filter and digest every session found.' },
          limit: { type: 'integer', description: 'Max sessions to inspect, newest first (default 40).' },
        },
        [],
      ),
      async execute(args = {}, exec) {
        // Deliberately not defaulted to the cwd: a digest that silently widened
        // scope to every session under a big project would be a surprise. Explicit
        // sessionId/project/all win; otherwise the newest session is previewed.
        const request = { ...args, project: args.project || '' };
        return args.dryRun === false ? applyDigest(request) : previewDigest(request);
      },
      output: textOutput(),
    },
    {
      name: 'memory_recall',
      description:
        'Search stored memory (runs and notes, across sessions) with deterministic scoring: exact term match, trigram similarity, recency, frequency, cross-session trust and manual weight. Returns scored snippets; an empty list means nothing scored above the floor rather than a padded guess. 中文：跨会话检索记忆记录，返回带评分与命中原由的片段。',
      parameters: toolParameters(
        {
          query: { type: 'string', description: 'What to look for: an error string, command, file name or topic.' },
          limit: { type: 'integer', description: 'Max results (default 5, max 20).' },
          project: { type: 'string', description: 'Restrict to one project, or "*" for all projects.' },
          floor: { type: 'number', description: 'Minimum score 0..1 (default 0.35).' },
        },
        ['query'],
      ),
      async execute(args = {}, exec) {
        const root = storeRoot();
        const records = [...readAll(root, 'notes'), ...readAll(root, 'runs')];
        const items = recall(records, args.query, {
          limit: args.limit,
          floor: args.floor,
          project: args.project,
        });
        return { ok: true, query: args.query, items };
      },
      output: textOutput(),
    },
    {
      name: 'memory_remember',
      description:
        'Store one explicit memory note (a fact, a preference, a decision) that should survive session deletion. This is the only way a model may write memory on its own initiative; digested runs are written by the button/tool. 中文：显式写入一条长期记忆（事实/偏好/决定）。',
      parameters: toolParameters(
        {
          title: { type: 'string', description: 'One-line headline.' },
          body: { type: 'string', description: 'The fact to remember, with enough context to be useful later.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          project: { type: 'string', description: 'Project this fact belongs to. Default: current working directory.' },
          weight: { type: 'number', description: 'Manual importance 0..1 (default 0.8), used by recall scoring.' },
        },
        ['title', 'body'],
      ),
      async execute(args = {}, exec) {
        const note = makeNote({ ...args, project: projectOf(exec, args), noteKind: 'manual' });
        mergeNotes(storeRoot(), [note]);
        return { ok: true, note };
      },
      output: textOutput(),
    },
    {
      name: 'memory_brief',
      description:
        'Return a small, budgeted brief of the most durable notes for a project (default 1200 tokens), meant to be injected once per session into the stable prefix. 中文：返回可注入稳定前缀的精简记忆摘要（默认 1200 token 预算）',
      parameters: toolParameters(
        {
          project: { type: 'string', description: 'Project to brief. Default: current working directory when it has memory, otherwise every project.' },
          budgetTokens: { type: 'integer', description: 'Token budget (default 1200).' },
        },
        [],
      ),
      async execute(args = {}, exec) {
        const root = storeRoot();
        const notes = readAll(root, 'notes');
        const budgetTokens = args.budgetTokens || 1200;
        const scoped = brief(notes, { project: args.project || projectOf(exec, args), budgetTokens });
        // A cwd that never produced memory would otherwise hand back an empty
        // brief; fall back to the whole store so durable context still arrives.
        const result = scoped.items.length || args.project ? scoped : brief(notes, { budgetTokens });
        return { ok: true, ...result };
      },
      output: textOutput(),
    },
  ];

  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool));
  }

  const handler = makeRouteHandler();
  const routes = [
    { kind: 'prefix', path: '/dsh-rosemary-memory', handler },
    { kind: 'prefix', path: '/dsh-memory', handler },
  ];

  const mountRoute = (sub) => {
    const server = sub?.webServer ?? sub;
    if (!server || typeof server.register !== 'function') return;
    const effect = typeof sub?.effect === 'function' ? sub.effect.bind(sub) : null;
    const registerAll = () => {
      const disposersForRoutes = routes.map((route) => server.register(route));
      return () => {
        for (const dispose of disposersForRoutes) dispose?.();
      };
    };
    const off = effect ? effect(registerAll, 'dsh-rosemary-memory routes') : registerAll();
    if (!effect) disposers.push(() => off?.());
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mountRoute);
  } else if (ctx.webServer !== undefined) {
    mountRoute({ webServer: ctx.webServer, effect: null });
  }

  const cleanup = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        // disposal must not throw during teardown
      }
    }
  };
  ctx.effect?.(() => cleanup);
  ctx.on?.('dispose', cleanup);
}
