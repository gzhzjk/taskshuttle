import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleDataSource } from '../../packages/plugin/src/console/data-source.js';
import { CONSOLE_CSP, ConsoleServer } from '../../packages/plugin/src/console/server.js';
import type { InstanceManifest } from '../../packages/plugin/src/lifecycle.js';
import { resolvePluginConfig } from '../../packages/plugin/src/plugin-config.js';
import { SessionRegistry, type RegistryObserver } from '../../packages/core/src/registry.js';
import { createPluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';

/**
 * §12 step 7: the UI routes. Beyond status/content-type, these tests assert
 * the two §7.5 invariants the artifact gate mirrors: the served HTML carries
 * no inline script/style (the CSP would refuse to execute it), and no served
 * asset references an external host (self-containment).
 */

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function request(port: number, options: { method?: string; path?: string; headers?: Record<string, string> } = {}): Promise<HttpResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', ...(options.headers === undefined ? {} : { headers: options.headers }) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', rejectRequest);
    req.end();
  });
}

const manifest: InstanceManifest = {
  instanceId: 'test-instance',
  createdAt: '2026-01-01T00:00:00.000Z',
  host: 'test-host',
  pid: 1,
  processStartedAt: '2026-01-01T00:00:00.000Z',
  tokenHash: 'a'.repeat(64),
  exePath: '/test/exe',
};

interface Rig {
  readonly dir: string;
  readonly server: ConsoleServer;
  /* Extra request headers; empty, since there is no credential to send. */
  readonly headers: Record<string, string>;
}

const rigs: Rig[] = [];

async function startRig(withDataSource = true): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-console-ui-'));
  const config = resolvePluginConfig({ allowedRoots: [tmpdir()], console: { enabled: true } });
  let dataSource: ConsoleDataSource | undefined;
  if (withDataSource) {
    let target: RegistryObserver | undefined;
    const forwarding: RegistryObserver = {
      onSessionTransition: (event) => target?.onSessionTransition?.(event),
      onTurnTransition: (event) => target?.onTurnTransition?.(event),
      onInteractionTransition: (event) => target?.onInteractionTransition?.(event),
    };
    const registry = new SessionRegistry({ instanceId: manifest.instanceId, observer: forwarding });
  const store = createPluginTranscriptStore(join(dir, 'taskshuttle.sqlite'));
    dataSource = new ConsoleDataSource({
      config,
      registry,
      store,
      instance: () => manifest,
      engines: async () => ['codex'],
      isTranscriptDeleted: () => false,
      isVisible: () => true,
    });
    target = dataSource.observer;
    store.onChange(dataSource.storeListener);
  }
  const server = new ConsoleServer({ config: config.console, instanceDir: dir, ...(dataSource === undefined ? {} : { dataSource }) });
  await server.start();
  const rig: Rig = { dir, server, headers: {} };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop()!;
    await rig.server.close();
    await rm(rig.dir, { recursive: true, force: true });
  }
});

describe('console UI routes (§7.5)', () => {
  it('serves index.html as text/html, with the CSP on the response', async () => {
    const rig = await startRig();
    const res = await request(rig.server.port, { path: '/', headers: rig.headers });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe(CONSOLE_CSP);
    const html = res.body.toString('utf8');
    expect(html).toContain('<link rel="stylesheet" href="/app.css">');
    expect(html).toContain('<script src="/app.js" defer></script>');
  });

  it('serves app.css, app.js and the font with their content types', async () => {
    const rig = await startRig();
    const css = await request(rig.server.port, { path: '/app.css', headers: rig.headers });
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.body.toString('utf8')).toContain('@font-face');

    const js = await request(rig.server.port, { path: '/app.js', headers: rig.headers });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body.toString('utf8')).toContain('/api/stream');

    const font = await request(rig.server.port, { path: '/fonts/PTMono-Regular.woff2', headers: rig.headers });
    expect(font.status).toBe(200);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(font.body.subarray(0, 4).toString('latin1')).toBe('wOF2');
  });

  // ADR 0032: the UI assets need no credential either — the pipeline is
  // route-agnostic in both directions, and this used to assert the 401.
  it('serves every UI asset to a credential-free request', async () => {
    const rig = await startRig();
    for (const path of ['/', '/app.css', '/app.js', '/fonts/PTMono-Regular.woff2']) {
      const res = await request(rig.server.port, { path });
      expect(res.status, path).toBe(200);
    }
  });

  it('index.html has no inline script, no inline style element, no style attributes', async () => {
    const rig = await startRig();
    const html = (await request(rig.server.port, { path: '/', headers: rig.headers })).body.toString('utf8');
    // Every <script> must be external (src=); the CSP would block anything else.
    const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) expect(tag).toContain('src=');
    expect(html).not.toContain('<style');
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('no served asset references an external host (self-containment, §7.5)', async () => {
    const rig = await startRig();
    for (const path of ['/', '/app.css', '/app.js']) {
      const raw = (await request(rig.server.port, { path, headers: rig.headers })).body.toString('utf8');
      // The SVG namespace URI in createElementNS is an identifier string, never
      // a fetched resource; strip it before the external-reference check.
      const body = raw.split('http://www.w3.org/2000/svg').join('');
      expect(body).not.toMatch(/https?:\/\//);
      expect(body).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}\//i); // protocol-relative URL
    }
    const css = (await request(rig.server.port, { path: '/app.css', headers: rig.headers })).body.toString('utf8');
    expect(css).toContain('url("/fonts/PTMono-Regular.woff2")');
  });

  it('the bare security shell still stubs / without a data source', async () => {
    const rig = await startRig(false);
    const res = await request(rig.server.port, { path: '/', headers: rig.headers });
    expect(res.status).toBe(501);
  });
});
