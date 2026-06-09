# Brain – AI Agent Instructions

**READ THIS FIRST.** This file tells you what to do. Every conversation with this system starts the same way.

## Your job: read Brain, work, write back

1. **At conversation start:** Fetch the full knowledge graph
2. **Use the content:** Every node's `content` field is Markdown — treat it as long-term context
3. **Make changes:** When you learn something, write it back immediately
4. **Never re-derive:** If it's in a node, trust it (but verify against live state when acting)

That's it. No memory files. No wandering around looking for docs. Brain is the single source of truth.

---

## Step 1: Read the graph (token-efficient, staged)

**Stage 0 — optional ultra-light orientation (whole graph, no content):**
```bash
curl -s "http://localhost:3000/api/brain?view=index"
```
Returns every node reduced to `id, label, type, tags` (no `content`) — ~70% smaller than the
full graph (~150 tokens). Use it to see *what exists* before deciding what to load in full.

**Stage 1 — always at conversation start (direct neighbors only):**
```bash
curl -s "http://localhost:3000/api/brain?smart=true&depth=1"
```
Returns the `Claude – Startpunkt` node + its direct neighbors (~6 nodes, ~1.250 tokens).
This gives you: who the user is, active projects list, coding preferences.

**Recall — the token-cheapest way to answer a concrete question (PREFER THIS):**
```bash
curl -s "http://localhost:3000/api/recall?q=Wie+steuere+ich+die+Heizung&budget=2000"
```
Returns only the most relevant nodes as ranked **summaries** within a token budget
(hybrid semantic + keyword). Then drill into a specific node for the full text:
```bash
curl -s "http://localhost:3000/api/nodes/<id>"
```
This beats dumping the graph — use it whenever you have an actual question.

**Stage 2 — load project details on demand:**
```bash
curl -s "http://localhost:3000/api/brain?tags=homeassistant"
curl -s "http://localhost:3000/api/brain?semantic=Klimasteuerung"   # meaning-based
curl -s "http://localhost:3000/api/brain?q=Heizung+Temperatur"      # hybrid (semantic+keyword)
curl -s "http://localhost:3000/api/brain?search=thermostat"         # substring
```
Only fetch what you actually need for the current task.

**Full graph (fallback):**
```bash
curl -s "http://localhost:3000/api/brain"
```

Result is always `{ "nodes": [...], "links": [...] }`. Read every node's `content` field — it is Markdown.

**Via MCP (native, any MCP client):** Brain is also an MCP server — use the tools
`brain_recall`, `brain_search`, `brain_index`, `brain_get`, `brain_create_node`,
`brain_update_node`, `brain_link`, `brain_history` instead of curl. Start with `brain_recall`.

---

## Step 2: Do your work

Use the node content as context. Act on it. Ask questions if something is ambiguous. When you finish, go to Step 3.

---

## Step 3: Write back what changed

| Situation | Action |
|-----------|--------|
| Learned a new fact about user/project | Update the relevant standard node with `PUT /api/nodes/:id` |
| New idea or decision | Add under `Ideen` with `POST /api/nodes` |
| New project | Add under `Projekte` |
| Confirmed approach / feedback | Add to `Feedback` |
| Two concepts related | Link them with `POST /api/links` |

### When NOT to create a new node

- **Don't.** Use the 5 standard nodes + project-specific sub-nodes only.
- Everything else goes into these 5 as additional Markdown sections.

### Update a standard node

```bash
curl -X PUT http://localhost:3000/api/nodes/<id> \
  -H "Content-Type: application/json" \
  -d '{"content": "## Old Section\n...\n\n## New Section\n..."}'
```

### Create a new sub-node (rare)

Only if it truly belongs as a separate graph element (e.g., a specific project sub-goal):

```bash
curl -X POST http://localhost:3000/api/nodes \
  -H "Content-Type: application/json" \
  -d '{"label": "Thing Name", "type": "note|project|idea", "content": "...", "tags": []}'
```

Then link it:

```bash
curl -X POST http://localhost:3000/api/links \
  -H "Content-Type: application/json" \
  -d '{"source": "<parent-id>", "target": "<new-id>"}'
```

---

## API reference

