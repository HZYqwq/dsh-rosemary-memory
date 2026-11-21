# Cross-session memory (dsh-memory)

## What it is

Click 🧠 Memory in the left sidebar for a full page: the top half is **weighted, compressed** cross-session memory (near-duplicate notes merged, weights explainable), the 阈值 tab edits the re-compression thresholds and bili's context thresholds. Digests are deterministic run/note records; later, from any session, recall them by error string, command or file name. No model call, no server, no transcript rewriting.

## Why

bili (billion-context) compresses context *inside* a session: its folded summaries die with the session. dsh-memory keeps a searchable layer *outside* the session, so a trap hit in one session is findable from the next.

## How to use it

1. **Sidebar page**: 🧠 Memory in the left sidebar opens the weighted memory list (playbooks first, expandable to the notes they folded). The 阈值 tab edits both threshold groups.
2. **Two header buttons**: 归纳新回合 digests finished turns (newest session by default; `all:true` sweeps everything — deterministic, no model call); 重新压缩 re-clusters notes and writes a `data/units.json` snapshot.
3. **Tools**: `memory_digest` (dry-run by default), `memory_recall`, `memory_remember`, `memory_brief`.
4. **HTTP**: `GET /dsh-memory/status`, `POST /dsh-memory/digest`, `GET /dsh-memory/recall?q=`, `GET /dsh-memory/brief`, `GET /dsh-memory/notes`, `POST /dsh-memory/remember`, `GET /dsh-memory/units?q=`, `POST /dsh-memory/compress`, `GET|POST /dsh-memory/settings`.

Without a session id the button digests only the most recently written session, never the whole machine.

## Where the data lives

- Read: `<DSH_HOME>/sessions/<project>/<session-id>/session.v4.jsonl.zstd` (multi-frame zstd, JSONL). Read-only.
- Write: `<plugin>/data/` (on this machine `D:\deepseek\dsh-memory\data`) → `runs.jsonl`, `notes.jsonl`, `state.json`. Append-only, greppable. Override with `DSH_MEMORY_DIR` or the bundle config `storeDir`; by default nothing lands on C:.

## Scoring

```
0.40 exact + 0.15 trigram + 0.15 recency (30d half-life)
+ 0.10 frequency (log) + 0.10 cross-session trust (1-0.5^sessionsSeen) + 0.10 manual weight
- 0.20 conflict - 0.15 staleness
```

Hard filters: project, `active`, `staleReason`. Below `0.35` returns an empty list instead of padding.

## Known limits

- Extraction is rule-based (questions, markdown table rows and tree glyphs are filtered out); it is not a model summary.
- No vectors in v1; two-character CJK terms fall back to substring matching.
- The transcript is never written back; deleting `runs.jsonl` / `notes.jsonl` clears memory.
