/**
 * Unit + contract tests for dsh-plugin-reme.
 * Runs the real plugin against a fake ReMe HTTP server (no service needed).
 * Covers: registration shape, path normalization, argument validation,
 * success inference, timeout, non-JSON/SSE handling, and error mapping.
 *
 * Note: tool.execute is defineTool's wrapper — it validates arguments
 * against the declared schema (ToolArgsError) before the plugin's execute runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';

import { startFakeReme } from './helpers.mjs';

const plugin = await import('../lib/index.js');

/** Mount the plugin against a fake server; returns { tools, calls, close }. */
async function mount(handler, overrides = {}) {
  const server = await startFakeReme(handler);
  const config = {
    host: '127.0.0.1',
    port: server.port,
    searchLimit: 5,
    timeoutMs: 5000,
    ...overrides,
  };
  const tools = new Map();
  plugin.apply(
    { tools: { register: (t) => tools.set(t.name, t) }, systemPrompt: { section: () => {} } },
    config,
  );
  return { tools, calls: server.calls, close: server.close };
}

const ok = (body) => () => ({ body });

test('registers all seven tools; partial config does not throw', () => {
  const tools = new Map();
  const sections = [];
  plugin.apply(
    { tools: { register: (t) => tools.set(t.name, t) }, systemPrompt: { section: (s) => sections.push(s) } },
    {}, // no Config fields at all — fallbacks must kick in
  );
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['reme_delete', 'reme_dream', 'reme_proactive', 'reme_read', 'reme_save_memory', 'reme_search', 'reme_write'],
  );
  assert.equal(sections.length, 1);
});

test('mutating tools are not concurrency-safe; read-only ones are', async () => {
  const { tools, close } = await mount(ok({}));
  // defineTool validates args before delegating, so pass schema-valid args.
  const valid = {
    reme_search: { query: 'q' },
    reme_read: { path: 'a.md' },
    reme_write: { path: 'a.md', name: 'n', content: 'c' },
    reme_save_memory: { sessionId: 's', messages: [{ role: 'user', content: 'x' }] },
    reme_proactive: {},
    reme_dream: {},
    reme_delete: { path: 'a.md' },
  };
  for (const name of ['reme_write', 'reme_save_memory', 'reme_dream', 'reme_delete'])
    assert.equal(tools.get(name).isConcurrencySafe(valid[name]), false, name);
  for (const name of ['reme_search', 'reme_read', 'reme_proactive'])
    assert.equal(tools.get(name).isConcurrencySafe(valid[name]), true, name);
  await close();
});

test('search: clamps limit into [1, MAX_SEARCH_LIMIT]; host rejects non-integers', async () => {
  const { tools, calls, close } = await mount(ok({ metadata: { results: [], counts: { returned: 0 } } }));
  await tools.get('reme_search').execute({ query: 'q', limit: 0 });
  await tools.get('reme_search').execute({ query: 'q', limit: -5 });
  await tools.get('reme_search').execute({ query: 'q', limit: 5000 });
  await tools.get('reme_search').execute({ query: 'q' });
  assert.deepEqual(calls.map((c) => c.payload.limit), [1, 1, 100, 5]);
  await assert.rejects(
    () => tools.get('reme_search').execute({ query: 'q', limit: 2.5 }),
    /must be an integer/,
  );
  await close();
});

test('search: reads metadata.results, guards non-array shapes, truncates snippets', async () => {
  const { tools, close } = await mount((action) => ({
    body: {
      metadata: {
        results: [{ path: 'a.md', text: 'x'.repeat(400), scores: { keyword: 1 }, start_line: 1, end_line: 2 }],
        counts: { returned: 1 },
      },
    },
  }));
  const value = await tools.get('reme_search').execute({ query: 'q' });
  assert.equal(value.total, 1);
  assert.equal(value.results[0].path, 'a.md');
  assert.equal(value.results[0].score, 1);
  assert.equal(value.results[0].snippet.length, 300);
  assert.deepEqual([value.results[0].startLine, value.results[0].endLine], [1, 2]);
  await close();

  const bad = await mount(() => ({ body: { results: 'not-an-array' } }));
  const empty = await bad.tools.get('reme_search').execute({ query: 'q' });
  assert.deepEqual(empty.results, []);
  await bad.close();
});