```
GET    /api/recall?q=&budget=&limit=   → ranked summaries within a token budget (START HERE)
GET    /api/brain                      → full graph { nodes, links }
GET    /api/brain?view=index           → whole graph, only id+label+type+tags (no content)
GET    /api/brain?fields=id,label,...  → project nodes to chosen fields (combinable)
GET    /api/brain?q=...                → hybrid search (semantic + keyword), ranked + score
GET    /api/brain?semantic=...&limit=N → pure semantic (vector) search, ranked + score
GET    /api/brain?smart=true&depth=N   → start node + neighbors up to N hops
GET    /api/brain?tags=x,y            → nodes matching any tag
GET    /api/brain?search=q            → substring match on label/content
GET    /api/brain/health-report        → orphans, duplicate labels, dead wikilinks, never-accessed
GET    /api/nodes/:id                  → one node, full (incl. summary + lifecycle), counts access
GET    /api/nodes/:id/history          → version history
POST   /api/nodes/:id/revert/:version  → revert to (or undelete) a past version
POST   /api/nodes                      → create node (409 on duplicate label OR near-duplicate; ?force=true)
PUT    /api/nodes/:id                  → update (partial merge; re-embeds + versions)
DELETE /api/nodes/:id                  → delete node + links
POST   /api/links                      → { source, target, label?, type? }   (type = typed edge)
DELETE /api/links                      → { source, target }
POST   /mcp                            → MCP (Streamable HTTP); also stdio via mcp/stdio.js
```

**Optional fields on nodes:** `summary` (1–2 line preview used by recall — set it to save tokens),
`source` (which agent/conversation wrote it). These + lifecycle fields appear only via
`GET /api/nodes/:id`, never in the default graph output (keeps it lean).

**Labels must be unique** — they are the wikilink anchor. `POST /api/nodes` returns `409`
with the existing node if the label is taken, or if the content is a near-duplicate of an
existing node (semantic dedup; pass `?force=true` to override). To disambiguate two real
concepts that would share a name, give them distinct labels (e.g. `Brain` vs `Brain (GitHub)`).

---

## Node shape

```json
{
  "id": "uuid",
  "label": "Display name (used in UI + as wikilink anchor)",
  "type": "memory | project | idea | note | reference",
  "content": "Markdown. Read this.",
  "tags": ["array"],
  "created": "ISO timestamp"
}
```

---

## Node types explained

| Type | Purpose | Examples |
|------|---------|----------|
| `memory` | User facts, preferences, environment, feedback | "Deutsch", "Ubuntu 22.04", "prefers concise responses" |
| `project` | Active projects with goal/status/deadline | "HA Widgets", "pq_signals", "pq_brain" |
| `reference` | Pointers to external systems | "Dev tooling", "GitHub repos", "Release workflow" |
| `note` | Technical patterns, how-to, architectural decisions | "Token discipline in JS", "HTML entity handling" |
| `idea` | Unvalidated ideas, future work | "Carousel card", "new dashboard" |

---

## What NOT to store in Brain

- Code patterns (read the repo)
- Git history (use `git log`)
- In-progress task state (use conversation tasks)
- One-off context only relevant to this conversation

---

## Example: add feedback after confirming an approach

Conversation: "Yes exactly, keep doing that with bundled PRs"

Your action:
```bash
curl -X PUT http://localhost:3000/api/nodes/feedback-node-id \
  -H "Content-Type: application/json" \
  -d '{
    "content": "## Existing feedback\n\n...\n\n## Bundled PRs for refactors\n\n**Rule:** Combine related changes into one PR, don't split unless truly independent.\n\n**Why:** User confirmed this avoids churn and makes review easier.\n\n**Applies to:** Refactoring in widget ecosystem."
  }'
```

---

## Example: update user profile when you learn something new

Conversation: user mentions they're on Node 20, Python 3.12, Ubuntu 22.04

Your action (if not already in profile):
```bash
curl -X PUT http://localhost:3000/api/nodes/user-profil-id \
  -H "Content-Type: application/json" \
  -d '{"content": "**Sprache:** Deutsch\n\n**Umgebung:** Ubuntu 22.04, Node.js v20, Python 3.12\n\n..."}'
```

---

## Setup (one-time)

1. Clone this repo
2. `npm install`
3. `cp data/brain.example.json data/brain.json`
4. **Install as systemd service (auto-start on boot):**
   ```bash
   sudo ./setup-service.sh
   ```
   This enables Brain to persist across server reboots. Verify with:
   ```bash
   systemctl status pq-brain
   journalctl -u pq-brain -f    # view logs
   ```
5. Read `data/brain.json` to see the 5 standard nodes + your initial data

Done. Brain runs automatically. Next agent that connects just reads Brain and starts working.
