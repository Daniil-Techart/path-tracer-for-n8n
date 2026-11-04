import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extension = path.join(root, 'extension');
const port = Number(process.env.COMPAT_PORT || 5680);
const base = `http://localhost:${port}`;
const versions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['1.123.91', '2.45.7', '2.46.3', '3.0.1'];

const browsers = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome'
].filter(Boolean);
const browserPath = browsers.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  console.error('No Chromium browser found (set BROWSER_PATH)');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options });

async function waitReady(timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(base + '/rest/settings');
      const type = res.headers.get('content-type') || '';
      if (res.ok && type.includes('application/json')) return true;
    } catch {}
    await wait(2000);
  }
  return false;
}

async function api(pathname, options = {}, cookie = '') {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + pathname, { ...options, headers });
  const text = await res.text();

  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, cookies: res.headers.getSetCookie?.() || [] };
}

function workflowBody() {
  const nodes = [
    { parameters: {}, id: 'a0000000-0000-4000-8000-000000000001', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 300] },
    { parameters: {}, id: 'a0000000-0000-4000-8000-000000000002', name: 'Node1', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [240, 300] },
    { parameters: {}, id: 'a0000000-0000-4000-8000-000000000003', name: 'Node2', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [480, 200] },
    { parameters: {}, id: 'a0000000-0000-4000-8000-000000000004', name: 'Node3', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [480, 400] },
    { parameters: {}, id: 'a0000000-0000-4000-8000-000000000005', name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [720, 300] }
  ];
  const connections = {
    Trigger: { main: [[{ node: 'Node1', type: 'main', index: 0 }]] },
    Node1: { main: [[{ node: 'Node2', type: 'main', index: 0 }, { node: 'Node3', type: 'main', index: 0 }]] },
    Node2: { main: [[{ node: 'End', type: 'main', index: 0 }]] },
    Node3: { main: [[{ node: 'End', type: 'main', index: 0 }]] }
  };
  return { name: 'Compat ' + Date.now(), nodes, connections, settings: { executionOrder: 'v1' }, active: false };
}

async function diagnose(page) {
  return page.evaluate(() => {
    const tracer = window.__pathTracer;
    const state = tracer ? tracer.getState() : null;
    const lineStrokes = [...document.querySelectorAll('svg[data-pt-overlay-svg] path[data-pt-line]')]
      .map((node) => node.getAttribute('stroke'));
    return {
      meta: !!document.querySelector('meta[name="n8n:config:rest-endpoint"]'),
      vueFlow: !!document.querySelector('.vue-flow'),
      nodes: document.querySelectorAll('.vue-flow__node[data-id]').length,
      edges: document.querySelectorAll('.vue-flow__edge[data-id]').length,
      marker: !!document.getElementById('pt-marker'),
      tracer: !!tracer,
      version: tracer ? tracer.version : null,
      source: tracer ? tracer.readGraph().source : null,
      target: state ? state.target : null,
      paths: state ? state.paths.length : 0,
      groups: document.querySelectorAll('svg[data-pt-overlay-svg] g[data-pt-edge]').length,
      lines: lineStrokes.length,
      uniqueColors: new Set(lineStrokes).size,
      dashed: lineStrokes.filter((stroke, index) => {
        const line = document.querySelectorAll('svg[data-pt-overlay-svg] path[data-pt-line]')[index];
        return line.getAttribute('stroke-dasharray');
      }).length
    };
  });
}

const results = [];

