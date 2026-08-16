import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { REME_TIMEOUT_MS } from "./constants.js";

export { apply, name, inject, Config };

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-reme";

/** Services required by the ReMe tool suite. */
const inject = ["tools", "systemPrompt"];

/** Plugin configuration schema. */
const Config = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().default(2333),
  workspaceDir: z.string().default(""),
  searchLimit: z.number().default(5),
  timeoutMs: z.number().default(REME_TIMEOUT_MS),
});

/**
 * Apply the ReMe tools to the given context.
 * Registers model-facing tools and system prompt sections.
 */
function apply(ctx, config) {
  const resolved = config;
  const baseUrl = `http://${resolved.host}:${resolved.port}`;

  // ── System prompt guidance ──────────────────────────────────────────
  ctx.systemPrompt.section({
    name: "tool:reme_memory",
    order: 120,
    text: `Use the ReMe memory tools to access and manage long-term memory stored as Markdown files. ReMe provides a file-based knowledge base with BM25 search and wikilink traversal.

Before answering questions about prior conversations, user preferences, project history, or decisions, search ReMe first with reme_search. Read relevant files with reme_read. Record important facts and decisions with reme_write or reme_save_memory. Delete stale memory files or folders with reme_delete when the user asks; it reports surviving inbound wikilinks that may need fixing.

If ReMe is not running (connection refused), inform the user that ReMe memory is unavailable and suggest starting the ReMe service.`,
  });

  // ── reme_search ─────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "reme_search",
      description:
        "Search ReMe long-term memory for relevant content. Returns matching memory chunks with file paths, line ranges, and snippets. Use before answering questions about prior conversations, preferences, decisions, or project history.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "The search query (keywords or natural language question).",
        },
        limit: {
          type: "integer",
          description: `Maximum number of results to return. Default: ${resolved.searchLimit}.`,
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            results: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", required: true },
                  name: { type: "string" },
                  description: { type: "string" },
                  score: { type: "number" },
                  snippet: { type: "string" },
                  startLine: { type: "integer" },
                  endLine: { type: "integer" },
                },
              },
            },
            total: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: formatSearchOutput(value),
          },
        ],
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args) {
        const query = args.query.trim();
        if (!query) throw new Error("query must be a non-empty string");
        const limit = args.limit ?? resolved.searchLimit;

        const result = await callReme(baseUrl, "search", {
          query,
          limit,
        });

        // ReMe returns results in metadata.results; each has path, start_line, end_line, text, scores
        const rawResults = result.results ?? result.metadata?.results ?? [];
        const total = result.total ?? result.metadata?.counts?.returned ?? rawResults.length;

        const formatted = rawResults.slice(0, limit).map((r) => ({
          path: r.path ?? "",
          name: r.name ?? "",
          description: r.description ?? "",
          score: r.score ?? r.scores?.score ?? r.scores?.keyword ?? 0,
          snippet: (r.snippet ?? r.text ?? "").slice(0, 300),
          startLine: r.startLine ?? r.start_line,
          endLine: r.endLine ?? r.end_line,
        }));

        return {
          results: formatted,
          total,
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: args.query,
        kind: "search",
        rawInput: args.query,
      }),
    }),
  );

  // ── reme_read ───────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "reme_read",
      description:
        "Read a memory file from the ReMe workspace by its workspace-relative path. Returns the file content with frontmatter metadata. Use after reme_search to get full content of a relevant result.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description:
            "Workspace-relative path to the memory file (e.g., 'digest/wiki/topic.md' or 'daily/2025-01-15/notes.md').",
        },
        startLine: {
          type: "integer",
          description: "1-based starting line number (optional).",
        },
        endLine: {
          type: "integer",
          description: "1-based ending line number (optional).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            name: { type: "string" },
            description: { type: "string" },
            content: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `# ${value.name || value.path}\n\n${value.content}`,
          },
        ],
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!args.path?.trim())
          throw new Error("path must be a non-empty string");
        const payload = { path: args.path.trim() };
        if (args.startLine !== undefined)
          payload.start_line = args.startLine;
        if (args.endLine !== undefined) payload.end_line = args.endLine;

        const result = await callReme(baseUrl, "read", payload);

        // ReMe returns content in the answer field (full frontmatter + content)
        const content = result.content ?? result.answer ?? "";

        // Parse frontmatter to extract name and description
        let name = result.name ?? "";
        let description = result.description ?? "";
        if (!name && content.startsWith("---")) {
          const endFm = content.indexOf("---", 4);
          if (endFm > 0) {
            const fm = content.slice(4, endFm);
            const nameMatch = fm.match(/^name:\s*(.+)$/m);
            const descMatch = fm.match(/^description:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            if (descMatch) description = descMatch[1].trim();
          }
        }

        return {
          path: result.path ?? args.path,
          name,
          description,
          content,
        };
      },
    }),
  );

  // ── reme_write ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "reme_write",
      description:
        "Write a new memory file to the ReMe workspace. Creates a Markdown file with frontmatter. Use to record durable facts, user preferences, important decisions, or project context. Avoid storing secrets unless explicitly requested.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description:
            "Workspace-relative path (e.g., 'digest/wiki/my-topic.md' or 'daily/2025-01-15/decision.md').",
        },
        name: {
          type: "string",
          required: true,
          description: "Display name for this memory node.",
        },
        description: {
          type: "string",
          description: "Short description of this memory node.",
        },
        content: {
          type: "string",
          required: true,
          description: "Markdown content for this memory file.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            success: { type: "boolean", required: true },
            message: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.success
              ? `Memory written to ${value.path}`
              : `Failed to write memory: ${value.message}`,
          },
        ],
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!args.path?.trim())
          throw new Error("path must be a non-empty string");
        if (!args.name?.trim()) throw new Error("name must be a non-empty string");

        const result = await callReme(baseUrl, "write", {
          path: args.path.trim(),
          name: args.name.trim(),
          description: args.description?.trim() ?? "",
          content: args.content,
        });

        return {
          path: args.path.trim(),
          success: result.success ?? true,
          message: result.answer ?? result.message ?? "Written successfully",
        };
      },
    }),
  );

  // ── reme_save_memory ────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "reme_save_memory",
      description:
        "Save the current conversation turn to ReMe long-term memory. Distills useful facts from the conversation into daily memory cards. Requires ReMe LLM configuration. Use after a useful conversation to preserve what was learned.",
      parameters: {
        sessionId: {
          type: "string",
          required: true,
          description: "Stable session identifier for grouping related conversations.",
        },
        messages: {
          type: "array",
          required: true,
          description:
            "Array of conversation messages as [{role, content}, ...]. Roles: 'user', 'assistant'.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              role: { type: "string", required: true },
              content: { type: "string", required: true },
            },
          },
        },
        memoryHint: {
          type: "string",
          description: "Optional hint about why this conversation should be remembered.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            success: { type: "boolean", required: true },
            message: { type: "string" },
            dailyPath: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.success
              ? `Memory saved${value.dailyPath ? ` to ${value.dailyPath}` : ""}`
              : `Failed to save memory: ${value.message}`,
          },
        ],
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args) {
        if (!args.sessionId?.trim())
          throw new Error("sessionId must be a non-empty string");
        if (!Array.isArray(args.messages) || args.messages.length === 0)
          throw new Error("messages must be a non-empty array");

        const result = await callReme(baseUrl, "auto_memory", {
          session_id: args.sessionId.trim(),
          messages: args.messages,
          memory_hint: args.memoryHint?.trim() ?? "",
        });

        return {
          success: result.success ?? true,
          message: result.answer ?? result.message ?? "Saved successfully",
          dailyPath: result.daily_path ?? result.metadata?.daily_path ?? "",
        };
      },
    }),
  );

  // ── reme_proactive ──────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "reme_proactive",
      description:
        "Read proactive interest topics generated by ReMe's auto_dream consolidation. These topics suggest areas the agent may want to bring up proactively. The host agent decides whether and how to mention them.",
      parameters: {
        date: {
          type: "string",
          description:
            "Date in YYYY-MM-DD format to read topics for. Defaults to today.",
        },
        includeContent: {
          type: "boolean",
          description: "Whether to include full topic content. Default: false.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            topics: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  topic: { type: "string", required: true },
                  description: { type: "string" },
                  relatedPaths: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
              },
            },
            date: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.topics.length > 0
                ? `Proactive topics for ${value.date || "today"}:\n${value.topics.map((t) => `- **${t.topic}**: ${t.description || ""}`).join("\n")}`
                : "No proactive topics available.",
          },
        ],
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args) {
        const result = await callReme(baseUrl, "proactive", {
          date: args.date ?? "",
          include_content: args.includeContent ?? false,
        });

        // ReMe proactive returns topics in metadata.topics or in the answer
        const topics = result.topics ?? result.metadata?.topics ?? [];

        return {
          topics,
          date: result.date ?? result.metadata?.date ?? (args.date ?? ""),
        };
      },
    }),
  );

  // ── reme_dream ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "reme_dream",
      description:
        "Run ReMe auto_dream to consolidate daily notes into long-term digest memory and generate interest topics. This requires LLM credentials. Use periodically or when the user requests memory consolidation.",
      parameters: {
        date: {
          type: "string",
          description:
            "Date in YYYY-MM-DD format to consolidate. Defaults to today.",
        },
        hint: {
          type: "string",
          description: "Optional hint to guide the consolidation.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            success: { type: "boolean", required: true },
            message: { type: "string" },
            unitsExtracted: { type: "integer" },
            topicsGenerated: { type: "integer" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.success
              ? `Dream consolidation complete: ${value.unitsExtracted ?? 0} units extracted, ${value.topicsGenerated ?? 0} topics generated.`
              : `Dream consolidation failed: ${value.message}`,
          },
        ],
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = await callReme(baseUrl, "auto_dream", {
          date: args.date ?? "",
          hint: args.hint ?? "",
        });

        return {
          success: result.success ?? true,
          message: result.answer ?? result.message ?? "Consolidation complete",
          unitsExtracted: result.units_extracted ?? result.metadata?.units_extracted ?? 0,
          topicsGenerated: result.topics_generated ?? result.metadata?.topics_generated ?? 0,
        };
      },
    }),
  );

  // ── reme_delete ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "reme_delete",
      description:
        "Delete a memory file or folder from the ReMe workspace. Hard-deletes the path (workspace-relative, e.g., 'digest/wiki/topic.md' or 'daily/2026-08-14'). ReMe's watcher then prunes the affected chunks from the vector, keyword, and file-graph indexes automatically. Returns the surviving inbound wikilinks (other memories that referenced the deleted path) as a punch list for follow-up edits. Only delete when the user explicitly asks to remove memory; this is irreversible.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description:
            "Workspace-relative path of the file or folder to delete (e.g., 'digest/wiki/my-topic.md' or 'daily/2025-01-15').",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            success: { type: "boolean", required: true },
            message: { type: "string" },
            deletedFiles: {
              type: "array",
              items: { type: "string" },
            },
            inboundFilesTouched: { type: "integer" },
            inboundLinksTotal: { type: "integer" },
            inboundByFile: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string" },
                  count: { type: "integer" },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: formatDeleteOutput(value),
          },
        ],
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args) {
        if (!args.path?.trim())
          throw new Error("path must be a non-empty string");
        const path = args.path.trim().replace(/^\/+/, "");
        if (path === "" || path === ".")
          throw new Error("refusing to delete the workspace root");

        const result = await callReme(baseUrl, "delete", { path });
        const meta = result.metadata ?? {};
        const inbound = meta.inbound ?? {};
        const success = result.success ?? true;

        const byFile = (inbound.by_file ?? meta.by_file ?? []).map((row) => ({
          path: row.path ?? "",
          count: row.count ?? 0,
        }));

        return {
          path,
          success,
          message: result.answer ?? result.message ?? "Deleted",
          deletedFiles: meta.deleted_files ?? (success ? [path] : []),
          inboundFilesTouched: inbound.files_touched ?? 0,
          inboundLinksTotal: inbound.links_total ?? 0,
          inboundByFile: byFile,
        };
      },
    }),
  );
}

