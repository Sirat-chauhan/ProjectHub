import json
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List
from openai import OpenAI

from backend.app.core.database import get_db, SessionLocal
from backend.app.core.security import get_current_user
from backend.app.core.config import settings
from backend.app.models import User, Project, ChatMessage
from backend.app import schemas
from backend.app.services.rag import rag_service
from backend.app.core.prompts import get_query_rewrite_prompt, get_rag_chatbot_system_prompt

try:
    from langsmith.wrappers import wrap_openai
    from langsmith import traceable
    _openai_client = wrap_openai(OpenAI(api_key=settings.OPENAI_API_KEY))
except ImportError:
    _openai_client = OpenAI(api_key=settings.OPENAI_API_KEY)
    def traceable(*args, **kwargs):
        def decorator(func):
            return func
        return decorator

router = APIRouter(prefix="/api/chat", tags=["chat"])

@router.get("/history/{project_id}", response_model=List[schemas.ChatMessage])
def get_chat_history(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Retrieves the chronological history of the last 50 messages 
    exchanged under a specific project to render on the chat UI.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    return []

def _clean_chat_inputs(inputs: dict) -> dict:
    cleaned = dict(inputs)
    cleaned.pop("db", None)
    cleaned.pop("current_user", None)
    return cleaned

@router.post("")
@traceable(name="RAG Chat Pipeline", run_type="chain", process_inputs=_clean_chat_inputs)
def chat_with_project(
    request: schemas.ChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    RAG Chatbot Endpoint with Conversational Memory.
    1. Scope search by project_id.
    2. Retrieve top-5 relevant chunks using pgvector (filtered by score threshold >= 0.30).
    3. Save incoming user question to ChatMessage table.
    4. Fetch the last 5 chat messages to inject history context.
    5. Formulate prompt, call OpenRouter API in streaming mode, and stream tokens via SSE.
    6. Accumulate tokens and write the final AI assistant response to the ChatMessage table.
    """
    project = db.query(Project).filter(Project.id == request.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project_name = project.name

    # Step 1 & 2: Parse session history passed from the frontend (limit to last 5 messages)
    history_records = []
    if request.history:
        history_records = request.history[-5:]

    # --- LANGGRAPH WORKFLOW EXECUTION ---
    from backend.app.services.rag_graph import rag_graph
    
    chunks = []
    messages_payload = []
    
    if rag_graph is not None:
        try:
            graph_input = {
                "db": db,
                "project_id": request.project_id,
                "project_name": project_name,
                "milestone_id": request.milestone_id,
                "category": request.category,
                "user_message": request.message,
                "history": history_records,
            }
            final_state = rag_graph.invoke(graph_input)
            chunks = final_state.get("chunks", [])
            messages_payload = final_state.get("messages_payload", [])
        except Exception as graph_err:
            print(f"[LangGraph Execution Error, falling back]: {graph_err}")
            rag_graph = None

    if not messages_payload:
        # Fallback linear execution if LangGraph is disabled/errored
        search_query = request.message
        if history_records:
            try:
                history_text = "\n".join([f"{'User' if m.role == 'user' else 'Assistant'}: {m.content}" for m in history_records])
                rewrite_prompt = get_query_rewrite_prompt(history_text, request.message)
                rewrite_response = _openai_client.chat.completions.create(
                    model=settings.OPENAI_MODEL,
                    messages=[{"role": "user", "content": rewrite_prompt}],
                    temperature=0.0,
                    max_tokens=60
                )
                search_query = rewrite_response.choices[0].message.content.strip()
                if search_query.startswith('"') and search_query.endswith('"'):
                    search_query = search_query[1:-1]
            except Exception as e:
                search_query = request.message

        try:
            chunks = rag_service.query_project_chunks(db, request.project_id, search_query, milestone_id=request.milestone_id, category=request.category, top_k=5)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to query vector database: {str(e)}")

        context_parts = []
        if chunks:
            for idx, chunk in enumerate(chunks):
                page_label = chunk['page'] if chunk['page'] else f"Segment {chunk['chunk_index']}"
                context_parts.append(f"--- CHUNK {idx+1} ---\nCITATION: [{chunk['document']}, {page_label}]\nCONTENT:\n{chunk['snippet']}")
            context_str = "\n".join(context_parts)
        else:
            context_str = "No uploaded documents or readable context found for this project."

        system_prompt = get_rag_chatbot_system_prompt(project_name)
        messages_payload = [{"role": "system", "content": system_prompt}]
        for hist in history_records:
            messages_payload.append({"role": hist.role, "content": hist.content})
        messages_payload.append({"role": "user", "content": f"Below are relevant document excerpts for context:\n{context_str}\n\nUsing the context above, answer the user's question.\nUser Question: {request.message}"})

    # Append current turn context + question
    latest_content = (
        f"Below are relevant document excerpts for context:\n{context_str}\n\n"
        f"Using the context above, answer the user's question.\n"
        f"User Question: {request.message}"
    )
    messages_payload.append({"role": "user", "content": latest_content})

    def sse_generator():
        # Step A: Yield retrieved sources to the UI for Debug Mode
        sources_payload = {
            "type": "sources",
            "sources": [
                {
                    "document": chunk["document"],
                    "chunk_index": chunk["chunk_index"],
                    "page": chunk["page"],
                    "score": chunk["score"],
                    "snippet": chunk["snippet"]
                }
                for chunk in chunks
            ]
        }
        yield f"data: {json.dumps(sources_payload)}\n\n"

        full_assistant_response = ""

        # Step B: Route the request to the LLM
        usage_data = None
        try:
            response = _openai_client.chat.completions.create(
                model=settings.OPENAI_MODEL,
                messages=messages_payload,
                stream=True,
                stream_options={"include_usage": True},
                temperature=0.2,
                max_tokens=1500
            )

            for chunk in response:
                if chunk.choices and len(chunk.choices) > 0:
                    token = chunk.choices[0].delta.content or ""
                    if token:
                        full_assistant_response += token
                        yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"
                if hasattr(chunk, "usage") and chunk.usage:
                    usage_data = {
                        "prompt_tokens": chunk.usage.prompt_tokens,
                        "completion_tokens": chunk.usage.completion_tokens,
                        "total_tokens": chunk.usage.total_tokens
                    }
        except Exception as e:
            err_text = f"Connection Error: {str(e)}"
            yield f"data: {json.dumps({'type': 'token', 'content': err_text})}\n\n"
            full_assistant_response = err_text

        # Yield token usage summary if captured
        if usage_data:
            yield f"data: {json.dumps({'type': 'usage', 'usage': usage_data})}\n\n"

        # Step C: Session-only history (no database persist)
        pass

        # Step D: Yield done indicator
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(sse_generator(), media_type="text/event-stream")

