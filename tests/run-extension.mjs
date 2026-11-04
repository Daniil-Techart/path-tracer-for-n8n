import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.EXT_PORT || 8124);
const nonce = 'pt-extension-test-nonce';

const chromeCandidates = [
  process.env.BROWSER_PATH,
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const chrome = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!chrome) {
  console.error('No Chrome/Edge found. Set CHROME_PATH.');
  process.exit(2);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

const payloadInSync = fs.readFileSync(path.join(root, 'path-tracer.js'))
  .equals(fs.readFileSync(path.join(root, 'extension', 'path-tracer.js')));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-extension-'));
const extensionDir = path.join(work, 'extension');
copyDir(path.join(root, 'extension'), extensionDir);

const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.content_scripts[0].matches = [`http://127.0.0.1:${port}/*`];
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const mockPath = path.join(root, 'tests', 'mock.html');
let mockHtml = fs.readFileSync(mockPath, 'utf8');
mockHtml = mockHtml.replace('<script src="/path-tracer.js"></script>', '');
mockHtml = mockHtml.replace(/<script>/g, `<script nonce="${nonce}">`);
mockHtml = mockHtml.replace('</body>', '<script>window.__cspInlineRan = 1</script><script src="/path-tracer.js"></script></body>');

let pluginFetches = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/workflow/mock') {
    res.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'`
    });
    res.end(mockHtml);
    return;
  }
  if (url.pathname === '/plain') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': `script-src 'nonce-${nonce}' 'strict-dynamic'` });
    res.end('<!doctype html><html><body><h1>not n8n</h1></body></html>');
    return;
  }
  if (url.pathname === '/path-tracer.js') {
    pluginFetches++;
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(fs.readFileSync(path.join(root, 'path-tracer.js')));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`
  ]
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const cspViolations = [];
page.on('console', (message) => {
  if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text());
});

let passed = 0;
let failed = 0;
const results = [];
function check(name, condition, extra) {
  if (condition) {
    passed++;
    results.push('PASS ' + name);
  } else {
    failed++;
    results.push('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  check('extension payload matches path-tracer.js (npm run build:ext)', payloadInSync);
  await page.goto(`http://127.0.0.1:${port}/workflow/mock`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('!!window.__pathTracer', { timeout: 8000 });
  check('extension injects the plugin in MAIN world under strict CSP', true);

  const csp = await page.evaluate(() => ({
    inlineRan: window.__cspInlineRan === 1,
    mockBuilt: !!document.querySelector('.vue-flow__node[data-id]')
  }));
  check('nonce-protected scripts of the page still run', csp.mockBuilt, csp);
  check('page-level inline script is blocked by CSP', csp.inlineRan === false, csp);
  check('page-level script tag for the plugin was blocked (no fetch)', pluginFetches === 0, pluginFetches);

  const dom = await page.evaluate(() => ({
    nodes: document.querySelectorAll('.vue-flow__node[data-id]').length,
    edges: document.querySelectorAll('.vue-flow__edge[data-id]').length
  }));
  check('mock canvas rendered', dom.nodes === 9 && dom.edges === 8, dom);

  await page.waitForSelector('#pt-marker', { timeout: 5000 });
  await page.click('[data-node-name="End"]');
  await wait(700);

  const state = await page.evaluate(() => {
    const snapshot = window.__pathTracer.getState();
    return {
      target: snapshot.target,
      paths: snapshot.paths,
      groups: document.querySelectorAll('svg[data-pt-overlay-svg] g[data-pt-edge]').length,
      hits: document.querySelectorAll('svg[data-pt-hit-svg] [data-pt-hit]').length,
      dimmed: document.querySelectorAll('.vue-flow__node[data-pt-dim]').length
    };
  });
  check('traces three paths', state.paths.length === 3 && state.target === 'End', state);
  check('overlay rendered', state.groups === 7, state);
  check('unrelated nodes dimmed', state.dimmed === 3, state.dimmed);

  const clickPoint = await page.evaluate(() => {
    const edge = [...document.querySelectorAll('.vue-flow__edge[data-id]')]
      .find((el) => el.getAttribute('data-id').includes('n2/inputs'));
    const native = edge.querySelector('.vue-flow__edge-path');
    const point = native.getPointAtLength(native.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(native.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await wait(200);
  const isolated = await page.evaluate(() => window.__pathTracer.getState().isolated);
  check('click on a connection isolates the path', isolated === 0, isolated);

  await page.goto(`http://127.0.0.1:${port}/plain`, { waitUntil: 'domcontentloaded' });
  await wait(400);
  const foreign = await page.evaluate(() => ({
    tracer: typeof window.__pathTracer,
    marker: !!document.getElementById('pt-marker'),
    overlay: !!document.querySelector('[data-pt-overlay-svg]'),
    style: !!document.getElementById('n8n-path-tracer-style')
  }));
  check('does nothing on non-n8n sites (broad matches guard)', foreign.tracer === 'undefined' && !foreign.marker && !foreign.overlay && !foreign.style, foreign);

  if (cspViolations.length) results.push('note: CSP violations seen: ' + cspViolations.join(' | '));
} catch (error) {
  failed++;
  results.push('FAIL exception :: ' + error.message);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(results.join('\n'));
console.log('\npassed=' + passed + ' failed=' + failed);
process.exit(failed ? 1 : 0);










