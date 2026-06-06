# Brain – AI Agent Instructions

**READ THIS FIRST.** This file tells you what to do. Every conversation with this system starts the same way.

## Your job: read Brain, work, write back

1. **At conversation start:** Fetch the full knowledge graph
2. **Use the content:** Every node's `content` field is Markdown — treat it as long-term context
3. **Make changes:** When you learn something, write it back immediately
4. **Never re-derive:** If it's in a node, trust it (but verify against live state when acting)

That's it. No memory files. No wandering around looking for docs. Brain is the single source of truth.

---

## Step 1: Read the full graph

```bash
curl -s http://localhost:3000/api/brain
```

Result is `{ "nodes": [...], "links": [...] }`. **Read every node's `content`.**

You will find 5 standard nodes:
- `Start` — entry point, links to everything else
- `User Profil` — who is asking, their preferences, constraints
- `Feedback` — what works, what to avoid, confirmed approaches
- `Projekte` — active projects, goals, deadlines
- `Ideen` — unvalidated ideas, future work
- `Notizen` — technical patterns, architectural decisions

Each node contains Markdown. Read them all.

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
GET    /api/brain                      → { nodes, links }
PUT    /api/nodes/:id                  → update (partial merge)
POST   /api/nodes                      → create node
DELETE /api/nodes/:id                  → delete node + links
POST   /api/links                      → { source, target, label? }
DELETE /api/links                      → { source, target }
```

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
4. `node server.js` (or `PORT=3002 node server.js`)
5. Read `data/brain.json` to see the 5 standard nodes + your initial data

Done. Next agent that connects just reads Brain and starts working.
