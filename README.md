# pq_brain

A lightweight persistent memory server for AI agents. Also a 3D knowledge graph you can explore in any browser.

**Core idea:** An AI agent reads the entire knowledge graph at the start of every conversation and uses all node content as long-term context. When it learns something new, it writes back via REST API. The graph persists across conversations, sessions, and model resets.

**This is the single source of truth for project context.**

## Quick start

```bash
npm install
cp data/brain.example.json data/brain.json
node server.js          # runs on port 3000 by default
# or: PORT=3002 node server.js
```

Open `http://localhost:3000` in a browser for the 3D visualization + file explorer.

## For AI agents

Read [`CLAUDE.md`](./CLAUDE.md) first — it explains the entire workflow. Also [`AI-AGENT-SETUP.md`](./AI-AGENT-SETUP.md) for external agents using this repo.

**TL;DR:**

0. **Orientation (cheapest):** Load the whole graph as a bare index — only `id`, `label`, `type`, `tags`, no `content` (~70% smaller than the full graph)
   ```bash
   curl -s "http://localhost:3000/api/brain?view=index"
   ```
1. **At conversation start:** Load only the start node + direct neighbors (~77% fewer tokens)
   ```bash
   curl -s "http://localhost:3000/api/brain?smart=true&depth=1"
   ```
2. **Have a concrete question? Use recall (cheapest path):** ranked summaries within a token budget, then drill into one node for the full text:
   ```bash
   curl -s "http://localhost:3000/api/recall?q=Wie+steuere+ich+die+Heizung&budget=2000"
   curl -s "http://localhost:3000/api/nodes/<id>"
   ```
3. **Load details on demand** — semantic, hybrid, tags, or substring:
   ```bash
   curl -s "http://localhost:3000/api/brain?semantic=Klimasteuerung"   # meaning-based
   curl -s "http://localhost:3000/api/brain?q=Heizung+Temperatur"      # hybrid
   curl -s "http://localhost:3000/api/brain?tags=homeassistant"
   ```
4. **Use node content as context**
5. **When something changes:** Update via `PUT /api/nodes/:id` or `POST /api/nodes`
6. **Never re-derive** — if it's in a node, trust it

> **MCP:** Brain is also an MCP server — connect any MCP client via Streamable HTTP (`POST /mcp`) or stdio (`node mcp/stdio.js`) and use the tools `brain_recall`, `brain_search`, `brain_get`, `brain_create_node`, … (start with `brain_recall`).

   <img width="1905" height="882" alt="grafik" src="https://github.com/user-attachments/assets/791b946f-ebd0-4c33-ba2d-6b86d745840a" />


## Starter nodes (brain.example.json)

The included example graph contains these starter nodes — adapt to your own projects:

- **Claude – Startpunkt** — Entry point for AI agents, links to everything else
- **User Profil** — User facts, environment, experience
- **Coding-Präferenzen** — Preferences, confirmed approaches, what to avoid
- **Projekte** — Hub linking all active project nodes
- **Ideen** — Unvalidated ideas, future work

Add your own nodes freely — the graph grows with your projects.

## REST API

| Method | Path | Body / Query | Description |
|--------|------|-------------|-------------|
| `GET` | `/api/recall` | `?q=&budget=&limit=&rerank=` | **Ranked summaries within a token budget — the primary entry.** `rerank=true` (opt-in) re-ranks with a cross-encoder |
| `GET` | `/api/brain` | `?q=` / `?semantic=` / `?smart=&depth=N` / `?tags=` / `?search=` / `?view=index` | Filtered/ranked or full graph `{ nodes, links, startNodeId }` |
| `GET` | `/api/brain/health-report` | — | Orphans, duplicate labels, dead wikilinks, never-accessed, expiring-soon |
| `GET` | `/api/nodes/:id` | — | One node, full (incl. `summary` + lifecycle + `ttl`/`expires_at`); counts access |
| `GET` | `/api/nodes/:id/history` | — | Version history |
| `POST` | `/api/nodes/:id/revert/:version` | — | Revert to / undelete a past version |
| `POST` | `/api/nodes` | `{ label, type, content, tags, summary?, source?, ttl? }` `?force=` | Create node (409 on duplicate/near-duplicate). `ttl` (seconds) = ephemeral node |
| `PUT` | `/api/nodes/:id` | partial node fields | Update (versions + re-embeds) |
| `DELETE` | `/api/nodes/:id` | — | Delete node + its links |
| `POST` | `/api/links` | `{ source, target, label?, type? }` | Link two nodes (optional typed edge) |
| `DELETE` | `/api/links` | `{ source, target }` | Remove a link |
| `POST` | `/api/import` | `{ dirPath }` | Import `.md` files with YAML frontmatter |
| `POST` | `/mcp` | MCP (Streamable HTTP) | Native tools for any MCP client (also stdio: `node mcp/stdio.js`) |

### Query parameters for `GET /api/brain`

