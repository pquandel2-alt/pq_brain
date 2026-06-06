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

1. **At conversation start:** `curl -s http://localhost:3000/api/brain`
2. **Read all 7 nodes** (Start, User Profil, Feedback, Projekte, Ideen, Notizen, Referenzen)
3. **Use their content as context**
4. **When something changes:** Update via `PUT /api/nodes/:id` or `POST /api/nodes`
5. **Never re-derive** — if it's in a node, trust it

   <img width="1905" height="882" alt="grafik" src="https://github.com/user-attachments/assets/791b946f-ebd0-4c33-ba2d-6b86d745840a" />


## Standard 7 nodes included

- **Start** — Entry point explaining the system
- **User Profil** — User facts, environment, experience, GitHub account
- **Feedback** — What works, what to avoid, confirmed approaches
- **Projekte** — Active projects, goals, versions, status
- **Ideen** — Unvalidated ideas, future work
- **Notizen** — Technical patterns, architecture decisions, how-tos
- **Referenzen** — External pointers (APIs, tooling, GitHub repos)

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
