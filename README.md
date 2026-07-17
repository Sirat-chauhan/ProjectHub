# ProjectHub — Multi-Tenant RAG & Agile Project Intelligence Platform

ProjectHub is a multi-tenant project intelligence web application built with **FastAPI (Python)**, **PostgreSQL/pgvector**, and a responsive vanilla **HTML/CSS/JavaScript** single-page application.

It integrates two core capabilities:
1. **AI Document Chatbot (RAG)**: Offers hybrid search (pgvector HNSW Cosine + tsvector Full-Text Keyword via Reciprocal Rank Fusion) and streaming Server-Sent Events (SSE) with citations.
2. **Jira-Style Agile Task Management**: Features AI User Story generation from documents, interactive Kanban boards with optimistic UI rendering, and role-based automated task distribution.

---

## Key Capabilities

### 1. Hybrid RAG Engine
- **Sentence-Aware Chunking**: Groups complete sentences with overlap for optimal retrieval context.
- **Table Extraction**: Extracts structured tables and tabular matrices from PDF documents.
- **Hybrid Search (RRF)**: Combines semantic search and keyword search via Reciprocal Rank Fusion.
- **Contextual Query Reformulation**: Resolves pronouns and conversational references using session history.

### 2. Document Ingestion & Deduplication
- **Fingerprinting**: Uses SHA-256 fingerprinting to avoid storing duplicate documents.
- **Active Upload Control**: Allows active uploads to be cancelled instantly with automatic server-side cleanup.

### 3. Agile Kanban & User Story Board
- **AI User Story Generator**: Generates User Stories and nested Subtasks from uploaded specification files.
- **Optimistic Drag-and-Drop**: Updates the UI instantly while saving updates asynchronously in the background.
- **Default Assignees**: Automatically assigns user stories and tasks based on project member roles.
