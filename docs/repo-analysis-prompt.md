# Repository Analysis Prompt

## OBJECTIVE
Generate a structured technical summary for LLM consumption based on the codebase structure

## OUTPUT FORMAT (STRICT)
Return ONLY the following sections:

### 1. Repository Overview

- Purpose of the system (1–3 lines max)
- Main architectural style (e.g. monolith, client-server, microservices)
- Runtime environment (Node, Python, ServiceNow, etc.)

---

### 2. Core Components
List major components/modules:

For each:

- Name
- Responsibility (1 line)
- Key files

---

### 3. File Index (IMPORTANT)
List key files grouped by function:

Format:

- path/to/file.js — what it does (1 line)
Group by:

- API / backend
- frontend / UI
- data / database
- infrastructure / config
- utilities / shared

---

### 4. Data Model / Schema (if applicable)

- Main entities / tables / objects
- Key relationships

---

### 5. API / Interface Surface

- Endpoints OR exposed functions OR message channels
- Input/output summary

---

### 6. Control Flow
Describe ONLY major flows, such as:

- request lifecycle
- event handling
- WebSocket/message flow
- job processing pipeline
Use bullet points only.

---

### 7. Dependencies

- External libraries
- Frameworks
- Key internal dependencies between modules

---

### 8. Important Notes
Only include:

- hidden coupling
- global state
- unusual patterns
- potential risk areas

---

## RULES

- No prose paragraphs longer than 3 lines
- No marketing language
- No guessing if unsure → write "unknown"
- Prefer structure over completeness
- Ignore test files unless they define architecture
- If repo is large, prioritise entry points and core logic