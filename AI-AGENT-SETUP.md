# AI Agent Setup

You are an AI agent. This repository is your memory system. Here is how it works.

> **Client-specific setup** (Claude Code, ChatGPT, OpenAI SDK, LangChain, Gemini, Cursor) is in [`INTEGRATIONS.md`](./INTEGRATIONS.md). This document describes the generic REST workflow that works with any AI.

## 1. Install Brain (one-time)

```bash
git clone https://github.com/pquandel2-alt/pq_brain.git
cd pq_brain
./install.sh          # Ubuntu/Debian: installs Node.js, deps, optional systemd service
# or:
docker compose up -d  # any OS, persistent volume
```

Brain runs at `http://localhost:3000`. Verify:

```bash
curl -s http://localhost:3000/api/health
```

**Claude Code users:** also run:
```bash
./install-hooks-claude.sh   # installs hooks into ~/.claude/settings.json
claude mcp add --scope user --transport http brain http://localhost:3000/mcp
```

**Other MCP clients (Cursor, Windsurf, etc.):** add to your MCP config:
```json
{ "mcpServers": { "brain": { "url": "http://localhost:3000/mcp" } } }
```

---

## 2. At the start of every session: read Brain

```bash
curl -s "http://localhost:3000/api/recall?q=<topic>&budget=2000"   # targeted
curl -s http://localhost:3000/api/briefing                          # full overview
```

You get ranked node summaries with IDs. Drill down with:

```bash
curl -s http://localhost:3000/api/nodes/<id>
```

---

## 3. The 6 default nodes

| Label | Type | Content |
|-------|------|---------|
| `AI – Start` | memory | Entry point, explains graph structure |
| `User Profile` | memory | Who is the user? Environment, experience, preferences |
| `Feedback` | memory | What works? What to avoid? Confirmed approaches |
| `Projects` | project | Active projects, goals, versions, status |
| `Ideas` | idea | Unvalidated ideas, future work |
| `Notes` | note | Technical patterns, architecture decisions |

Read all of them. This is your context.

---

## 4. During the session: use Brain as context

If Brain says:
- "User prefers TypeScript" → use TypeScript
- "Use token discipline" → grep instead of reading whole files
- "Brain is the primary knowledge source" → ignore stale `.md` files

Brain is the **single source of truth**.

---

## 5. When something changes: write back

### New fact about the user or project

```bash
curl -X PUT http://localhost:3000/api/nodes/<id> \
  -H "Content-Type: application/json" \
  -d '{"content": "... updated markdown ..."}'
```

### New standalone insight

```bash
curl -X POST http://localhost:3000/api/nodes \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Concise name",
    "type": "note|idea|project|memory|reference",
    "summary": "One sentence, max 120 chars",
    "content": "# Markdown content",
    "tags": ["relevant", "tags"]
  }'
```

Response: `{ "id": "<uuid>", ... }` — then link it:

```bash
curl -X POST http://localhost:3000/api/links \
  -H "Content-Type: application/json" \
  -d '{"source": "<parent-id>", "target": "<new-id>"}'
```

**Always link new nodes.** Isolated nodes are hard to recall.

### After creating a node: check for suggested links

```bash
curl -s "http://localhost:3000/api/brain/suggest-links?limit=20"
# Creates links for any pair involving your new node
```

---

## 6. REST API quick reference

```
GET    /api/briefing                  → Session entry point (Markdown or ?format=json)
GET    /api/recall?q=                 → Ranked excerpts within token budget
GET    /api/tools?format=openai       → Tool catalog (for function-calling clients)
GET    /openapi.json                  → OpenAPI 3.1 spec (importable as ChatGPT Action)
GET    /api/brain                     → Full graph { nodes, links }
GET    /api/brain/suggest-links       → Unlinked similar node pairs
GET    /api/nodes/:id                 → Single node
PUT    /api/nodes/:id                 → Update (merges fields)
POST   /api/nodes                     → Create node
DELETE /api/nodes/:id                 → Delete node + its links
POST   /api/links                     → Create link
DELETE /api/links                     → Delete link
POST   /api/inbox                     → Submit auto-captured candidates
GET    /api/inbox                     → List inbox items
POST   /api/import                    → Import .md files (YAML frontmatter)
```

Errors: `{ "error": "...", "code": "..." }` (e.g. `NOT_FOUND`, `LABEL_EXISTS`, `SIMILAR_EXISTS`).

---

## 7. What NOT to do

❌ Create separate `.md` memory files  
❌ Duplicate memory systems  
❌ Store conversation history as nodes  
❌ Store code patterns (read the repository instead)  
❌ Store timestamps or temporary state  

---

## 8. Example workflow

```
1. Session starts
   → GET /api/briefing

2. Agent receives nodes (Start, User, Feedback, Projects, Ideas, Notes)
   → Reads all content fields

3. User asks: "Add a new feature to the dashboard"
   → Agent checks Feedback: sees "always write tests first"
   → Agent checks Projects: sees current version and stack
   → Agent checks Notes: sees existing patterns

4. Agent does the work

5. User says: "great, always do it that way"
   → Agent POST /api/nodes (new pattern node)
   → Agent links it to Projects and Notes
   → Agent GET /api/brain/suggest-links — applies results

6. Next session, any AI
   → GET /api/briefing
   → Sees the new pattern immediately
   → Acts accordingly
```

---

## 9. Automation levels by client

| Client | Auto-read Brain | Auto-write | Auto-link | Auto-capture |
|--------|----------------|------------|-----------|--------------|
| Claude Code (with hooks) | ✅ SessionStart hook | ✅ Stop hook | ✅ PostToolUse hook | ✅ Auto-capture |
| Cursor / Windsurf (MCP) | via `.cursorrules` | via rules | via rules | ❌ manual |
| ChatGPT Custom GPT | via system prompt | via system prompt | via rules | ❌ manual |
| OpenAI SDK / LangChain | via tool call | via tool call | via tool call | ❌ manual |
| Any REST client | manual | manual | manual | ❌ manual |

Claude Code achieves full automation via the harness hook system (`install-hooks-claude.sh`). All other clients rely on the AI following the instructions in `AGENTS.md` / `.cursorrules` / system prompt.

---

## 10. Common errors

| Error | Fix |
|-------|-----|
| `Cannot POST /api/nodes` | Use POST, not PUT |
| `Source node not found` | Node IDs are UUIDs — copy exactly |
| `Link already exists` | Brain deduplicates, safe to ignore |
| DB error on start | Is `data/` writable? Check `BRAIN_DATA_DIR` |
| Port 3000 in use | `PORT=3002 node server.js` |
