#!/usr/bin/env python3
"""
Brain + OpenAI function calling — runnable example.

Two ideas:
  1. Brain serves its tool list in OpenAI format at GET /api/tools?format=openai.
  2. Tool calls are executed via the MCP endpoint (POST /mcp, tools/call) — the
     SAME tools, so there is no hand-maintained name->REST mapping to drift.

The Brain part uses only the Python standard library, so this script runs as-is.
The OpenAI part runs only if OPENAI_API_KEY is set (and `pip install openai`).

    python examples/openai_function_calling.py
    BRAIN_URL=http://localhost:3000 python examples/openai_function_calling.py
"""

import json
import os
import urllib.request

BASE = os.environ.get("BRAIN_URL", "http://localhost:3000")


def get_openai_tools():
    """Fetch Brain's tools in OpenAI chat.completions format."""
    with urllib.request.urlopen(f"{BASE}/api/tools?format=openai") as r:
        return json.load(r)["tools"]


def mcp_call(name, arguments):
    """Execute a Brain tool through the MCP endpoint (JSON-RPC 2.0)."""
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/mcp", data=body,
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(req) as r:
        raw = r.read().decode()
    # Response may be a plain JSON body or an SSE stream ("data: {...}").
    line = next(l for l in raw.splitlines() if l.strip().startswith(("{", "data:")))
    payload = json.loads(line[5:].strip() if line.startswith("data:") else line)
    return payload["result"]["content"][0]["text"]


def main():
    tools = get_openai_tools()
    print(f"Brain exposes {len(tools)} tools (OpenAI format).")

    # --- Always-runnable part: call a tool directly through MCP ---
    print("\nDirect tool call — brain_recall:")
    print(mcp_call("brain_recall", {"q": "Brain", "budget": 600})[:400])

    # --- Optional part: let an OpenAI model decide which tool to call ---
    if not os.environ.get("OPENAI_API_KEY"):
        print("\n(Set OPENAI_API_KEY and `pip install openai` to run the full LLM loop.)")
        return

    from openai import OpenAI
    client = OpenAI()
    messages = [{"role": "user", "content": "What do you know about the Brain project?"}]
    resp = client.chat.completions.create(model="gpt-4o-mini", messages=messages, tools=tools)
    msg = resp.choices[0].message
    messages.append(msg)
    for call in (msg.tool_calls or []):
        result = mcp_call(call.function.name, json.loads(call.function.arguments))
        messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
    final = client.chat.completions.create(model="gpt-4o-mini", messages=messages, tools=tools)
    print("\nModel answer:\n" + (final.choices[0].message.content or ""))


if __name__ == "__main__":
    main()
