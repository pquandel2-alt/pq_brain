# Brain – Instructions for Claude Code

## At the start of every conversation

Read the full graph:

```bash
curl -s http://localhost:3000/api/brain
```

Use the `content` field of every node as persistent context — treat it as your long-term memory for this project and user.

## When to write back

| Situation | Action |
|-----------|--------|
| Learned something new about the user or project | `POST /api/nodes` |
| Existing node is outdated or incorrect | `PUT /api/nodes/:id` |
| A fact is no longer relevant | `DELETE /api/nodes/:id` |
| Two nodes are related | `POST /api/links` |

## API reference

```
GET    /api/brain              → full graph { nodes, links }
POST   /api/nodes              → create node
PUT    /api/nodes/:id          → update node (partial, merges fields)
DELETE /api/nodes/:id          → delete node + its links
POST   /api/links              → { source, target, label? }
DELETE /api/links              → { source, target }
```

### Node shape

```json
{
  "label": "Short name (used as identifier in UI)",
  "type": "memory | note | idea | project | reference",
  "content": "Markdown. This is what you read as context.",
  "tags": ["optional", "array"]
}
```

### Node types

| Type | When to use |
|------|-------------|
| `memory` | User facts, preferences, feedback, corrections |
| `project` | Active projects — goal, path, current status |
| `reference` | Pointers to external systems (URLs, file paths, dashboards) |
| `note` | Technical patterns, architectural decisions, how-to |
| `idea` | Unvalidated ideas, future work |

## What NOT to store

- Code patterns derivable by reading the repo
- Git history (use `git log`)
- In-progress task state (use tasks in the current conversation)
- Ephemeral context only relevant to this conversation

## Example: update a node

```bash
curl -X PUT http://localhost:3000/api/nodes/<id> \
  -H "Content-Type: application/json" \
  -d '{"content": "updated markdown content"}'
```

## Example: add a node

```bash
curl -X POST http://localhost:3000/api/nodes \
  -H "Content-Type: application/json" \
  -d '{"label": "New Thing", "type": "memory", "content": "...", "tags": []}'
```
