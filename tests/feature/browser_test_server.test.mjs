import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function fetchFile(port, path) {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        protocol: response.httpVersion,
        contentLength: Number(response.headers['content-length']),
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error(`GET ${path} timed out`)));
  });
}

test('browser test server serves the repository on loopback through a burst of connections', { timeout: 10000 }, async t => {
  const script = fileURLToPath(new URL('../serve.py', import.meta.url));
  const child = spawn('python3', [script, '--port', '0'], {
    cwd: tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    lines.close();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });

  const [ready] = await Promise.race([
    once(lines, 'line'),
    once(child, 'exit').then(() => { throw new Error(`Server failed to start: ${stderr}`); }),
  ]);
  const address = /^Serving HTTP on http:\/\/127\.0\.0\.1:(\d+)$/.exec(ready);
  assert.ok(address, ready);
  const port = Number(address[1]);
  assert.ok(port > 0);

  const paths = ['/index.html', '/app/main.js', '/app/theme.css', '/sw.js',
    '/manifest.webmanifest', '/icons/icon-192.png'];
  const assets = paths.map(path => ({
    path,
    bytes: readFileSync(new URL(`../..${path}`, import.meta.url)),
  }));
  const requests = Array.from({ length: 48 }, (_, i) => assets[i % assets.length]);
  await Promise.all(requests.map(async ({ path, bytes }) => {
    const response = await fetchFile(port, path);
    assert.equal(response.status, 200, path);
    assert.equal(response.protocol, '1.0', path);
    assert.equal(response.contentLength, bytes.length, path);
    assert.ok(response.body.equals(bytes), `GET ${path} returned different bytes`);
  }));
});
