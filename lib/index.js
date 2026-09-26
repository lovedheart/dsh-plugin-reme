import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  REME_TIMEOUT_MS,
  REME_LLM_TIMEOUT_MS,
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
  // auto_memory / auto_dream run server-side LLM distillation that can take
  // minutes; give them a longer floor so a slow service isn't a false failure.
  const llmTimeoutMs = Math.max(resolved.timeoutMs, REME_LLM_TIMEOUT_MS);

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
      timeoutMs: llmTimeoutMs,
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
          // ReMe builds AgentScope Msg objects, which require a `name`;
          // defaulting it to the role keeps the tool's surface unchanged.
          return { role: m.role, name: m.role, content: m.content };
        });

        const result = await callReme(
          baseUrl,
          "auto_memory",
          {
            session_id: args.sessionId.trim(),
            messages,
            memory_hint: args.memoryHint?.trim() ?? "",
          },
          llmTimeoutMs,
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
          "proactive_read",
          {
            date,
            include_content: args.includeContent ?? false,
          },
          resolved.timeoutMs,
        );

        // ReMe returns topics in metadata.topics (objects or plain strings)
        const topics = firstArray(result.topics, result.metadata?.topics).map((t) =>
          typeof t === "string"
            ? { topic: t, description: "" }
            : {
                topic: t?.topic ?? t?.name ?? "",
                description: t?.description ?? "",
                ...(t?.related_paths ?? t?.relatedPaths
                  ? { relatedPaths: firstArray(t.related_paths, t.relatedPaths) }
                  : {}),
              },
        );

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
      timeoutMs: llmTimeoutMs,
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
          llmTimeoutMs,
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

  // ── Remaining upstream jobs (table-driven thin wrappers) ────────────
  // One ReMe job == one HTTP endpoint (POST /{job}); these wrap the 25
  // upstream jobs the hand-written tools above do not cover. Conventions
  // match the hand-written tools: paths go through normalizeWorkspacePath,
  // dates through validateDate; mutating tools report a derived success
  // flag instead of trusting an empty payload; large structured metadata
  // is JSON-stringified into `data` and capped so one call cannot flood
  // the context.
  const DATA_CAP = 16000;

  function simpleTool(spec) {
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters ?? {},
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              answer: { type: "string", required: true },
              data: { type: "string" },
            },
          },
          render: (_args, value) => [
            { type: "text", text: value.data ? `${value.answer}\n${value.data}` : value.answer },
          ],
        },
        timeoutMs: spec.llm ? llmTimeoutMs : resolved.timeoutMs,
        isConcurrencySafe: () => spec.safe !== false,
        async execute(args) {
          const payload = spec.payload ? spec.payload(args) : passthrough(spec, args);
          const result = await callReme(
            baseUrl,
            spec.job,
            payload,
            spec.llm ? llmTimeoutMs : resolved.timeoutMs,
          );
          const rawAnswer = result.answer ?? result.message ?? "";
          const answer =
            typeof rawAnswer === "string" ? rawAnswer : JSON.stringify(rawAnswer);
          if (result.success === false && !spec.mutating)
            throw new Error(`${spec.name} failed: ${answer || "no detail"}`);
          const ok = spec.mutating ? deriveSuccess(result) : true;
          const meta = result.metadata;
          let data;
          if (meta && typeof meta === "object" && Object.keys(meta).length > 0) {
            data = JSON.stringify(meta);
            if (data.length > DATA_CAP)
              data = `${data.slice(0, DATA_CAP)}… [truncated, ${data.length} bytes total]`;
          }
          return { ok, answer, ...(data ? { data } : {}) };
        },
      }),
    );
  }

  /** Map camelCase tool args to the job's snake_case payload when names differ. */
  function passthrough(spec, args) {
    const payload = {};
    for (const [toolKey, jobKey] of Object.entries(spec.fields ?? {})) {
      if (args[toolKey] !== undefined) payload[jobKey] = args[toolKey];
    }
    for (const key of spec.passthrough ?? []) {
      if (args[key] !== undefined) payload[key] = args[key];
    }
    return payload;
  }

  const PATH_DESC =
    "Workspace-relative path (e.g., 'digest/wiki/topic.md' or 'daily/2025-01-15').";
  const DATE_DESC = "Optional YYYY-MM-DD day; empty defaults to today.";

  // ── read-only / retrieval ───────────────────────────────────────────
  simpleTool({
    name: "reme_traverse",
    job: "traverse",
    description:
      "Traverse the memory wikilink graph from seed path(s) and return a bounded node/edge view. Use to explore how memory files reference each other (link chains, backlinks).",
    parameters: {
      paths: {
        type: "array",
        required: true,
        items: { type: "string" },
        description: `Seed path(s), ${PATH_DESC}`,
      },
      depth: { type: "integer", description: "Maximum wikilink hops (default 1)." },
      direction: {
        type: "string",
        enum: ["forward", "backward", "both"],
        description: "Traversal direction; edges are returned in their original direction either way. Default both.",
      },
    },
    payload: (a) => ({
      path: a.paths.map(normalizeWorkspacePath),
      ...(a.depth !== undefined ? { depth: a.depth } : {}),
      ...(a.direction !== undefined ? { direction: a.direction } : {}),
    }),
  });

  simpleTool({
    name: "reme_graph_snapshot",
    job: "graph_snapshot",
    description:
      "Return the whole memory wikilink graph: category-rooted digest nodes with daily-note leaves and directed edges. Use for a global map of the knowledge base.",
  });

  simpleTool({
    name: "reme_list_tags",
    job: "list_tags",
    description:
      "List tags used across memory files with per-tag file counts, paginated. Use to discover how the knowledge base is categorized.",
    parameters: {
      page: { type: "integer", description: "1-based page; pages past the end return an empty list. Default 1." },
      order_by: { type: "string", enum: ["tag", "file_count"], description: "Sort key. Default tag." },
      order: { type: "string", enum: ["asc", "desc"], description: "Sort order (asc defaults for tag, desc for file_count)." },
      page_size: { type: "integer", description: "Items per page (max 1000). Default 100." },
    },
    passthrough: ["page", "order_by", "order", "page_size"],
  });

  simpleTool({
    name: "reme_node_search",
    job: "node_search",
    description:
      "Digest-node recall: given a candidate abstraction's name/description, surface similar existing digest nodes to deduplicate against or link as related. Use before creating a new digest abstraction.",
    parameters: {
      query: { type: "string", required: true, description: "Candidate abstraction name + description." },
      limit: { type: "integer", description: "Maximum digest nodes to return. Default 20." },
    },
    passthrough: ["query", "limit"],
  });

  simpleTool({
    name: "reme_list",
    job: "list",
    description: "List files under a workspace path. Use to browse daily/ or digest/ folders.",
    parameters: {
      path: { type: "string", description: `Workspace-relative directory; empty lists the root.` },
      recursive: { type: "boolean", description: "Recurse into subdirectories." },
      sort_by: { type: "string", enum: ["mtime"], description: "Order by modification time (newest first)." },
      extensions: { type: "array", items: { type: "string" }, description: "Extension allowlist, e.g. ['.md']." },
      limit: { type: "integer", description: "Maximum results. Default 100." },
    },
    payload: (a) => ({
      ...(a.path ? { path: normalizeWorkspacePath(a.path) } : {}),
      ...(a.recursive !== undefined ? { recursive: a.recursive } : {}),
      ...(a.sort_by !== undefined ? { sort_by: a.sort_by } : {}),
      ...(a.extensions !== undefined ? { extensions: a.extensions } : {}),
      ...(a.limit !== undefined ? { limit: a.limit } : {}),
    }),
  });

  simpleTool({
    name: "reme_stat",
    job: "stat",
    description: "Stat a workspace path: size, mtime, exists, is_dir/is_file. Use before writes or to verify a file exists.",
    parameters: { path: { type: "string", required: true, description: PATH_DESC } },
    payload: (a) => ({ path: normalizeWorkspacePath(a.path) }),
  });

  simpleTool({
    name: "reme_load",
    job: "load",
    description:
      "Load a complete text file verbatim without agent-output truncation (the answer is the raw content). Use when reme_read's rendering loses fidelity for long files.",
    parameters: { path: { type: "string", required: true, description: PATH_DESC } },
    payload: (a) => ({ path: normalizeWorkspacePath(a.path) }),
  });

  simpleTool({
    name: "reme_frontmatter_read",
    job: "frontmatter_read",
    description: "Read a memory file's frontmatter as a key/value map without loading the body. Use to check a note's name, description, tags, or dates cheaply.",
    parameters: { path: { type: "string", required: true, description: PATH_DESC } },
    payload: (a) => ({ path: normalizeWorkspacePath(a.path) }),
  });

  simpleTool({
    name: "reme_daily_list",
    job: "daily_list",
    description: "List the note files under one day's daily/ folder.",
    parameters: { date: { type: "string", description: DATE_DESC } },
    payload: (a) => ({ date: validateDate(a.date) }),
  });

  simpleTool({
    name: "reme_read_image",
    job: "read_image",
    description:
      "Read an image file under the ReMe workspace; returns its metadata and absolute path (base64 stays server-side). To actually view it, open the absolute path with the native image tools.",
    parameters: { path: { type: "string", required: true, description: PATH_DESC } },
    payload: (a) => ({ path: normalizeWorkspacePath(a.path) }),
  });

  // ── diagnostics / maintenance ───────────────────────────────────────
  simpleTool({
    name: "reme_health_check",
    job: "health_check",
    description: "Return a health snapshot of ReMe components (indexes, stores, node counts). Use to diagnose memory issues.",
  });

  simpleTool({
    name: "reme_status",
    job: "status",
    description: "Report estimated memory usage of ReMe's stateful data components and process RSS.",
  });

  simpleTool({
    name: "reme_version",
    job: "version",
    description: "Return the installed ReMe package version.",
  });

  simpleTool({
    name: "reme_help",
    job: "help",
    description: "List all ReMe server jobs with their parameters — the authoritative catalog of what the ReMe service can do.",
  });

  simpleTool({
    name: "reme_app_config",
    job: "app_config",
    description: "Return the effective ReMe application config with secrets redacted (workspace dir, jobs, services).",
  });

  simpleTool({
    name: "reme_reindex",
    job: "reindex",
    description:
      "Rebuild the BM25 / embedding / tag indexes from existing indexed files without rescanning the workspace. Use after suspecting index drift, not after every write (the watcher handles that).",
    parameters: { scope: { type: "string", enum: ["all", "bm25", "embedding", "tag"], description: "Which index to rebuild. Default all." } },
    passthrough: ["scope"],
    safe: false,
    llm: true,
  });

  simpleTool({
    name: "reme_daily_reindex",
    job: "daily_reindex",
    description: "Rebuild one day's day-index page (daily/<date>.md) from the notes in that folder.",
    parameters: { date: { type: "string", description: DATE_DESC } },
    payload: (a) => ({ date: validateDate(a.date) }),
    safe: false,
  });

  // ── mutation ────────────────────────────────────────────────────────
  simpleTool({
    name: "reme_save",
    job: "save",
    description:
      "Save text verbatim to a workspace file (no frontmatter added). Optionally rejects the write if the file changed externally since `expectedMtime` (from reme_stat).",
    parameters: {
      path: { type: "string", required: true, description: PATH_DESC },
      content: { type: "string", required: true, description: "Complete file content, saved exactly as given." },
      expectedMtime: { type: "string", description: "Optional ISO mtime from reme_stat; the write fails if the file is newer." },
    },
    fields: { path: "path", content: "content", expectedMtime: "expected_mtime" },
    mutating: true,
    safe: false,
  });

  simpleTool({
    name: "reme_edit",
    job: "edit",
    description: "Find-and-replace literal text in a memory markdown file (all occurrences). Use for surgical frontmatter or wikilink fixes.",
    parameters: {
      path: { type: "string", required: true, description: PATH_DESC },
      oldString: { type: "string", required: true, description: "Text to find." },
      newString: { type: "string", description: "Replacement (empty deletes the match). Default empty." },
    },
    payload: (a) => ({
      path: normalizeWorkspacePath(a.path),
      old: a.oldString,
      ...(a.newString !== undefined ? { new: a.newString } : {}),
    }),
    mutating: true,
    safe: false,
  });

  simpleTool({
    name: "reme_move",
    job: "move",
    description:
      "Move/rename a workspace file or folder. By default rewrites [[wikilinks]] pointing at the old path across the workspace. dst_path needs a directory component.",
    parameters: {
      srcPath: { type: "string", required: true, description: PATH_DESC },
      dstPath: { type: "string", required: true, description: "Destination path (must include a directory)." },
      overwrite: { type: "boolean", description: "Overwrite an existing destination. Default false." },
      retarget: { type: "boolean", description: "Rewrite inbound wikilinks src→dst. Default true." },
    },
    payload: (a) => ({
      src_path: normalizeWorkspacePath(a.srcPath),
      dst_path: normalizeWorkspacePath(a.dstPath),
      ...(a.overwrite !== undefined ? { overwrite: a.overwrite } : {}),
      ...(a.retarget !== undefined ? { retarget: a.retarget } : {}),
    }),
    mutating: true,
    safe: false,
  });

  simpleTool({
    name: "reme_frontmatter_update",
    job: "frontmatter_update",
    description: "Merge key/value pairs into a memory file's frontmatter, preserving body and unrelated fields. Use for tags, names, dates.",
    parameters: {
      path: { type: "string", required: true, description: PATH_DESC },
      metadata: { type: "object", required: true, additionalProperties: true, description: "Key/values to merge into the frontmatter." },
    },
    payload: (a) => ({ path: normalizeWorkspacePath(a.path), metadata: a.metadata }),
    mutating: true,
    safe: false,
  });

  simpleTool({
    name: "reme_frontmatter_delete",
    job: "frontmatter_delete",
    description: "Drop named keys from a memory file's frontmatter.",
    parameters: {
      path: { type: "string", required: true, description: PATH_DESC },
      keys: { type: "array", required: true, items: { type: "string" }, description: "Frontmatter keys to remove." },
    },
    payload: (a) => ({ path: normalizeWorkspacePath(a.path), keys: a.keys }),
    mutating: true,
    safe: false,
  });

  simpleTool({
    name: "reme_daily_write",
    job: "daily_write",
    description:
      "Write a daily markdown note (daily/<date>/<name>.md) with conversation-source frontmatter. Use for session checkpoints tied to a day rather than a durable digest page.",
    parameters: {
      name: { type: "string", required: true, description: "Note filename stem and frontmatter name." },
      description: { type: "string", required: true, description: "Frontmatter description." },
      sessionId: { type: "string", required: true, description: "Source conversation session id stored in frontmatter." },
      content: { type: "string", required: true, description: "Note body." },
      date: { type: "string", description: DATE_DESC },
      metadata: { type: "object", additionalProperties: true, description: "Optional extra frontmatter fields." },
    },
    payload: (a) => ({
      name: a.name,
      description: a.description,
      session_id: a.sessionId,
      content: a.content,
      date: validateDate(a.date),
      ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
    }),
    mutating: true,
    safe: false,
  });

  // ── LLM-backed server-side jobs ─────────────────────────────────────
  simpleTool({
    name: "reme_dream_cc",
    job: "auto_memory_cc",
    description:
      "Auto-memory (Claude Code): record a Claude Code session into a daily note; the transcript is resolved server-side from its session id. Use when summarizing a Claude Code session.",
    parameters: {
      sessionId: { type: "string", required: true, description: "Claude Code session id whose transcript should be recorded." },
      memoryHint: { type: "string", description: "Optional hint about what to remember." },
    },
    fields: { sessionId: "session_id", memoryHint: "memory_hint" },
    mutating: true,
    safe: false,
    llm: true,
  });

  simpleTool({
    name: "reme_resource",
    job: "auto_resource",
    description:
      "Auto-resource: interpret a batch of changed resource files (added/modified/deleted) into daily notes. Normally the resource watcher does this; call it to replay a batch manually.",
    parameters: {
      changes: {
        type: "array",
        required: true,
        description: "Change batch; each entry has a workspace path and a change kind.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true, description: "Resource file path." },
            change: { type: "string", required: true, enum: ["added", "modified", "deleted"], description: "Change kind." },
          },
        },
      },
    },
    passthrough: ["changes"],
    mutating: true,
    safe: false,
    llm: true,
  });
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