for (const version of versions) {
  const name = 'n8n-compat-' + version.replace(/[^0-9a-z]+/gi, '-');
  const volume = name + '-data';
  const record = { version, ok: false, error: null, ui: null, click: null };
  let browser = null;
  try {
    try { sh(['rm', '-f', name], { stdio: 'ignore' }); } catch {}
    try { sh(['volume', 'rm', volume], { stdio: 'ignore' }); } catch {}
    sh(['run', '-d', '--name', name, '-p', `${port}:5678`,
      '-e', 'N8N_SECURE_COOKIE=false',
      '-e', 'N8N_DIAGNOSTICS_ENABLED=false',
      '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
      '-e', 'N8N_PERSONALIZATION_ENABLED=false',
      '-e', 'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false',
      '-e', 'N8N_ENCRYPTION_KEY=compat-key',
      '-e', 'N8N_LOG_LEVEL=warn',
      '-v', `${volume}:/home/node/.n8n`,
      `docker.n8n.io/n8nio/n8n:${version}`], { stdio: 'ignore' });

    if (!(await waitReady())) throw new Error('n8n did not become ready');

    const email = `compat-${version.replace(/\./g, '-')}@test.local`;
    const password = 'PathTracer123';
    const setup = await api('/rest/owner/setup', {
      method: 'POST',
      body: JSON.stringify({ email, firstName: 'Compat', lastName: 'Test', password })
    });
    let cookie = setup.cookies.map((value) => value.split(';')[0]).join('; ');
    if (!cookie) {
      const login = await api('/rest/login', {
        method: 'POST',
        body: JSON.stringify({ emailOrLdapLoginId: email, email, password })
      });

      if (!login.cookies.length) throw new Error('login failed: ' + login.status);
      cookie = login.cookies.map((value) => value.split(';')[0]).join('; ');
    }

    const created = await api('/rest/workflows', { method: 'POST', body: JSON.stringify(workflowBody()) }, cookie);
    if (created.status !== 200 || !created.body?.data?.id) {
      throw new Error('workflow create failed: ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 200));
    }
    const workflowId = created.body.data.id;

    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu',
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    for (const part of cookie.split('; ')) {
      const [key, ...rest] = part.split('=');
      await page.setCookie({ name: key, value: rest.join('='), domain: 'localhost', path: '/' });
    }
    await page.goto(`${base}/workflow/${workflowId}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.vue-flow__node[data-id], .node-view, .canvas-node', { timeout: 30000 }).catch(() => {});
    await wait(1200);

    const ui = await diagnose(page);
    record.ui = ui;
    record.errors = pageErrors;

    if (ui.tracer && ui.marker) {
      await page.click('[data-node-name="End"]').catch(() => {});
      await wait(900);
      const traced = await diagnose(page);
      record.ui = traced;
      if (traced.paths > 0) {
        const point = await page.evaluate(() => {
          const line = document.querySelector('svg[data-pt-overlay-svg] path[data-pt-line]');
          if (!line) return null;
          const length = line.getTotalLength();
          const p = line.getPointAtLength(length / 2);
          const s = new DOMPoint(p.x, p.y).matrixTransform(line.getScreenCTM());
          return { x: s.x, y: s.y };
        });
        if (point) {
          await page.mouse.click(point.x, point.y);
          await wait(300);
          record.click = await page.evaluate(() => {
            const state = window.__pathTracer.getState();
            const groups = [...document.querySelectorAll('g[data-pt-edge]')].filter((group) => group.style.display !== 'none');
            return {
              isolated: state.isolated,
              visibleEdges: groups.length,
              singleColor: new Set(groups.flatMap((group) => [...group.querySelectorAll('path[data-pt-line]')]
                .map((line) => line.getAttribute('stroke')))).size
            };
          });
        }
      }
      record.ok = traced.paths === 2 && record.click?.isolated === 0 && record.click?.singleColor === 1;
    } else {
      record.error = 'extension did not activate';
    }
  } catch (error) {
    record.error = error.message;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { sh(['rm', '-f', name], { stdio: 'ignore' }); } catch {}
    try { sh(['volume', 'rm', volume], { stdio: 'ignore' }); } catch {}
  }
  results.push(record);
  console.log(JSON.stringify(record));
}

const summary = results.map((record) => ({
  version: record.version,
  ok: record.ok,
  error: record.error,
  ui: record.ui,
  click: record.click
}));
console.log('\nSUMMARY\n' + JSON.stringify(summary, null, 2));






