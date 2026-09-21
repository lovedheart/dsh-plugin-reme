/**
 * Fake ReMe HTTP server for tests: records requests, replies with
 * programmable responses. No real ReMe service required.
 */
import http from 'node:http';

export async function startFakeReme(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = body;
      }
      calls.push({ path: req.url, payload });
      const reply = handler(req.url.slice(1), payload, calls.length - 1);
      if (reply?.hang) return; // never respond — exercises the client timeout
      if (reply?.sse !== undefined) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(reply.sse);
        return;
      }
      if (reply?.raw !== undefined) {
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'text/html' });
        res.end(reply.raw);
        return;
      }
      res.writeHead(reply?.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(
        reply?.body === undefined
          ? '{}'
          : typeof reply.body === 'string'
            ? reply.body
            : JSON.stringify(reply.body),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
