
   <img width="600" height="313" alt="gemini-svg" src="https://github.com/user-attachments/assets/9b7ea5e0-b677-48bb-bd60-03615d7baa15" />

# pq_brain

A lightweight persistent memory server for AI agents. Also a 3D knowledge graph you can explore in any browser.

**Core idea:** Brain is the single source of truth for all long-term context. Any AI agent reads it at the start of a session (via MCP, the `GET /api/briefing` endpoint, or — for Claude Code — an automatic SessionStart hook), queries and writes back knowledge during the session, and never touches `.md` memory files again.

**Works with any AI:** three access surfaces over the same data — **REST** for direct integrations, **MCP** (`/mcp`) for agent frameworks, and **`/api/tools`** for function-calling clients (OpenAI-format included). Machine-readable contract at `GET /openapi.json`. Per-client wiring (Claude Code, ChatGPT, OpenAI SDK, LangChain, Gemini/Cursor) lives in [`INTEGRATIONS.md`](./INTEGRATIONS.md).

## Quick start

**Linux (Ubuntu / Debian) — recommended:**

```bash
git clone https://github.com/pquandel2-alt/pq_brain.git
cd pq_brain
chmod +x install.sh
./install.sh
```

`install.sh` installs Node.js 22, build tools, npm dependencies, and (optionally) the systemd service so Brain auto-starts on boot. It also offers to install **Ollama + Auto-Capture** — fully local knowledge extraction from AI sessions, no cloud account needed. Choose your model from a menu (qwen2.5:3b, llama3.2:3b, phi4-mini, mistral:7b or custom).

**Docker — Brain only:**

```bash
docker compose up -d
```

**Docker — Brain + Ollama (fully local, no cloud):**

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d

# Pick a different model (default: qwen2.5:3b):
BRAIN_CAPTURE_OLLAMA_MODEL=llama3.2:3b \
  docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d
```

**Manual (Node.js 22+ already installed):**

```bash
npm install
node server.js          # port 3000 by default
```

Open `http://localhost:3000` for the 3D knowledge graph.

## For AI agents

The same workflow works for every agent, regardless of how it connects:

```
briefing                              → optional: one-shot session context
recall  q="your question"             → start here, always
get     id="<id from recall>"         → drill into a node
create  label="..."                   → write new knowledge
update  id="..." content="..."        → update existing
```

These map to the `brain_*` MCP tools, the `/api/*` REST endpoints, and the `/api/tools` function schemas — pick whichever surface your client speaks.

**Setup per client** — see [`INTEGRATIONS.md`](./INTEGRATIONS.md):

- **Claude Code** registers Brain as a native MCP server and adds a SessionStart hook (see [`AI-AGENT-SETUP.md`](./AI-AGENT-SETUP.md) / [`CLAUDE.md`](./CLAUDE.md)).
- **ChatGPT** imports `GET /openapi.json` as a Custom GPT Action.
- **OpenAI SDK / LangChain** load tools from `GET /api/tools?format=openai` (runnable examples in [`examples/`](./examples)).
- **Gemini CLI / Cursor / Windsurf** point at the `/mcp` endpoint or `mcp/stdio.js`.

## MCP tools

Connect any MCP client via Streamable HTTP (`POST /mcp`) or stdio (`node mcp/stdio.js`). 17 tools total — the full machine-readable list (JSON Schema or OpenAI format) is served at `GET /api/tools`. The most-used:

| Tool | Description |
|------|-------------|
| `brain_briefing` | Session start context (start node + linked context + stats) as compact Markdown — one call instead of recall+get. |
| `brain_recall` | **Start here.** Ranked summaries within a token budget (hybrid semantic + keyword). `rerank: true` for cross-encoder re-ranking (opt-in). `charsPerToken` calibrates the budget estimate. |
| `brain_search` | Compact ranked list — `id, label, type, score`. Modes: `hybrid` (default), `semantic`, `keyword`. |
| `brain_index` | Bare index: all nodes as `id, label, type, tags` — cheapest orientation. |
| `brain_get` | Full node content + lifecycle fields. Call after recall for the full text. |
| `brain_history` | Version history of a node. |
| `brain_create_node` | Create a node. Semantic dedup runs automatically; `force: true` to override. Supports `ttl` (seconds) for ephemeral nodes. |
| `brain_update_node` | Update a node. Auto-versions + re-embeds. |
| `brain_link` | Link two nodes (optional typed edge, e.g. `supersedes`, `depends-on`). |

## 3D GUI

The browser UI at `http://localhost:3000` shows the live knowledge graph in 3D.

**Live highlights:**
- **Start node** — always glows warm gold, pulses permanently
- **Accessed nodes** — glow white for 3s whenever a node is read via API or MCP tool
- **Action log** — collapsible panel (bottom-right) shows real-time activity: reads, creates, updates, links

