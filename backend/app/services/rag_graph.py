import sys
import os

# Ensure the root project directory is in sys.path for backend module imports
_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import json
from typing import List, Dict, Any, Optional
from typing_extensions import TypedDict
from sqlalchemy.orm import Session
from openai import OpenAI

from backend.app.core.config import settings
from backend.app.services.rag import rag_service
from backend.app.core.prompts import get_query_rewrite_prompt, get_rag_chatbot_system_prompt

try:
    from langsmith.wrappers import wrap_openai
    from langsmith import traceable
    _openai_client = wrap_openai(OpenAI(api_key=settings.OPENAI_API_KEY))
except ImportError:
    _openai_client = OpenAI(api_key=settings.OPENAI_API_KEY)

try:
    from langgraph.graph import StateGraph, START, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False


class RAGGraphState(TypedDict, total=False):
    db: Any
    project_id: int
    project_name: str
    milestone_id: Optional[int]
    category: Optional[str]
    user_message: str
    history: List[Any]
    search_query: str
    chunks: List[Dict[str, Any]]
    context_str: str
    system_prompt: str
    messages_payload: List[Dict[str, str]]


def reformulate_query_node(state: RAGGraphState) -> Dict[str, Any]:
    """Graph Node 1: Contextual Query Reformulation."""
    user_message = state.get("user_message", "")
    history = state.get("history", [])
    
    search_query = user_message
    if history:
        try:
            history_records = history[-5:]
            history_text = "\n".join([f"{'User' if getattr(m, 'role', 'user') == 'user' else 'Assistant'}: {getattr(m, 'content', '')}" for m in history_records])
            rewrite_prompt = get_query_rewrite_prompt(history_text, user_message)
            
            response = _openai_client.chat.completions.create(
                model=settings.OPENAI_MODEL,
                messages=[{"role": "user", "content": rewrite_prompt}],
                temperature=0.0,
                max_tokens=60
            )
            rewritten = response.choices[0].message.content.strip()
            if rewritten.startswith('"') and rewritten.endswith('"'):
                rewritten = rewritten[1:-1]
            search_query = rewritten
        except Exception as e:
            print(f"[LangGraph] Query reformulation fallback: {e}")
            search_query = user_message

    return {"search_query": search_query}


def retrieve_chunks_node(state: RAGGraphState) -> Dict[str, Any]:
    """Graph Node 2: Hybrid pgvector + FTS chunk retrieval."""
    db = state.get("db")
    project_id = state.get("project_id")
    search_query = state.get("search_query", state.get("user_message", ""))
    milestone_id = state.get("milestone_id")
    category = state.get("category")

    chunks = []
    if db and project_id:
        try:
            chunks = rag_service.query_project_chunks(
                db=db,
                project_id=project_id,
                query_text=search_query,
                milestone_id=milestone_id,
                category=category,
                top_k=5
            )
        except Exception as e:
            print(f"[LangGraph] Chunk retrieval error: {e}")
            chunks = []

    return {"chunks": chunks}


def assemble_context_node(state: RAGGraphState) -> Dict[str, Any]:
    """Graph Node 3: Assembles document citations and system prompts."""
    chunks = state.get("chunks", [])
    history = state.get("history", [])
    user_message = state.get("user_message", "")
    project_name = state.get("project_name", "Project")

    context_parts = []
    if chunks:
        for idx, chunk in enumerate(chunks):
            page_label = chunk['page'] if chunk.get('page') else f"Segment {chunk['chunk_index']}"
            context_parts.append(
                f"--- CHUNK {idx+1} ---\nCITATION: [{chunk['document']}, {page_label}]\nCONTENT:\n{chunk['snippet']}"
            )
        context_str = "\n".join(context_parts)
    else:
        context_str = "No uploaded documents or readable context found for this project."

    system_prompt = get_rag_chatbot_system_prompt(project_name)

    messages_payload = [{"role": "system", "content": system_prompt}]
    for hist in history[-5:]:
        messages_payload.append({"role": getattr(hist, 'role', 'user'), "content": getattr(hist, 'content', '')})

    latest_content = (
        f"Below are relevant document excerpts for context:\n{context_str}\n\n"
        f"Using the context above, answer the user's question.\n"
        f"User Question: {user_message}"
    )
    messages_payload.append({"role": "user", "content": latest_content})

    return {
        "context_str": context_str,
        "system_prompt": system_prompt,
        "messages_payload": messages_payload
    }


def build_rag_graph():
    """Compiles the LangGraph RAG StateGraph workflow."""
    if not LANGGRAPH_AVAILABLE:
        return None

    builder = StateGraph(RAGGraphState)
    
    # Add Nodes
    builder.add_node("reformulate_query", reformulate_query_node)
    builder.add_node("retrieve_chunks", retrieve_chunks_node)
    builder.add_node("assemble_context", assemble_context_node)

    # Add Edges
    builder.add_edge(START, "reformulate_query")
    builder.add_edge("reformulate_query", "retrieve_chunks")
    builder.add_edge("retrieve_chunks", "assemble_context")
    builder.add_edge("assemble_context", END)

    return builder.compile()

rag_graph = build_rag_graph()
