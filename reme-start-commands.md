# ReMe 服务配置 — 对接本地端点
#
# 使用方法（推荐 CLI 参数，不覆盖内置组件）：
#
#   reme start \
#     "components.as_embedding.default.backend=openai" \
#     "components.as_embedding.default.model=jina-v5-small" \
#     "components.as_embedding.default.dimensions=1024" \
#     "components.as_embedding.default.credential.api_key=sk-placeholder" \
#     "components.as_embedding.default.credential.base_url=http://127.0.0.1:8999/v1" \
#     "components.embedding_store.default.backend=local" \
#     "components.embedding_store.default.as_embedding=default" \
#     "components.file_store.default.embedding_store=default" \
#     "components.as_llm.default.backend=openai" \
#     "components.as_llm.default.model=Qwen3.6-27B" \
#     "components.as_llm.default.context_size=1000000" \
#     "components.as_llm.default.credential.api_key=sk-placeholder" \
#     "components.as_llm.default.credential.base_url=http://127.0.0.1:8070/v1" \
#     "components.as_llm.default.parameters.max_tokens=8192"
#
# 注意：不要用 config=file.yaml 覆盖整个 components 段，
# 否则 file_graph / keyword_index / tokenizer 等内置组件会被清空，
# 导致启动失败（AssertionError: file_graph is not None）。
