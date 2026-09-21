import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  REME_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_MEMORY_MESSAGES,
} from "./constants.js";

export { apply, name, inject, Config };

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-reme";

/** Services required by the ReMe tool suite. */
const inject = ["tools", "systemPrompt"];

/** Plugin configuration schema. */
const Config = z.object({
  host: z.string().default(DEFAULT_HOST),
  port: z.number().default(DEFAULT_PORT),
  searchLimit: z.number().default(DEFAULT_SEARCH_LIMIT),
  timeoutMs: z.number().default(REME_TIMEOUT_MS),
});

/**
 * Apply the ReMe tools to the given context.
 * Registers model-facing tools and system prompt sections.
 */
function apply(ctx, config) {
  // The Cordis loader applies Config defaults before calling apply(); the
  // fallbacks below keep the plugin functional (and error messages sane) if
  // it is ever mounted with a partial config object.
  const resolved = {
    host: config?.host ?? DEFAULT_HOST,
    port: config?.port ?? DEFAULT_PORT,
    searchLimit: config?.searchLimit ?? DEFAULT_SEARCH_LIMIT,
    timeoutMs: config?.timeoutMs ?? REME_TIMEOUT_MS,
  };
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
        const limit = Math.max(
          1,
          Math.min(
            Math.trunc(Number.isFinite(args.limit) ? args.limit : resolved.searchLimit),
            MAX_SEARCH_LIMIT,
          ),
        );

        const result = await callReme(
          baseUrl,
          "search",
          { query, limit },
          resolved.timeoutMs,
        );

        // ReMe returns results in metadata.results; each has path, start_line, end_line, text, scores
        const rawResults = firstArray(result.results, result.metadata?.results);
        const total = result.total ?? result.metadata?.counts?.returned ?? rawResults.length;

        const formatted = rawResults
          .slice(0, limit)
          .filter((r) => r && typeof r === "object")
          .map((r) => ({
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
        const path = normalizeWorkspacePath(args.path);
        const payload = { path };
        for (const key of ["startLine", "endLine"]) {
          if (args[key] !== undefined) {
            const n = args[key];
            if (!Number.isInteger(n) || n < 1)
              throw new Error(`${key} must be a positive integer`);
            payload[key === "startLine" ? "start_line" : "end_line"] = n;
          }
        }
        if (payload.start_line !== undefined && payload.end_line !== undefined && payload.start_line > payload.end_line)
          throw new Error("startLine must not exceed endLine");

        const result = await callReme(baseUrl, "read", payload, resolved.timeoutMs);

        // Surface server-reported failures (e.g. missing file) as errors
        // instead of returning "Error: ..." text as if it were file content.
        if (result.success === false || /^\s*error\b/i.test(String(result.answer ?? "")))
          throw new Error(
            `ReMe read failed for ${path}: ${result.answer ?? result.message ?? "unknown error"}`,
          );

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
          path: result.path ?? path,
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
      isConcurrencySafe: () => false,
      async execute(args) {
        const path = normalizeWorkspacePath(args.path);
        if (!args.name?.trim()) throw new Error("name must be a non-empty string");

        const result = await callReme(
          baseUrl,
          "write",
          {
            path,
            name: args.name.trim(),
            description: args.description?.trim() ?? "",
            content: args.content,
          },
          resolved.timeoutMs,
        );

        const success = deriveSuccess(result);
        return {
          path,
          success,
          message:
            result.answer ??
            result.message ??
            (success ? "Written successfully" : "ReMe returned no confirmation"),
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
        if (args.messages.length > MAX_MEMORY_MESSAGES)
          throw new Error(`messages must not exceed ${MAX_MEMORY_MESSAGES} entries`);
        const messages = args.messages.map((m, i) => {
          if (!m || typeof m.role !== "string" || typeof m.content !== "string")
            throw new Error(`messages[${i}] must be { role, content } with string values`);
          return { role: m.role, content: m.content };
        });

        const result = await callReme(
          baseUrl,
          "auto_memory",
          {
            session_id: args.sessionId.trim(),
            messages,
            memory_hint: args.memoryHint?.trim() ?? "",
          },
          resolved.timeoutMs,
        );

        const success = deriveSuccess(result);
        return {
          success,
          message:
            result.answer ??
            result.message ??
            (success ? "Saved successfully" : "ReMe returned no confirmation"),
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
        const date = validateDate(args.date);

        const result = await callReme(
          baseUrl,
          "proactive",
          {
            date,
            include_content: args.includeContent ?? false,
          },
          resolved.timeoutMs,
        );

        // ReMe proactive returns topics in metadata.topics or in the answer
        const topics = firstArray(result.topics, result.metadata?.topics).map((t) => ({
          topic: t?.topic ?? "",
          description: t?.description ?? "",
          ...(t?.related_paths ?? t?.relatedPaths
            ? { relatedPaths: firstArray(t.related_paths, t.relatedPaths) }
            : {}),
        }));

        return {
          topics,
          date: result.date ?? result.metadata?.date ?? date,
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
        const date = validateDate(args.date);

        const result = await callReme(
          baseUrl,
          "auto_dream",
          {
            date,
            hint: args.hint ?? "",
          },
          resolved.timeoutMs,
        );

        const success = deriveSuccess(result);
        return {
          success,
          message:
            result.answer ??
            result.message ??
            (success ? "Consolidation complete" : "ReMe returned no confirmation"),
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
        const path = normalizeWorkspacePath(args.path);

        const result = await callReme(baseUrl, "delete", { path }, resolved.timeoutMs);
        const meta = result.metadata ?? {};
        const inbound = meta.inbound ?? {};
        // meta.deleted is the server's explicit confirmation; never default to true.
        const success =
          typeof meta.deleted === "boolean" ? meta.deleted : deriveSuccess(result);

        const byFile = firstArray(inbound.by_file, meta.by_file).map((row) => ({
          path: row?.path ?? "",
          count: row?.count ?? 0,
        }));

        return {
          path,
          success,
          message:
            result.answer ??
            result.message ??
            (success ? "Deleted" : "ReMe returned no confirmation"),
          deletedFiles: firstArray(meta.deleted_files, success ? [path] : []),
          inboundFilesTouched: inbound.files_touched ?? 0,
          inboundLinksTotal: inbound.links_total ?? 0,
          inboundByFile: byFile,
        };
      },
    }),
  );
}

// ── Shared validation helpers ─────────────────────────────────────────

/**
 * Normalize a workspace-relative path: strip leading/trailing slashes,
 * convert backslashes, and reject traversal or absolute paths. The ReMe
 * server also blocks '..' components, but enforce it client-side so all
 * path-taking tools behave identically and fail with clear errors.
 */
function normalizeWorkspacePath(raw) {
  if (typeof raw !== "string" || !raw.trim())
    throw new Error("path must be a non-empty string");
  const path = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (path === "" || path === ".")
    throw new Error("path must target a file or folder inside the workspace");
  if (/^[a-zA-Z]:/.test(path))
    throw new Error("path must be workspace-relative, not absolute");
  if (path.split("/").some((s) => s === ".." || s === "." || s === ""))
    throw new Error("path must be workspace-relative without '.' or '..' segments");
  return path;
}

/** Validate an optional YYYY-MM-DD date argument (empty/undefined allowed). */
function validateDate(value, name = "date") {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${name} must be in YYYY-MM-DD format`);
  return value;
}

/**
 * Derive mutation success from a ReMe response without defaulting to true:
 * trust an explicit boolean, otherwise fail on an "Error ..." answer or an
 * empty payload (unknown outcome is treated as failure, not success).
 */
function deriveSuccess(result) {
  if (typeof result?.success === "boolean") return result.success;
  if (/^\s*error\b/i.test(String(result?.answer ?? ""))) return false;
  return (
    typeof result === "object" && result !== null && Object.keys(result).length > 0
  );
}

/** First array among candidates, or []. Guards against non-array server shapes. */
function firstArray(...candidates) {
  return candidates.find(Array.isArray) ?? [];
}

/**
 * Call the ReMe HTTP API endpoint with a hard timeout so a hung server
 * cannot wedge the tool (and its socket) indefinitely.
 * @param {string} baseUrl - The ReMe service base URL.
 * @param {string} action - The ReMe action/endpoint name.
 * @param {object} payload - The JSON payload to send.
 * @param {number} timeoutMs - Request timeout in milliseconds.
 * @returns {Promise<object>} The parsed JSON response.
 */
async function callReme(baseUrl, action, payload, timeoutMs = REME_TIMEOUT_MS) {
  try {
    const response = await fetch(`${baseUrl}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorBody = ((await response.text().catch(() => "")) || "").slice(0, 500);
      throw new Error(
        `ReMe API error (${response.status}) for ${action}: ${errorBody || response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      // Handle SSE streaming response
      return parseSseResponse(await response.text());
    }

    const bodyText = await response.text();
    if (!bodyText.trim()) return {};
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new Error(
        `ReMe API returned a non-JSON response for ${action}: ${bodyText.slice(0, 200)}`,
      );
    }
  } catch (error) {
    // Errors already classified above keep their message.
    if (typeof error?.message === "string" && error.message.startsWith("ReMe API"))
      throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      const err = new Error(
        `ReMe request to ${baseUrl}/${action} timed out after ${timeoutMs}ms. Is the service busy or wedged?`,
      );
      err.cause = error;
      throw err;
    }
    const code = error?.cause?.code ?? error?.code;
    const unreachable =
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ECONNRESET" ||
      code === "EHOSTUNREACH" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      /fetch failed|ECONNREFUSED/.test(String(error?.message ?? ""));
    if (unreachable) {
      const err = new Error(
        `ReMe service is not reachable at ${baseUrl}. Start it with: reme start`,
      );
      err.cause = error;
      throw err;
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

    let data;
    try {
      data = JSON.parse(dataStr);
    } catch {
      continue; // Skip keepalive/comment/non-JSON lines
    }
    const kind = String(data.chunk_type ?? "").toLowerCase();
    if (kind === "content") {
      content += typeof data.chunk === "string" ? data.chunk : "";
    } else if (kind === "metadata") {
      metadata = {
        ...metadata,
        ...(data.chunk && typeof data.chunk === "object" ? data.chunk : {}),
      };
    } else if (kind === "error") {
      throw new Error(
        typeof data.chunk === "string"
          ? data.chunk
          : data.chunk !== undefined
            ? JSON.stringify(data.chunk)
            : "Unknown error",
      );
    }
  }

  // Merge metadata with any streamed content so neither is silently lost.
  if (Object.keys(metadata).length > 0) {
    if (content && metadata.content === undefined && metadata.answer === undefined) {
      return { ...metadata, content };
    }
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