| Parameter | Example | Description |
|-----------|---------|-------------|
| `q=` | `?q=Heizung+Temperatur` | **Hybrid search** (semantic + keyword, RRF), ranked with `score` |
| `semantic=` | `?semantic=Klimasteuerung&limit=5` | **Pure semantic** (vector) search, ranked with `score` |
| `smart=true&depth=N` | `?smart=true&depth=1` | Start node + neighbors up to N hops |
| `tags=x,y` | `?tags=homeassistant` | Only nodes matching any of the given tags |
| `search=q` | `?search=thermostat` | Substring match on label/content |
| `view=index` | `?view=index` | Bare index: `id,label,type,tags` (no `content`). Combinable. |
| `fields=a,b` | `?fields=id,label` | Project nodes to the given fields. |

**Recommended workflow:** `?view=index` for orientation → `/api/recall?q=…` for a concrete question (cheapest) → `GET /api/nodes/:id` for the full text of a hit.

**Note:** `POST /api/nodes` returns `409` for a duplicate label *or* a semantic near-duplicate (labels are wikilink anchors and must be unique); pass `?force=true` to override.

### Node shape

```json
{
  "id": "uuid-auto-generated",
  "label": "Short display name",
  "type": "memory | note | idea | project | reference",
  "content": "Markdown content — this is what the AI reads",
  "tags": ["optional", "tags"],
  "created": "ISO timestamp"
}
```

### Node types

| Type | Purpose |
|------|---------|
| `memory` | User facts, preferences, feedback received |
| `project` | Active projects — goal, path, status |
| `reference` | External pointers: URLs, file paths, dashboards |
| `note` | Technical patterns, decisions, how-tos |
| `idea` | Unvalidated ideas, future work |

## Importing from Markdown files

Drop `.md` files with YAML frontmatter into any directory and import them:

```bash
curl -X POST http://localhost:3000/api/import \
  -H "Content-Type: application/json" \
  -d '{"dirPath": "/path/to/your/markdown/folder"}'
```

Frontmatter fields recognized: `name`, `title`, `type`, `tags`. `[[wikilinks]]` in the content are resolved to graph edges automatically.

## Ephemeral nodes (TTL)

Short-term memory without polluting the graph: pass `ttl` (seconds) when creating a node.
It gets an `expires_at` timestamp, is hidden from all read paths once expired, and is deleted
by a 60-s cleanup loop. `PUT { "ttl": null }` makes a node permanent again.

```bash
curl -X POST http://localhost:3000/api/nodes -H 'Content-Type: application/json' \
  -d '{"label":"Scratch","type":"note","content":"session context","ttl":3600}'
```

## Cross-encoder re-ranking (opt-in)

`/api/recall?q=…&rerank=true` (or MCP `brain_recall` with `rerank:true`) re-ranks the hybrid
candidates with a local cross-encoder (`bge-reranker-base`, q8, lazy-loaded). **Off by default:**
on a small, topically distinct graph the hybrid RRF is already optimal and re-ranking only adds
latency. It becomes valuable once the graph holds many *similar* nodes. Configurable via
`BRAIN_RERANK_MODEL` / `BRAIN_RERANK_DTYPE`.

## WebSocket

Connect to `ws://localhost:3000` — on connect you receive the full graph (incl. `startNodeId`).
- `{ type: "update", data }` on every change (also carries `startNodeId`).
- `{ type: "access", nodeIds }` when nodes are recalled/searched/fetched — the 3D view lights
  them up briefly (the start node stays lit permanently).

## Auto-start on boot (systemd service)

Brain runs as a systemd service so it restarts automatically after server reboots.

**Setup (one-time):**
```bash
sudo ./setup-service.sh
```

**Verify:**
```bash
systemctl status pq-brain
journalctl -u pq-brain -f    # view live logs
```

**Manual control:**
```bash
systemctl restart pq-brain
systemctl stop pq-brain
systemctl disable pq-brain   # disable auto-start
```

## Data

- `data/brain.db` — live graph in **SQLite** (nodes + links + FTS5 + vectors); gitignored, WAL mode
- `data/backups/*.json` — throttled human-readable snapshots (no embeddings; restore via `POST /api/restore/:file`)
- `data/brain.json` — legacy seed / one-time migration source (`npm run migrate`)
- Embeddings are stored in the DB and re-derivable any time (`npm run backfill`)

## Stack

Node.js · Express · **SQLite** (`better-sqlite3` + `sqlite-vec` + FTS5) · local embeddings
(`@huggingface/transformers`, bge-m3, in-process) · **MCP** (`@modelcontextprotocol/sdk`, HTTP + stdio) ·
WebSocket (`ws`) · Vanilla JS frontend with 3D force-graph

**Hybrid memory (GraphRAG):** the graph (relationships) + full-text (FTS5) + vectors (semantic)
live in one embedded file. The 3D view is just a render of `nodes` + `links`.
