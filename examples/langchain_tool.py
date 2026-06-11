#!/usr/bin/env python3
"""
Brain as LangChain tools — runnable example.

Wraps the Brain REST endpoints as LangChain tools. Run directly to exercise the
tools without an LLM (just needs `pip install langchain-core requests`); plug the
same `TOOLS` list into any LangChain agent to let a model call them.

    pip install langchain-core requests
    python examples/langchain_tool.py
    BRAIN_URL=http://localhost:3000 python examples/langchain_tool.py
"""

import os
import requests
from langchain_core.tools import tool

BASE = os.environ.get("BRAIN_URL", "http://localhost:3000")


@tool
def brain_recall(q: str, budget: int = 4000) -> str:
    """Recall the most relevant memory for a question (ranked, token-budgeted)."""
    return requests.get(f"{BASE}/api/recall", params={"q": q, "budget": budget}).text


@tool
def brain_get(id: str) -> str:
    """Fetch the full content of a node by id (use after brain_recall)."""
    return requests.get(f"{BASE}/api/nodes/{id}").text


@tool
def brain_briefing() -> str:
    """Get the session start context: start node, linked context and graph stats."""
    return requests.get(f"{BASE}/api/briefing").text


@tool
def brain_create_node(label: str, content: str = "", type: str = "note") -> str:
    """Create a new memory node. Types: memory, note, idea, project, reference."""
    return requests.post(
        f"{BASE}/api/nodes",
        json={"label": label, "content": content, "type": type},
    ).text


TOOLS = [brain_recall, brain_get, brain_briefing, brain_create_node]


if __name__ == "__main__":
    print(f"{len(TOOLS)} Brain tools ready for LangChain.\n")
    # Exercise one tool without an LLM:
    print("brain_recall('Brain'):")
    print(brain_recall.invoke({"q": "Brain", "budget": 600})[:400])
    print("\nPlug `TOOLS` into e.g. create_react_agent(llm, TOOLS) to use with a model.")