// ── ReMe HTTP client ──────────────────────────────────────────────────

/**
 * Call the ReMe HTTP API endpoint.
 * @param {string} baseUrl - The ReMe service base URL.
 * @param {string} action - The ReMe action/endpoint name.
 * @param {object} payload - The JSON payload to send.
 * @returns {Promise<object>} The parsed JSON response.
 */
async function callReme(baseUrl, action, payload) {
  try {
    const response = await fetch(`${baseUrl}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `ReMe API error (${response.status}): ${errorBody || response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      // Handle SSE streaming response
      return parseSseResponse(await response.text());
    }

    return response.json();
  } catch (error) {
    if (error.code === "ECONNREFUSED" || error.cause?.code === "ECONNREFUSED") {
      throw new Error(
        `ReMe service is not running at ${baseUrl}. Start it with: reme start`,
      );
    }
    if (error.message?.includes("fetch failed") || error.message?.includes("ECONNREFUSED")) {
      throw new Error(
        `ReMe service is not reachable at ${baseUrl}. Start it with: reme start`,
      );
    }
    throw error;
  }
}

/**
 * Parse an SSE streaming response into a consolidated result object.
 * ReMe streams content chunks and ends with [DONE].
 */
function parseSseResponse(text) {
  const lines = text.split("\n");
  let content = "";
  let metadata = {};

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (dataStr === "[DONE]") break;

    try {
      const data = JSON.parse(dataStr);
      // Accumulate content chunks
      if (data.chunk_type === "content" || data.chunk_type === "CONTENT") {
        content += data.chunk ?? "";
      }
      // Capture metadata chunks
      if (data.chunk_type === "metadata" || data.chunk_type === "METADATA") {
        metadata = { ...metadata, ...(data.chunk ?? {}) };
      }
      // Error chunks
      if (data.chunk_type === "error" || data.chunk_type === "ERROR") {
        throw new Error(data.chunk ?? "Unknown error");
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue; // Skip non-JSON lines
      throw e;
    }
  }

  // If we got structured metadata, return it; otherwise return the raw content
  if (Object.keys(metadata).length > 0) {
    return metadata;
  }

  // Try to parse the accumulated content as JSON
  try {
    return JSON.parse(content);
  } catch {
    return { content };
  }
}

// ── Output formatting helpers ─────────────────────────────────────────

/** Format search results for model-facing text output. */
function formatSearchOutput(value) {
  const { results, total } = value;
  if (!results || results.length === 0) {
    return `No memory results found (searched ${total ?? 0} total).`;
  }

  const lines = results
    .map((r, i) => {
      const header = `${i + 1}. **${r.name || r.path}**`;
      const path = r.path ? `   Path: \`${r.path}\`` : "";
      const desc = r.description ? `   Description: ${r.description}` : "";
      const snippet = r.snippet ? `   Snippet: ${r.snippet}` : "";
      const range =
        r.startLine !== undefined && r.endLine !== undefined
          ? `   Lines: ${r.startLine}-${r.endLine}`
          : "";
      return [header, path, desc, snippet, range].filter(Boolean).join("\n");
    })
    .join("\n\n");

  return `${results.length} of ${total} results:\n\n${lines}\n\nUse reme_read to get the full content of a file by its path.`;
}

/** Format delete results for model-facing text output. */
function formatDeleteOutput(value) {
  if (!value.success) {
    return `Failed to delete ${value.path}: ${value.message}`;
  }

  const files = value.deletedFiles ?? [];
  const fileLine =
    files.length === 1
      ? `Deleted \`${files[0]}\`.`
      : `Deleted ${files.length} file(s): ${files.map((f) => `\`${f}\``).join(", ")}.`;

  const inbound = value.inboundByFile ?? [];
  if (inbound.length === 0) {
    return `${fileLine}\nNo surviving inbound wikilinks — no follow-up needed.`;
  }

  const rows = inbound
    .map((row) => `- \`${row.path}\` (${row.count} link${row.count === 1 ? "" : "s"})`)
    .join("\n");

  return (
    `${fileLine}\n` +
    `Surviving inbound wikilinks in ${inbound.length} file(s) may now dangle (total: ${value.inboundLinksTotal ?? inbound.reduce((s, r) => s + r.count, 0)}):\n` +
    rows +
    `\nDecide per reference whether to fix it (reme_write/reme_read) or accept it as dangling.`
  );
}
