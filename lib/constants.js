/** Default timeout for ReMe tool calls (60 seconds). Source of truth for the Config default and the callReme fallback. */
export const REME_TIMEOUT_MS = 60000;

/**
 * Timeout for the LLM-backed tools (auto_memory / auto_dream), which run
 * server-side distillation and routinely exceed the plain API timeout.
 * Applied only to those tools — never shortens an explicitly configured value.
 */
export const REME_LLM_TIMEOUT_MS = 300000;

/** Default host/port for the ReMe service. */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 2333;

/** Default search result limit. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Upper bound for a single search page, so a bogus `limit` cannot disable the cap. */
export const MAX_SEARCH_LIMIT = 100;

/** Upper bound on conversation turns forwarded to `auto_memory` in one call. */
export const MAX_MEMORY_MESSAGES = 200;