test('path tools reject traversal/absolute paths and normalize the rest', async () => {
  const { tools, calls, close } = await mount(ok({ success: true, metadata: {} }));
  for (const bad of ['../etc/passwd', 'a/../../b', 'C:\\Windows\\a', 'a//b.md', '.', 'digest/../x', '   ']) {
    for (const tool of ['reme_read', 'reme_write', 'reme_delete']) {
      const args = tool === 'reme_write' ? { path: bad, name: 'n', content: 'c' } : { path: bad };
      await assert.rejects(
        () => tools.get(tool).execute(args),
        /workspace-relative|non-empty|file or folder/,
        `${tool}("${bad}") should be rejected`,
      );
    }
  }
  await tools.get('reme_read').execute({ path: '  digest/wiki/a.md  ' });
  await tools.get('reme_write').execute({ path: '/daily/2025-01-15/n.md/', name: 'n', content: 'c' });
  await tools.get('reme_delete').execute({ path: 'digest\\wiki\\a.md' });
  assert.deepEqual(
    calls.map((c) => c.payload.path),
    ['digest/wiki/a.md', 'daily/2025-01-15/n.md', 'digest/wiki/a.md'],
  );
  await close();
});

test('reme_read validates line range and surfaces server errors as errors', async () => {
  const missing = await mount(ok({ answer: 'Error: file /x/y.md does not exist', success: false }));
  await assert.rejects(() => missing.tools.get('reme_read').execute({ path: 'y.md' }), /read failed/);
  await assert.rejects(
    () => missing.tools.get('reme_read').execute({ path: 'a.md', startLine: 0 }),
    /positive integer/,
  );
  await assert.rejects(
    () => missing.tools.get('reme_read').execute({ path: 'a.md', startLine: 5, endLine: 2 }),
    /startLine must not exceed endLine/,
  );
  await missing.close();

  const good = await mount(() => ({ body: { answer: '---\nname: T\n---\nbody\n', metadata: { path: 'a.md' } } }));
  const value = await good.tools.get('reme_read').execute({ path: 'a.md' });
  assert.equal(value.name, 'T');
  assert.equal(value.path, 'a.md');
  await good.close();
});

test('mutating tools never default success to true', async () => {
  let writeCall = 0;
  const { tools, close } = await mount((action) => {
    if (action === 'write') {
      const bodies = [{}, { answer: 'Error: disk full' }, { success: true, answer: 'Wrote ok' }];
      return { body: bodies[writeCall++ % 3] };
    }
    return { body: { metadata: { deleted: false }, answer: 'Error: nope' } };
  });
  const w1 = await tools.get('reme_write').execute({ path: 'a.md', name: 'n', content: 'c' });
  assert.equal(w1.success, false);
  assert.doesNotMatch(w1.message, /Written successfully/);
  const w2 = await tools.get('reme_write').execute({ path: 'a.md', name: 'n', content: 'c' });
  assert.equal(w2.success, false);
  const w3 = await tools.get('reme_write').execute({ path: 'a.md', name: 'n', content: 'c' });
  assert.deepEqual([w3.success, w3.message], [true, 'Wrote ok']);
  const del = await tools.get('reme_delete').execute({ path: 'a.md' });
  assert.equal(del.success, false);
  assert.deepEqual(del.deletedFiles, []);
  const dream = await tools.get('reme_dream').execute({});
  assert.equal(dream.success, false);
  await close();
});

test('reme_delete maps the server manifest into the output schema', async () => {
  const { tools, close } = await mount(() => ({
    body: {
      answer: 'Deleted digest/x',
      success: true,
      metadata: {
        path: 'digest/x',
        deleted: true,
        is_dir: true,
        deleted_files: ['digest/x/a.md', 'digest/x/b.md'],
        inbound: { files_touched: 1, links_total: 2, by_file: [{ path: 'digest/y.md', count: 2 }] },
      },
    },
  }));
  const value = await tools.get('reme_delete').execute({ path: 'digest/x' });
  assert.equal(value.success, true);
  assert.equal(value.deletedFiles.length, 2);
  assert.equal(value.inboundFilesTouched, 1);
  assert.deepEqual(value.inboundByFile, [{ path: 'digest/y.md', count: 2 }]);
  const rendered = tools.get('reme_delete').output.render({}, value)[0].text;
  assert.match(rendered, /Surviving inbound wikilinks/);
  await close();
});

