// Deterministic turn digester.
//
// Reads already-parsed transcript records and produces two kinds of records:
//   runs  — one per turn: what the user asked, which tools ran, what failed,
//           which files were touched, what conclusion the assistant reached
//   notes — durable one-liners worth recalling later (decisions, error->fix)
//
// No model call happens here on purpose: pressing the button is cheap, offline
// and repeatable, and the same transcript always yields the same records.
import { contentText } from './transcript.js';

const PSEUDO_USER_KINDS = new Set(['time-context', 'system-reminder', 'attachment', 'job-notification']);
const ERROR_RE = /(?:^|\n)\s*(?:error|fatal|exception|failed|failure|cannot|can't|unable|not found|not recognized|denied|traceback|exit code [1-9]|ENOENT|EACCES|EPERM|TypeError|SyntaxError|ReferenceError)/i;
const DECISION_RE = /(?:结论|根因|原因|决定|改用|选择|改成|必须|不要|注意[:：]|修复了|验证通过|原因是|chose|decided|because|root cause|instead of|must not)/i;
const PATH_KEYS = ['file_path', 'path', 'target', 'deckPath', 'pptxPath', 'filePath', 'outputDir', 'cwd', 'workdir'];
const COMMAND_KEYS = ['command', 'cmd', 'script', 'pattern', 'query', 'url'];

function hash32(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function describeCall(call) {
  const args = parseArgs(call.args);
  const detail = COMMAND_KEYS.map((key) => args[key]).find((value) => typeof value === 'string') || '';
  const file = PATH_KEYS.map((key) => args[key]).find((value) => typeof value === 'string') || '';
  return {
    name: String(call.name || 'unknown'),
    detail: clip(detail, 200),
    file: file ? clip(file, 160) : '',
  };
}

function resultError(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  for (const line of lines) {
    if (ERROR_RE.test(line)) return clip(line, 180);
  }
  return '';
}

function sentences(text) {
  return String(text || '')
    // Split on CJK terminators anywhere, and on ASCII ". ! ?" only when a space
    // follows — otherwise "0.216?" would break into "…升到 0." + "216?".
    .split(/(?<=[。！？；;])\s*|\n+|(?<=[.!?])\s+/)
    .map((part) => part.replace(/^[-–—•·*]\s+/, '').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 12 && part.length <= 240)
    // Markdown furniture is not a finding: table rows, tree glyphs and headings
    // would otherwise dominate the note list.
    .filter((part) => !/^[|├└│┌┐┘─━=+#>`]/.test(part))
    .filter((part) => (part.match(/\|/g) || []).length < 2)
    // A question is an open loop, not a decision: it would pollute recall with
    // "要不要我也顺便…" lines that never became true.
    .filter((part) => !/[?？]["'”’)\]]*\s*$/.test(part))
    // Talking about talking is not a finding either: these lead-ins are the
    // narrator clearing their throat before the actual statement.
    .filter((part) => !/^(我先说|我先讲|我直接说|先说结论|简单说|另外|补充一?点)/.test(part))
    // "结论是：X" keeps X — the label carries no information once the note is
    // already a decision.
    .map((part) => part.replace(/^(结论是|结论|判断|要点)[：:]\s*/, ''));
}

// Titles keep the words, not the markup: "**结论**" reads worse in a list than
// "结论".
function stripMd(text) {
  return String(text || '').replace(/\*\*|__|`/g, '').trim();
}

function pickConclusions(assistantTexts) {
  const seen = new Set();
  const out = [];
  for (const text of assistantTexts) {
    for (const sentence of sentences(text)) {
      if (!DECISION_RE.test(sentence)) continue;
      const key = sentence.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sentence);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

function tokenish(text) {
  return Math.max(1, Math.round(String(text || '').length / 3.5));
}

// records -> { runs, notes, stats }
export function digestRecords(records, meta) {
  const project = meta.project || '';
  const sessionId = meta.sessionId;
  const turns = [];
  let current = null;

  const flush = () => {
    if (current && (current.userText || current.calls.length)) turns.push(current);
    current = null;
  };

  for (const record of records) {
    const type = record?.type;
    const data = record?.data || {};
    if (type === 'turn/start') {
      flush();
      current = {
        turn: data.turn ?? turns.length + 1,
        at: record.time || Date.now(),
        userText: '',
        assistantTexts: [],
        calls: [],
        errors: [],
        files: new Set(),
      };
      continue;
    }
    if (!current) {
      if (type !== 'user/message') continue;
      current = { turn: 1, at: record.time || Date.now(), userText: '', assistantTexts: [], calls: [], errors: [], files: new Set() };
    }
    if (type === 'user/message') {
      const kind = data.source?.kind;
      if (kind && PSEUDO_USER_KINDS.has(kind)) continue;
      const text = contentText(data.content);
      if (text && !current.userText) current.userText = clip(text, 400);
      continue;
    }
    if (type === 'assistant/message') {
      const content = data.message?.content ?? data.content;
      const text = Array.isArray(content)
        ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
        : '';
      if (text.trim()) current.assistantTexts.push(text.trim());
      continue;
    }
    if (type === 'tool/call') {
      const described = describeCall({ name: data.name, args: data.arguments });
      if (described.file) current.files.add(described.file);
      current.calls.push({ ...described, step: data.step, callId: data.callId });
      continue;
    }
    if (type === 'tool/result') {
      const call = current.calls.find((entry) => entry.callId === data.toolCallId);
      const text = contentText(data.message?.content ?? data.content);
      const error = data.isError ? clip(text, 180) || 'tool reported an error' : resultError(text);
      if (call) call.ok = !error;
      if (error) {
        current.errors.push({ tool: call?.name || 'tool', signature: error });
      }
    }
  }
  flush();

  const runs = [];
  const notes = [];
  for (const turn of turns) {
    const conclusions = pickConclusions(turn.assistantTexts);
    const commands = turn.calls.filter((call) => call.detail).slice(0, 12).map((call) => `${call.name}: ${call.detail}`);
    const files = [...turn.files].slice(0, 12);
    const errors = turn.errors.slice(0, 6);
    const runId = `run_${hash32(`${sessionId}:${turn.turn}`)}`;
    const summary = conclusions.length
      ? conclusions
      : turn.assistantTexts.map((text) => clip(text, 200)).filter(Boolean).slice(-1);
    runs.push({
      kind: 'run',
      id: runId,
      sessionId,
      project,
      turn: turn.turn,
      at: turn.at,
      user: turn.userText,
      actions: turn.calls.slice(0, 20).map((call) => ({ name: call.name, detail: call.detail, file: call.file, ok: call.ok !== false })),
      commands,
      files,
      errors,
      conclusions,
      summary,
      tokens: tokenish([turn.userText, ...summary, ...commands].join(' ')),
    });

    for (const conclusion of conclusions.slice(0, 2)) {
      notes.push({
        kind: 'note',
        noteKind: 'decision',
        id: `note_${hash32(`decision:${conclusion.slice(0, 80)}`)}`,
        sessionId,
        project,
        title: clip(stripMd(conclusion), 90),
        body: stripMd(conclusion),
        tags: ['decision', ...files.slice(0, 3)],
        at: turn.at,
        origin: 'digest',
        weight: 0.6,
        sessionsSeen: 1,
        sessionsSeenList: [sessionId],
        timesSeen: 1,
        active: true,
        staleReason: null,
        conflicts: [],
        runId,
      });
    }

    // error -> later successful use of the same tool in this turn
    for (const failure of errors) {
      const later = turn.calls.find((call) => call.name === failure.tool && call.ok === true && call.detail);
      if (!later) continue;
      const title = `${failure.tool} 报错后改用：${clip(later.detail, 60)}`;
      notes.push({
        kind: 'note',
        noteKind: 'fix',
        id: `note_${hash32(`fix:${failure.signature.slice(0, 80)}:${later.detail.slice(0, 60)}`)}`,
        sessionId,
        project,
        title: clip(stripMd(title), 100),
        body: `失败：${failure.signature}\n可行：${later.detail}`,
        tags: ['fix', failure.tool, ...files.slice(0, 2)],
        at: turn.at,
        origin: 'digest',
        weight: 0.7,
        sessionsSeen: 1,
        sessionsSeenList: [sessionId],
        timesSeen: 1,
        active: true,
        staleReason: null,
        conflicts: [],
        runId,
      });
    }
  }

  return {
    runs,
    notes,
    stats: {
      sessionId,
      project,
      turns: turns.length,
      runs: runs.length,
      notes: notes.length,
      errors: runs.reduce((sum, run) => sum + run.errors.length, 0),
      tokens: runs.reduce((sum, run) => sum + run.tokens, 0),
    },
  };
}
