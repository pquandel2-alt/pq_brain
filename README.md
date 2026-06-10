
   <img width="600" height="313" alt="gemini-svg" src="https://github.com/user-attachments/assets/9b7ea5e0-b677-48bb-bd60-03615d7baa15" />

# pq_brain

A lightweight persistent memory server for AI agents. Also a 3D knowledge graph you can explore in any browser.

**Core idea:** Brain is the single source of truth for all long-term context. An AI agent reads it at the start of every session (automatically, via a SessionStart hook), uses the MCP tools to query and write back knowledge during the session, and never touches `.md` memory files again.

## Quick start

```bash
npm install
node server.js          # runs on port 3000 by default
# or: PORT=3002 node server.js
```

Open `http://localhost:3000` for the 3D knowledge graph.

## For AI agents (Claude Code)

Read [`CLAUDE.md`](./CLAUDE.md) — it contains full self-setup instructions the AI runs automatically on first connect.

**What happens automatically:**
1. Brain registers itself as a native MCP server (`claude mcp add --scope user --transport http brain http://localhost:3000/mcp`)
2. A SessionStart hook is added to `~/.claude/settings.json` — every session starts with a Brain briefing, no manual `curl` needed
3. Existing `.md` memory files are imported into Brain nodes and decommissioned
4. From that point on: `brain_recall`, `brain_get`, `brain_create_node` etc. are native tools

**TL;DR for any agent:**

```
brain_recall q="your question"        → start here, always
brain_get id="<id from recall>"       → drill into a node
brain_create_node label="..."         → write new knowledge
brain_update_node id="..." content="" → update existing
```

## MCP tools

Connect any MCP client via Streamable HTTP (`POST /mcp`) or stdio (`node mcp/stdio.js`).

| Tool | Description |
|------|-------------|
| `brain_recall` | **Start here.** Ranked summaries within a token budget (hybrid semantic + keyword). `rerank: true` for cross-encoder re-ranking (opt-in). |
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

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/recall?q=&budget=&limit=&rerank=` | **Ranked summaries within a token budget.** Primary entry point. |
| `GET` | `/api/brain` | Full or filtered graph `{ nodes, links, startNodeId }`. See query params below. |
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

## Auto-start on boot (systemd)

```bash
sudo ./setup-service.sh   # one-time setup
systemctl status pq-brain
journalctl -u pq-brain -f
```

## Data

- `data/brain.db` — live graph in SQLite (nodes + links + FTS5 + vectors); gitignored, WAL mode
- `data/backups/` — throttled JSON snapshots (no embeddings; restore via `POST /api/restore/:file`); gitignored
- Embeddings are stored in the DB and re-derivable any time (`npm run backfill`)

## Stack

Node.js · Express · **SQLite** (`better-sqlite3` + `sqlite-vec` + FTS5) · local embeddings (`@huggingface/transformers`, bge-m3, in-process) · **MCP** (`@modelcontextprotocol/sdk`, HTTP + stdio) · WebSocket (`ws`) · Vanilla JS frontend with 3D force-graph (Three.js)

**Hybrid memory (GraphRAG):** graph (relationships) + full-text (FTS5) + vectors (semantic) live in one embedded file. The 3D view is just a render of `nodes` + `links`.
