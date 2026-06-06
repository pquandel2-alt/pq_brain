# pq_brain

A lightweight persistent memory server for AI agents — and a 3D knowledge graph you can browse in any browser.

**Core idea:** An AI agent reads `GET /api/brain` at the start of every conversation and uses the node contents as long-term context. When it learns something new, it writes back via the REST API. The graph persists across conversations, sessions, and model resets.

## Quick start

```bash
npm install
cp data/brain.example.json data/brain.json
node server.js          # runs on port 3000 by default
# or: PORT=3002 node server.js
```

Open `http://localhost:3000` in a browser for the 3D visualization.

## How an AI agent uses this

1. **Read at conversation start**
   ```bash
   curl -s http://localhost:3000/api/brain
   ```
   Every node's `content` field is Markdown — treat it as context.

2. **Write when something changes**
   - New fact learned → `POST /api/nodes`
   - Existing node outdated → `PUT /api/nodes/:id`
   - Fact no longer relevant → `DELETE /api/nodes/:id`
   - Two concepts are related → `POST /api/links`

3. **Never re-derive what's already stored** — if it's in a node, trust it (but verify against the live environment when acting on it).

For Claude Code specifically: see [`CLAUDE.md`](./CLAUDE.md).

## REST API

| Method | Path | Body / Query | Description |
|--------|------|-------------|-------------|
| `GET` | `/api/brain` | — | Full graph `{ nodes, links }` |
| `POST` | `/api/nodes` | `{ label, type, content, tags }` | Create node |
| `PUT` | `/api/nodes/:id` | partial node fields | Update node (merges) |
| `DELETE` | `/api/nodes/:id` | — | Delete node + its links |
| `POST` | `/api/links` | `{ source, target, label? }` | Link two nodes |
| `DELETE` | `/api/links` | `{ source, target }` | Remove a link |
| `POST` | `/api/import` | `{ dirPath }` | Import `.md` files with YAML frontmatter |

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

## WebSocket

Connect to `ws://localhost:3000` — you receive the full graph on connect and a `{ type: "update", data }` message on every change.

## Setup tip: auto-start on boot

```bash
# Add to crontab: crontab -e
@reboot cd /path/to/pq_brain && node server.js >> brain.log 2>&1 &
```

## Data

- `data/brain.json` — live graph (gitignored, create from `brain.example.json`)
- `data/brain.example.json` — template with starter nodes for AI agent use

## Stack

Node.js · Express · WebSocket (`ws`) · Vanilla JS frontend with 3D force-graph
