# Integrations

How to wire specific AI clients to Brain. This file covers **connection setup only** —
for the API itself see [`README.md`](./README.md) (REST + MCP reference) and the live
contract at `GET /openapi.json`. Tool schemas: `GET /api/tools`.

Pick the surface your client speaks:

| Client | Surface | How |
|--------|---------|-----|
| Claude Code / Claude Desktop | MCP | `/mcp` (HTTP) or `mcp/stdio.js` |
| Cursor / Windsurf / Gemini CLI | MCP | `/mcp` (HTTP) |
| ChatGPT (Custom GPT) | REST | import `GET /openapi.json` as an Action |
| OpenAI SDK (function calling) | REST + `/api/tools` | load `?format=openai`, dispatch to REST |
| LangChain | REST | thin tool wrapper over REST |
| Anything else | REST | plain HTTP/JSON |

Assumes Brain runs at `http://localhost:3000`. Replace the host as needed.

---

## Claude Code

```bash
claude mcp add --scope user --transport http brain http://localhost:3000/mcp
```

Claude Code supports two automatic hooks — see [`AI-AGENT-SETUP.md`](./AI-AGENT-SETUP.md) and [`CLAUDE.md`](./CLAUDE.md):

- **SessionStart hook** — loads a Brain briefing into context at the start of every session.
- **SessionEnd / Auto-Capture hook** — extracts durable knowledge from the session transcript and queues it as Inbox candidates for review. See `examples/hooks/brain-capture.sh` and the [Auto-Capture section in README.md](./README.md#auto-capture).

## Claude Desktop (stdio)

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "brain": { "command": "node", "args": ["/absolute/path/to/pq_brain/mcp/stdio.js"] }
  }
}
```

## Cursor / Windsurf / Gemini CLI (MCP over HTTP)

These read an MCP server list. Point them at the HTTP endpoint:

```json
{
  "mcpServers": {
    "brain": { "url": "http://localhost:3000/mcp" }
  }
}
```

For agents that have no session-start mechanism, fetch context explicitly at the
start of a turn with the `brain_briefing` tool (or `GET /api/briefing`).

## ChatGPT — Custom GPT Action

1. Create a GPT → **Configure** → **Actions** → **Add action**.
2. Under schema, choose **Import from URL** and enter `http://<your-host>:3000/openapi.json`
   (must be reachable from OpenAI; expose via a tunnel/reverse proxy if needed).
3. The actions map 1:1 to the REST endpoints (`recall`, `getBrain`, `createNode`, …).

> Security is out of scope here — only expose a publicly reachable Brain behind your
> own auth/proxy.

## OpenAI SDK — function calling

Brain serves the tool list in OpenAI format; you dispatch each call to the REST API.
Runnable: [`examples/openai_function_calling.py`](./examples/openai_function_calling.py).

```python
import requests
tools = requests.get("http://localhost:3000/api/tools", params={"format": "openai"}).json()["tools"]
# pass `tools` to client.chat.completions.create(..., tools=tools)
# then route tool_calls to the matching /api/* endpoint (see the example for the dispatch table)
```

## LangChain

Wrap the REST endpoints as LangChain tools.
Runnable: [`examples/langchain_tool.py`](./examples/langchain_tool.py).

```python
from langchain_core.tools import tool
import requests
BASE = "http://localhost:3000"

@tool
def brain_recall(q: str, budget: int = 4000) -> str:
    """Recall the most relevant memory for a question (ranked, token-budgeted)."""
    return requests.get(f"{BASE}/api/recall", params={"q": q, "budget": budget}).text
```

## Plain REST (any language)

```bash
curl "http://localhost:3000/api/briefing"                 # session context (Markdown)
curl "http://localhost:3000/api/recall?q=your+question"   # ranked summaries
curl "http://localhost:3000/api/nodes/<id>"               # full node
```
