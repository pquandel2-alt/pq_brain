# Brain — AI Agent Instructions

Brain is your persistent knowledge graph. It runs as a local service on **port 3000** and stores everything you learn across sessions using SQLite + vector embeddings.

## Quick orientation

Brain is already running. Start every session by reading the overview:

```bash
curl -s "http://localhost:3000/api/brain?smart=true&depth=1&fields=label,type,tags,summary"
```

Or use the `brain_recall` MCP tool if available.

## MCP tools (if your client supports MCP)

Brain registers as MCP server `brain` at `http://localhost:3000/mcp`.

| Tool | When to use |
|------|-------------|
| `brain_recall` | **First choice** — ranked excerpts within a token budget |
| `brain_get` | Full node content (drill-down after recall) |
| `brain_search` | Keyword / semantic / hybrid search |
| `brain_index` | Lightweight table of all nodes |
| `brain_create_node` | Create a new node (dedup runs automatically) |
| `brain_update_node` | Update a node (versioning is automatic) |
| `brain_link` | Connect two nodes (optionally typed) |
| `brain_suggest_links` | Find unlinked but semantically similar node pairs |
| `brain_neighbors` | Load a node's neighbor subgraph |
| `brain_history` | Version history of a node |
| `brain_inbox` | Review auto-captured nodes pending approval |

## REST API (works with any AI)

```bash
curl -s "http://localhost:3000/api/recall?q=<query>&budget=2000"     # recall
curl -s "http://localhost:3000/api/nodes/<id>"                       # read node
curl -s "http://localhost:3000/api/brain?smart=true&depth=1"         # overview
curl -X POST http://localhost:3000/api/nodes \
  -H "Content-Type: application/json" \
  -d '{"label":"...","type":"note","content":"...","summary":"...","tags":[]}'
curl -X PUT http://localhost:3000/api/nodes/<id> \
  -H "Content-Type: application/json" -d '{"content":"..."}'
curl http://localhost:3000/api/health
```

## Rules — follow these in every session

- **Read Brain first.** Before answering questions about the user's projects, preferences, or history, always check Brain.
- **Write back immediately.** New insights, decisions, project progress → `brain_create_node` or `brain_update_node`. Do not save for later.
- **Always include a `summary`** when creating/updating nodes (1 concise sentence). This improves recall quality significantly.
- **Always link after creating.** After every `brain_create_node`, call `brain_suggest_links` and apply all relevant suggestions with `brain_link`. Nodes must not remain isolated.
- **Token discipline.** Use `brain_recall` first, then `brain_get` for specifics. Never load the full graph when a targeted recall suffices.
- **Check for duplicates first.** The dedup check runs automatically on create, but if `similar_exists` is returned, read the existing node before deciding whether to force-create.

## Project node check

At the start of each session in a project directory, check whether a Brain node exists for the current project:

```bash
curl -s "http://localhost:3000/api/recall?q=<project-name>+project&budget=300"
```

If no node is found → immediately create one:
- `type: "project"`, `label`: project name (= directory name)
- `summary`: one sentence describing what the project does
- `tags`: relevant tags
- Then link it to related nodes

## First-time setup for a new Brain instance

If this is a fresh Brain with no nodes yet, create the starter graph before anything else:

1. **Start node** — `type: "memory"`, label: `"AI – Start"`, content: brief overview of the graph structure
2. **User profile** — `type: "memory"`, label: `"User Profile"`, content: user's name, role, goals, tech stack, preferences (ask the user!)
3. **Projects node** — `type: "memory"`, label: `"Projects"`, content: list of active projects
4. Link all three together
5. Ask the user what projects they're working on and create a node for each

**Always ask the user before creating nodes — don't assume.**

## Claude Code users: additional automation

Claude Code users can run `./install-hooks-claude.sh` after `./install.sh` to get hardwired harness hooks:

- Auto-load Brain briefing at session start
- Auto-check for project nodes
- Auto-link + auto-summarize after every node create/update
- Auto-capture session insights to the Brain inbox

See `CLAUDE.md` for details. Other AI tools achieve the same via the rules in this file.