All highlights are driven by WebSocket events — the graph updates live as the AI works.

   <img width="1905" height="882" alt="grafik" src="https://github.com/user-attachments/assets/791b946f-ebd0-4c33-ba2d-6b86d745840a" />

## Auto-Capture

Brain can automatically extract knowledge from Claude Code session transcripts and queue it as **Inbox candidates** for your review. No manual brain_create_node calls needed after a session.

**How it works:**
1. At session end, `examples/hooks/brain-capture.sh` reads the transcript, asks a model to extract durable knowledge (decisions, preferences, solved problems), and sends it to `POST /api/inbox`.
2. Candidates land as normal nodes tagged `inbox` with a TTL — visible in the **📥 Inbox** button in the GUI.
3. You review each candidate: **accept** (becomes a permanent node) or **discard** (deleted). Every decision is logged as a labeled training example.
4. Items never reviewed expire automatically via TTL (logged as `expired`).

**Install (Claude Code):**

```bash
cp examples/hooks/brain-capture.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/brain-capture.sh
```

Register in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/brain-capture.sh" } ] }
    ]
  }
}
```

**Backend options** — default uses Claude (covered by your Claude Code subscription). Switch to a local model via env var:

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_CAPTURE_BACKEND` | `claude` | `claude` or `ollama` |
| `BRAIN_CAPTURE_MODEL` | `haiku` | Claude model (when backend=claude) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `BRAIN_CAPTURE_OLLAMA_MODEL` | `qwen2.5:3b` | Ollama model name |
| `BRAIN_CAPTURE_OLLAMA_TIMEOUT` | `1800` | Max seconds for local inference |
| `BRAIN_CAPTURE_MIN_MESSAGES` | `10` | Skip sessions shorter than this |
| `BRAIN_CAPTURE_MAX_CHARS` | `30000` | Transcript chars sent to the model |

The hook is fail-silent — any error exits cleanly without blocking the session.

**Training data:** Every inbox review decision is stored in `inbox_decisions` (SQLite). Export for fine-tuning:

```bash
curl -s 'http://localhost:3000/api/inbox/decisions?format=jsonl'
# → one JSON line per decision: { label, content, summary, decision: "accepted|rejected|expired", ... }
```

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/recall?q=&budget=&limit=&rerank=&charsPerToken=` | **Ranked summaries within a token budget.** Primary entry point. `charsPerToken` (1–20, default 4) calibrates the budget *estimate*. |
| `GET` | `/api/briefing?format=md\|json&budget=` | Session start context (start node + linked context + stats). Same logic as the `brain_briefing` tool. |
| `GET` | `/api/tools?format=openai` | Tool catalog as JSON Schema (default) or OpenAI function-calling format. |
| `GET` | `/openapi.json` · `/openapi.yaml` | Machine-readable OpenAPI 3.1 contract (version tracks `package.json`). |
| `GET` | `/api/brain` | Full or filtered graph `{ nodes, links, startNodeId, pagination }`. See query params below. |
| `GET` | `/api/brain/health-report` | Orphans, duplicate labels, dead wikilinks, never-accessed, expiring-soon |
| `GET` | `/api/nodes/:id` | Full node incl. lifecycle + `ttl/expires_at`. Counts access (triggers GUI glow). |
| `GET` | `/api/nodes/:id/history` | Version history |
| `POST` | `/api/nodes/:id/revert/:version` | Revert to / undelete a past version |
| `POST` | `/api/nodes` | Create node (409 on duplicate/near-duplicate). `ttl` (seconds) = ephemeral. |
| `PUT` | `/api/nodes/:id` | Update — partial merge, auto-versioning + re-embedding |
| `DELETE` | `/api/nodes/:id` | Delete node + its links |
| `POST` | `/api/links` | `{ source, target, label?, type? }` — typed edges supported |
| `DELETE` | `/api/links` | `{ source, target }` |
| `POST` | `/api/import` | Import `.md` files with YAML frontmatter from a directory path |
| `GET` | `/api/inbox` | List open inbox candidates (tag `inbox`, with TTL + source) |
| `POST` | `/api/inbox` | Submit capture candidates `{ session_id, nodes[] }` — dedup active |
| `POST` | `/api/inbox/:id/accept` | Accept candidate: removes `inbox` tag + TTL |
| `GET` | `/api/inbox/decisions?limit=&format=json\|jsonl` | Export review decisions as training data |
| `POST` | `/api/restore/:filename` | Restore from a backup snapshot |
| `POST` | `/mcp` | MCP Streamable HTTP endpoint |
| `GET` | `/api/health` | Server status, uptime, node/link counts |

### Query parameters for `GET /api/brain`

| Parameter | Description |
|-----------|-------------|
| `?smart=true&depth=N` | Start node + neighbors up to N hops |
| `?q=` | Hybrid search (semantic + keyword, RRF), ranked with `score` |
| `?semantic=` | Pure semantic (vector) search |
| `?tags=x,y` | Nodes matching any of the given tags |
| `?search=q` | Substring match on label/content |
| `?view=index` | Bare index: `id,label,type,tags` (no content, ~70% smaller) |
| `?fields=a,b` | Project nodes to specific fields |
| `?limit=N&offset=M` | Pagination for listing modes (not search). Default limit 1000; **`limit=0` returns all**. Response carries `pagination: { total, returned, limit, offset }`. |

### Error format

All errors return an HTTP status plus a stable JSON shape — `{ "error": "message", "code": "..." }`. Codes per class: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `LABEL_EXISTS` / `SIMILAR_EXISTS` (409), `INTERNAL_ERROR` (500). The `409` bodies also include `existing` / `similar` + `similarity`.

## WebSocket

Connect to `ws://localhost:3000`:

| Message | When |
|---------|------|
| `{ type: "update", data }` | After every graph change; includes `startNodeId` |
| `{ type: "access", nodeIds }` | When nodes are read — triggers white glow in the GUI |
| `{ type: "log", action, labels, ts }` | Activity entry for the action log (read / created / updated / deleted / linked / unlinked) |

## Node shape

```json
{
  "id": "uuid-auto-generated",
  "label": "Unique display name (also the wikilink anchor)",
  "type": "memory | note | idea | project | reference",
  "content": "Markdown — what the AI reads",
  "tags": ["optional", "tags"],
  "summary": "1–2 line preview used by recall (optional but saves tokens)",
  "ttl": 3600,
  "created": "ISO timestamp"
}
```

## Node types

| Type | Purpose |
|------|---------|
| `memory` | User facts, preferences, feedback received |
| `project` | Active projects — goal, path, status |
| `reference` | External pointers: URLs, file paths, dashboards |
| `note` | Technical patterns, decisions, how-tos |
| `idea` | Unvalidated ideas, future work |

## Ephemeral nodes (TTL)

Short-term memory without polluting the graph:

```bash
curl -X POST http://localhost:3000/api/nodes -H 'Content-Type: application/json' \
  -d '{"label":"Session context","type":"note","content":"...","ttl":3600}'
```

The node gets an `expires_at` timestamp, is filtered from all reads once expired, and deleted by a 60-s cleanup loop. `PUT { "ttl": null }` makes it permanent.

## Importing from Markdown files

```bash
curl -X POST http://localhost:3000/api/import \
  -H "Content-Type: application/json" \
  -d '{"dirPath": "/path/to/your/markdown/folder"}'
```

Frontmatter fields recognized: `name`, `title`, `type`, `tags`. `[[wikilinks]]` in the content are resolved to graph edges automatically.

## Cross-encoder re-ranking (opt-in)

`/api/recall?q=…&rerank=true` (or MCP `brain_recall` with `rerank: true`) re-ranks candidates with a local cross-encoder (`bge-reranker-base`, q8, lazy-loaded). Off by default — on a small, topically distinct graph the hybrid RRF is already optimal. Useful once the graph holds many similar nodes. Configurable via `BRAIN_RERANK_MODEL` / `BRAIN_RERANK_DTYPE`.

## Configuration

All settings have sensible defaults — Brain runs with zero config. To override, copy `.env.example` to `.env` (loaded automatically) or set environment variables. Everything mutable hangs off **`BRAIN_DATA_DIR`** (DB, backups, logs, model cache) so the install is fully portable. See `.env.example` for the full list.

## Docker

```bash
docker compose up -d            # builds the image, starts on port 3000
```

Data, backups, logs and the model cache live in the named volume `brain-data`, so restarts and image rebuilds keep the same state. The **first** start downloads the embedding model (bge-m3) into the volume and can take 1–2 minutes — the healthcheck allows for this with a 180-s start period; afterwards it is cached.

## Auto-start on boot (systemd)

```bash
sudo ./setup-service.sh   # one-time; auto-detects user + path, no hardcoded host
systemctl status pq-brain
journalctl -u pq-brain -f
```

The installer fills the service template with the current user and directory and creates an optional `/etc/default/pq-brain` (from `.env.example`) for environment overrides.

## Data

- `data/brain.db` — live graph in SQLite (nodes + links + FTS5 + vectors); gitignored, WAL mode
- `data/backups/` — throttled JSON snapshots (no embeddings; restore via `POST /api/restore/:file`); gitignored
- Embeddings are stored in the DB and re-derivable any time (`npm run backfill`)

## Stack

Node.js · Express · **SQLite** (`better-sqlite3` + `sqlite-vec` + FTS5) · local embeddings (`@huggingface/transformers`, bge-m3, in-process) · **MCP** (`@modelcontextprotocol/sdk`, HTTP + stdio) · WebSocket (`ws`) · Vanilla JS frontend with 3D force-graph (Three.js)

**Hybrid memory (GraphRAG):** graph (relationships) + full-text (FTS5) + vectors (semantic) live in one embedded file. The 3D view is just a render of `nodes` + `links`.
