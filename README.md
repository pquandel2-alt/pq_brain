
<img width="300" height="113" alt="gemini-svg" src="https://github.com/user-attachments/assets/9b7ea5e0-b677-48bb-bd60-03615d7baa15" />

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300" width="100%" height="100%">
  <!-- Hintergrund für den Kontrast (Dark Mode) -->
  <rect width="100%" height="100%" fill="#0B0F19" rx="15"/>

  <!-- ICON: Der smarte Graph-Fokus -->
  <g transform="translate(30, 0)">
    <!-- Äußeres hexagonales Schutzfeld (feine Linien) -->
    <polygon points="150,50 236,100 236,200 150,250 64,200 64,100" fill="none" stroke="#1E293B" stroke-width="2"/>
    
    <!-- Graph-Verbindungen (Edges) -->
    <line x1="64" y1="100" x2="150" y2="150" stroke="#334155" stroke-width="1.5" />
    <line x1="236" y1="100" x2="150" y2="150" stroke="#334155" stroke-width="1.5" />
    <line x1="150" y1="50" x2="150" y2="150" stroke="#334155" stroke-width="2" stroke-dasharray="4"/>
    <line x1="64" y1="200" x2="150" y2="150" stroke="#00F5D4" stroke-width="1.5" stroke-opacity="0.5"/>
    <line x1="236" y1="200" x2="150" y2="150" stroke="#00F5D4" stroke-width="1.5" stroke-opacity="0.5"/>
    <line x1="150" y1="250" x2="150" y2="150" stroke="#00F5D4" stroke-width="2" stroke-opacity="0.7"/>

    <!-- Inaktive Rand-Knoten (Nodes) -->
    <circle cx="64" cy="100" r="5" fill="#475569" />
    <circle cx="236" cy="100" r="5" fill="#475569" />
    <circle cx="150" cy="50" r="6" fill="#64748B" />
    
    <!-- Aktive, semantische Knoten (BGE-M3 Treffer) -->
    <circle cx="64" cy="200" r="6" fill="#00F5D4" />
    <circle cx="236" cy="200" r="6" fill="#00F5D4" />
    <circle cx="150" cy="250" r="7" fill="#00F5D4" />

    <!-- Der zentrale Fokus-Kern (/api/recall Leuchten) -->
    <circle cx="150" cy="150" r="16" fill="#00F5D4" opacity="0.15"/>
    <circle cx="150" cy="150" r="10" fill="#00F5D4" opacity="0.4"/>
    <circle cx="150" cy="150" r="5" fill="#FFFFFF" />
  </g>

  <!-- TYPOGRAFIE: Clean & Enterprise-Ready -->
  <g font-family="system-ui, -apple-system, sans-serif" transform="translate(300, 165)">
    <!-- "pq_" - dünner, technischer Prefix -->
    <text x="0" y="0" font-size="54" font-weight="200" fill="#94A3B8" letter-spacing="2">pq_</text>
    <!-- "brain" - markant, stark, zentriert -->
    <text x="85" y="0" font-size="54" font-weight="800" fill="#F8FAFC" letter-spacing="1">brain</text>
    <!-- Untertitel / Slogan -->
    <text x="5" y="35" font-size="14" font-weight="500" fill="#00F5D4" letter-spacing="6" opacity="0.9">HYBRID KNOWLEDGE LAYER</text>
  </g>
</svg>

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

1. **At conversation start:** Load only the start node + direct neighbors (~77% fewer tokens)
   ```bash
   curl -s "http://localhost:3000/api/brain?smart=true&depth=1"
   ```
2. **Load project details on demand** using tags or search:
   ```bash
   curl -s "http://localhost:3000/api/brain?tags=homeassistant"
   curl -s "http://localhost:3000/api/brain?search=thermostat"
   ```
3. **Use node content as context**
4. **When something changes:** Update via `PUT /api/nodes/:id` or `POST /api/nodes`
5. **Never re-derive** — if it's in a node, trust it

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
| `GET` | `/api/brain` | `?smart=true&depth=N` / `?tags=x,y` / `?search=q` | Filtered or full graph `{ nodes, links }` |
| `POST` | `/api/nodes` | `{ label, type, content, tags }` | Create node |
| `PUT` | `/api/nodes/:id` | partial node fields | Update node (merges) |
| `DELETE` | `/api/nodes/:id` | — | Delete node + its links |
| `POST` | `/api/links` | `{ source, target, label? }` | Link two nodes |
| `DELETE` | `/api/links` | `{ source, target }` | Remove a link |
| `POST` | `/api/import` | `{ dirPath }` | Import `.md` files with YAML frontmatter |

### Query parameters for `GET /api/brain`

| Parameter | Example | Description |
|-----------|---------|-------------|
| `smart=true` | `?smart=true` | Start node + all transitively reachable nodes |
| `smart=true&depth=N` | `?smart=true&depth=1` | Start node + neighbors up to N hops (1 = direct neighbors only) |
| `tags=x,y` | `?tags=homeassistant` | Only nodes matching any of the given tags |
| `search=q` | `?search=thermostat` | Nodes whose label or content contains the query |

**Recommended workflow:** Start with `depth=1` (~1.250 tokens), then load details with `?tags=<project>` as needed.

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

- `data/brain.json` — live graph (gitignored, create from `brain.example.json`)
- `data/brain.example.json` — template with starter nodes for AI agent use

## Stack

Node.js · Express · WebSocket (`ws`) · Vanilla JS frontend with 3D force-graph
