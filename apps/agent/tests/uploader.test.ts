import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { BatchUploader } from '../src/pipeline/uploader.ts';
import type { UnifiedMessage } from '../src/parser/types.ts';
import { gunzipSync } from 'node:zlib';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  bodyBytes: Uint8Array;
}

let captured: CapturedRequest[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: { accepted: 0 } };
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const buf = new Uint8Array(await req.arrayBuffer());
      captured.push({
        url: new URL(req.url).pathname,
        method: req.method,
        headers: req.headers,
        bodyBytes: buf,
      });
      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function makeMsg(id: string): UnifiedMessage {
  return {
    id,
    sessionId: 's1',
    parentId: null,
    machineId: 'm',
    sourceTool: 'OpenCode',
    role: 'User',
    contentBlocks: [
      {
        blockType: 'Text',
        content: 'hello world',
        language: null,
        filePath: null,
        diff: null,
        toolName: null,
        toolInput: null,
        exitCode: null,
        isCollapsed: false,
      },
    ],
    usage: null,
    timestamp: '2026-04-22T00:00:00Z',
    metadata: {},
  };
}

describe('BatchUploader', () => {
  test('uploadBatch sends gzip payload', async () => {
    captured = [];
    nextResponse = { status: 200, body: { accepted: 2 } };
    const uploader = new BatchUploader({
      serverUrl: baseUrl,
      authKey: 'tok-abcdefgh',
      fingerprint: 'fp-123',
      agentVersion: '0.1.0',
      maxRetries: 2,
      initialRetryDelayMs: 50,
      maxRetryDelayMs: 100,
    });

    const result = await uploader.uploadBatch([makeMsg('a'), makeMsg('b')]);
    expect(result.accepted).toBe(2);
    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.url).toBe('/api/agent/ingest');
    expect(req.headers.get('content-encoding')).toBe('gzip');
    expect(req.headers.get('authorization')).toBe('Bearer tok-abcdefgh');
    expect(req.headers.get('x-machine-fingerprint')).toBe('fp-123');

    const body = JSON.parse(gunzipSync(req.bodyBytes).toString('utf-8'));
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe('a');
  });

  test('retries on server errors', async () => {
    captured = [];
    let calls = 0;
    server.stop(true);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        calls += 1;
        captured.push({
          url: new URL(req.url).pathname,
          method: req.method,
          headers: req.headers,
          bodyBytes: new Uint8Array(await req.arrayBuffer()),
        });
        if (calls < 3) {
          return new Response('err', { status: 500 });
        }
        return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;

    const uploader = new BatchUploader({
      serverUrl: baseUrl,
      authKey: 'k',
      fingerprint: 'fp',
      agentVersion: '0.1.0',
      maxRetries: 5,
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 50,
    });

    const r = await uploader.uploadBatch([makeMsg('x')]);
    expect(r.accepted).toBe(1);
    expect(calls).toBe(3);
  });

  test('401/403 stops retrying and throws', async () => {
    captured = [];
    let calls = 0;
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch() {
        calls += 1;
        return new Response('forbidden', { status: 403 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;

    const uploader = new BatchUploader({
      serverUrl: baseUrl,
      authKey: 'bad',
      fingerprint: 'fp',
      agentVersion: '0.1.0',
      maxRetries: 5,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
    });

    await expect(uploader.uploadBatch([makeMsg('x')])).rejects.toThrow(/Authorization failed|403/);
    expect(calls).toBe(1);
  });

  test('sendHeartbeat posts to /api/agent/heartbeat', async () => {
    captured = [];
    server.stop(true);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        captured.push({
          url: new URL(req.url).pathname,
          method: req.method,
          headers: req.headers,
          bodyBytes: new Uint8Array(await req.arrayBuffer()),
        });
        return new Response('{}', { status: 200 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;

    const uploader = new BatchUploader({
      serverUrl: baseUrl,
      authKey: 'k',
      fingerprint: 'fp',
      agentVersion: '0.1.0',
      maxRetries: 1,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
    });

    uploader.updateAuthKey('k2');

    await uploader.sendHeartbeat();
    expect(captured[0].url).toBe('/api/agent/heartbeat');
    expect(captured[0].headers.get('authorization')).toBe('Bearer k2');
    const body = JSON.parse(Buffer.from(captured[0].bodyBytes).toString('utf-8'));
    expect(body.agentVersion).toBe('0.1.0');
  });
});
