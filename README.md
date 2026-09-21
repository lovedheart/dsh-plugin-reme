# dsh-plugin-reme

DeepSeek Harness plugin for [ReMe](https://github.com/agentscope-ai/ReMe) long-term memory integration.

## Overview

This plugin integrates ReMe's file-based long-term memory system into DeepSeek Harness, giving the agent seven model-facing tools to search, read, write, delete, and consolidate durable knowledge stored as Markdown files.

### Tools Provided

| Tool | Description |
|------|-------------|
| `reme_search` | Search ReMe memory by keyword/query (BM25) |
| `reme_read` | Read a memory file by workspace path |
| `reme_write` | Write a new memory file with frontmatter |
| `reme_save_memory` | Save conversation turns into daily memory cards |
| `reme_proactive` | Read proactive interest topics from auto_dream |
| `reme_dream` | Consolidate daily notes into long-term digest memory |
| `reme_delete` | Hard-delete a memory file or folder, reporting surviving inbound wikilinks |

## Prerequisites

1. **DeepSeek Harness** installed (`dsh` CLI available)
2. **ReMe** installed (`pip install "reme-ai[core]"`)
3. **pnpm** available (for DSH plugin management)

## Installation

### From Local Path (Development)

```bash
# Navigate to the plugin directory
cd /path/to/dsh-plugin-reme

# Add the plugin to your DSH profile
dsh plugin --profile web add ./dsh-plugin-reme
```

### From Git Repository

```bash
dsh plugin --profile web add git+https://github.com/yourusername/dsh-plugin-reme.git
```

### From npm Registry (When Published)

```bash
dsh plugin --profile web add dsh-plugin-reme
```

## Configuration

The plugin reads its configuration from the `cordis.patch.yml` patch entry. Override defaults by adding a patch in your profile's `cordis.patch.yml`:

```yaml
- id: tool-reme
  config:
    host: '127.0.0.1'      # ReMe service host
    port: 2333             # ReMe service port
    searchLimit: 5         # Default search result limit
    timeoutMs: 60000       # Tool call timeout in milliseconds
```

## Usage

### 1. 安装插件

```bash
dsh plugin --profile web add ./dsh-plugin-reme
```

### 2. 启动 ReMe 服务

插件只是 HTTP 客户端，需要 ReMe 服务在运行。

**基础启动（只有 BM25 关键词搜索）：**
```bash
reme start
```

**启用向量检索 + LLM（推荐）：**
```bash
reme start \
  "components.as_embedding.default.backend=openai" \
  "components.as_embedding.default.model=你的embedding模型" \
  "components.as_embedding.default.dimensions=维度" \
  "components.as_embedding.default.credential.api_key=sk-placeholder" \
  "components.as_embedding.default.credential.base_url=http://你的embedding端点/v1" \
  "components.embedding_store.default.backend=local" \
  "components.embedding_store.default.as_embedding=default" \
  "components.file_store.default.embedding_store=default"
```

> ⚠️ **不要用 `config=file.yaml` 覆盖整个 `components` 段**，这会导致内置组件（`file_graph`、`keyword_index`）丢失，启动失败。

首次启用 embedding 需要重建索引：
```bash
reme reindex
```

### 3. 验证

```bash
reme search query="测试" limit=3
# counts 中显示 "hybrid": true 说明向量检索生效
```

### Example Agent Workflows

1. **Search before answering**: The agent searches ReMe for relevant prior context before answering questions about project history or user preferences.

2. **Save after useful conversations**: After a productive exchange, the agent calls `reme_save_memory` to distill key facts into daily memory cards.

3. **Periodic consolidation**: The agent runs `reme_dream` to merge daily notes into long-term digest knowledge nodes.

4. **Proactive recall**: The agent checks `reme_proactive` to discover interest topics it should bring up.

## Project Structure

```
dsh-plugin-reme/
├── package.json              # Package manifest with dsh.bundle declaration
├── cordis.patch.yml          # Cordis loader patch (entry registration)
├── reme-start-commands.md  # ReMe 启动参数参考（CLI）
├── lib/
│   ├── index.js              # Main plugin entry (tool registrations)
│   └── constants.js          # Shared constants
└── skills/
    └── reme_memory/
        └── SKILL.md          # Agent skill documentation
```

## How It Works

1. **Cordis Patch**: The `cordis.patch.yml` declares an entry that loads the `dsh-plugin-reme` module
2. **Tool Registration**: On activation, the module registers 7 tools with `ctx.tools.register()` and adds system prompt guidance via `ctx.systemPrompt.section()`
3. **HTTP Client**: Tool executions call the ReMe HTTP API (`POST /{action}`) on the configured host:port
4. **Streaming Support**: The client handles both JSON and SSE streaming responses from ReMe

## License

MIT