test('save_memory forwards sanitized snake_case payloads', async () => {
  const { tools, calls, close } = await mount(ok({ success: true, daily_path: 'daily/2025-01-15/x.md' }));
  await assert.rejects(() => tools.get('reme_save_memory').execute({ sessionId: '', messages: [{ role: 'user', content: 'x' }] }), /non-empty/);
  await assert.rejects(() => tools.get('reme_save_memory').execute({ sessionId: 's', messages: [] }), /non-empty array/);
  await assert.rejects(
    () => tools.get('reme_save_memory').execute({ sessionId: 's', messages: [{ role: 'user', content: 42 }] }),
    /must be a string/,
  );
  const value = await tools.get('reme_save_memory').execute({
    sessionId: 's ',
    messages: [{ role: 'user', content: 'hi' }],
    memoryHint: 'hint ',
  });
  assert.equal(value.success, true);
  assert.equal(value.dailyPath, 'daily/2025-01-15/x.md');
  // ReMe's Msg requires `name`; the plugin defaults it to the role.
  assert.deepEqual(calls[0].payload, {
    session_id: 's',
    messages: [{ role: 'user', name: 'user', content: 'hi' }],
    memory_hint: 'hint',
  });
  await close();
});

test('date arguments are validated as YYYY-MM-DD', async () => {
  const { tools, calls, close } = await mount(ok({ success: true }));
  for (const tool of ['reme_dream', 'reme_proactive'])
    await assert.rejects(() => tools.get(tool).execute({ date: '../../..' }), /YYYY-MM-DD/, tool);
  await tools.get('reme_dream').execute({ date: '2025-01-15' });
  await tools.get('reme_proactive').execute({});
  assert.equal(calls[0].payload.date, '2025-01-15');
  assert.equal(calls[1].payload.date, '');
  await close();
});

test('reme_proactive maps topics and survives non-array shapes', async () => {
  const { tools, close } = await mount(() => ({
    body: { topics: [{ topic: 'T', description: 'D', related_paths: ['a.md'] }] },
  }));
  const value = await tools.get('reme_proactive').execute({ date: '2025-01-15' });
  assert.deepEqual(value.topics, [{ topic: 'T', description: 'D', relatedPaths: ['a.md'] }]);
  await close();

  const bad = await mount(() => ({ body: { topics: { oops: true } } }));
  const empty = await bad.tools.get('reme_proactive').execute({});
  assert.deepEqual(empty.topics, []);
  await bad.close();
});

test('hung ReMe requests abort with a timeout error instead of hanging', async () => {
  const { tools, close } = await mount(() => ({ hang: true }), { timeoutMs: 400 });
  const started = Date.now();
  await assert.rejects(() => tools.get('reme_search').execute({ query: 'q' }), /timed out after 400ms/);
  assert.ok(Date.now() - started < 5000, 'must not wait for the wedged server');
  await close();
});

test('non-JSON 200 bodies produce an actionable error, not a SyntaxError', async () => {
  const { tools, close } = await mount(() => ({ raw: '<html>502 Bad Gateway</html>' }));
  await assert.rejects(() => tools.get('reme_search').execute({ query: 'q' }), /non-JSON response for search/);
  await close();
});

test('a dead ReMe port reports "not reachable" and preserves cause', async () => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const tools = new Map();
  plugin.apply(
    { tools: { register: (t) => tools.set(t.name, t) }, systemPrompt: { section: () => {} } },
    { host: '127.0.0.1', port, searchLimit: 5, timeoutMs: 2000 },
  );
  await assert.rejects(
    () => tools.get('reme_search').execute({ query: 'q' }),
    (err) => /not reachable/.test(err.message) && err.cause !== undefined,
  );
});

test('SSE responses merge content with metadata and raise error chunks', async () => {
  const sse = [
    'data: {"chunk_type":"content","chunk":"hello "}',
    'data: {"chunk_type":"content","chunk":"world"}',
    'data: keepalive-not-json',
    'data: {"chunk_type":"metadata","chunk":{"path":"a.md"}}',
    'data: [DONE]',
    '',
  ].join('\n');
  const stream = await mount(() => ({ sse }));
  const value = await stream.tools.get('reme_read').execute({ path: 'a.md' });
  assert.equal(value.content, 'hello world');
  assert.equal(value.path, 'a.md');
  await stream.close();

  const failing = await mount(() => ({
    sse: 'data: {"chunk_type":"error","chunk":{"code":"E1","message":"boom"}}\n\ndata: [DONE]\n',
  }));
  await assert.rejects(() => failing.tools.get('reme_search').execute({ query: 'q' }), /"message":"boom"/);
  await failing.close();
});
