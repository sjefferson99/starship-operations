# Repository Analysis Prompt

## OBJECTIVE
Generate a structured technical summary of this repository, for consumption by another LLM
(architecture/onboarding context — not end-user docs).

## WHEN RUNNING THIS
This gets re-run as the repo evolves (new features, refactors). Each run is a full
regeneration from current source — never patch the previous `docs/repo-summary.md` in place
or carry forward any of its claims; treat it as not existing. Don't reuse phrasing or claims
from any other `docs/*.md` file either — they may be stale.

## GROUNDING (DO THIS FIRST, with actual tools — not memory or assumption)
- Glob `**/*` (excluding `node_modules/`, `.git/`, build output) to get the full file list.
  Every file from that list must end up accounted for in §2 or §3.
- Read the actual entry points and core logic files directly — don't infer behavior from file
  names alone.
- For any API endpoint, route, exported function name, or config key stated as fact, Grep for
  the literal string in source first. If it can't be found verbatim, write "unknown" — don't
  infer a "conventional" shape (e.g. don't assume REST verbs/paths just because they sound
  plausible for this kind of app).

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
List EVERY file from the GROUNDING file list exactly once (test files may be collapsed into
one line per suite/dir, but must not be silently dropped).

Format:

- path/to/file.js — what it does (1 line)

Group by, in this order:

- API / backend
- frontend / UI
- data / database
- infrastructure / config
- core logic / domain (business/simulation logic that isn't a thin API or UI layer)
- utilities / shared

If a file doesn't fit any group above, add a new clearly-named group rather than forcing it
into the closest-sounding one or skipping it.

---

### 4. Data Model / Schema (if applicable)

- Main entities / tables / objects
- Key relationships

---

### 5. API / Interface Surface

- Endpoints OR exposed functions OR message channels — quote the literal path/method/name as
  it appears in source. If it can't be found verbatim, write "unknown".
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
- No guessing — "unknown" beats a plausible-sounding wrong answer
- "Structure over completeness" means terse bullets, not fewer files — every file from the
  GROUNDING file list must be traceable somewhere in the output
- Collapse test files into one line per suite/dir rather than dropping them
- If the repo is large, prioritise entry points and core logic for DEPTH of explanation, not
  for which files get mentioned at all
- Before finishing, diff your own file list against §2/§3 and add anything missing

Output file: `docs/repo-summary.md` (overwrite in place)
