#. MCP Architecture & Agent Ergonomics Specification

## 1. Dynamic Handshake Steering (InitializeResult.instructions)
The Principle: Leverage the official MCP protocol handshake to inject operational instructions into the client LLM’s system prompt before the first turn occurs.

Mechanism: During the JSON-RPC initialize method exchange, populate the optional result.instructions string field. 

Keep this result.instructions file as a separate readable file, do not hardcode into the code.

## 2. Markdown as Default Output (Token Efficiency & Ingestion Ease)
The Principle: Default all text/retrieval tool responses to dense, structured Markdown rather than repetitive JSON.

The Problem with JSON: Arrays of objects duplicate schema keys ("id", "title", "status", "metadata") on every entry, consuming massive token budgets and inducing deserialization overhead for the model.

The Solution:
Set format: "markdown" as the default parameter across listing, search, and reading tools. Render collection results as compact tables or hierarchical bulleted syllabus trees. Provide format: "json" strictly as an opt-in flag for programmatic or automated machine pipelines.

Impact: Typically reduces token consumption by 80%+ while allowing the LLM's attention mechanism to parse and reason over the data natively.

## 3. In-Band Schema Steering (tools/list Descriptions)
The Principle: Prevent agents from falling back to raw shell or OS-level hacks by embedding positive and negative routing constraints directly in tool descriptions.

The Anti-Pattern: Autonomous coding agents often default to shell scripts (e.g. python3 -c "open(...)", cat, grep) to read files from disk, bypassing domain caches, violating sandboxes, and flooding the context window.

The Fix:
Explicitly prefix tool descriptions with operational guidance:

"PREFERRED: Always use this tool to inspect [Domain Entity] instead of running shell scripts, python one-liners, or inspecting disk files directly."

When an agent evaluates tool selection, explicit precedence instructions in the schema override its default inclination to use terminal commands.

## 4. Progressive Disclosure (Anti-Monolithic Payload Pattern)
The Principle: Never dump full object trees on discovery queries.

Implementation:
Collection Level (list_entities): Default to detail: "summary", returning only identifiers, high-level metadata, and aggregate counts (e.g., itemCount: 12, status: active).

Entity Level (get_entity): Provide flags such as includeChildren: false to inspect entity headers without pulling massive arrays of child items.
Item Level (get_entity_item): Fetch individual leaves on demand.
Benefit: Prevents a simple "what items exist?" query from blowing 6,000+ tokens on deep nested manifests.

## 5. Bounded Query & Snippet Budgets
The Principle: Guard exploratory and search tools against unbounded text dumps.

Implementation:
Always enforce pagination or limit caps (e.g., limit default: 10, max: 50).
In full-text or semantic search tools, return relevance-ranked excerpts/snippets rather than complete document contents.
Include clear location identifiers so the agent can pinpoint exactly which document to inspect next using targeted retrieval tools.

## 6. Passive MCP Resources vs. Active MCP Tools
The Principle: Separate static inspection data from executable operations.
Implementation:
Expose static, read-only, or cacheable metadata (catalogs, manifests, schedules) as MCP Resources (e.g. domain://collection/item) alongside tools.

Clients that support resources can stream and cache data directly without consuming an active LLM reasoning step or tool-call roundtrip.

Reserve MCP Tools for operations that accept arguments, perform mutations, or execute computationally heavy generation tasks.

## 7. Multi-Tier Governance (AGENTS.md Rulebook)
The Principle: Complement protocol-level instructions with repository-level agent guidelines.

Implementation:
Place an authoritative rulebook (e.g., AGENTS.md) at the repository root.

Explicitly mandate:
Domain Data Access: Must route exclusively through the registered MCP server tools.

Execution Hygiene: Strictly prohibit spawning runtime interpreters (python3, node) or terminal wrappers solely to read or inspect files.

Source Code Access: Mandate native IDE reader tools (e.g., view_file with line range slicing) rather than terminal utilities (cat, tail, head).