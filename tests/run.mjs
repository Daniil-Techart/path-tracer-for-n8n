import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 8123);

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
  console.error('No Chrome/Edge found. Set BROWSER_PATH or run: npm i -D puppeteer-core');
  process.exit(2);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = url.pathname === '/workflow/mock' ? '/tests/mock.html' : url.pathname;
  const full = path.join(root, file);
  if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950 });

const errors = [];
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) errors.push('console: ' + message.text());
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
const state = () => page.evaluate(() => window.__pathTracer.getState());

async function openWorkflow(query = '') {
  await page.goto(`http://127.0.0.1:${port}/workflow/mock${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pt-marker', { timeout: 3000 });
  await page.waitForFunction(() => !!window.__pathTracer, { timeout: 5000 });
  await wait(200);
}

async function traceEnd() {
  await page.click('[data-node-name="End"]');
  await wait(500);
}

async function pointOnEdge(edgePart, ratio, pathIndex = 0) {
  return page.evaluate(({ edgePart, ratio, pathIndex }) => {
    const edge = [...document.querySelectorAll('.vue-flow__edge[data-id]')]
      .find((el) => el.getAttribute('data-id').includes(edgePart));
    const native = edge.querySelectorAll('.vue-flow__edge-path')[pathIndex];
    const length = native.getTotalLength();
    const point = native.getPointAtLength(length * ratio);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(native.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }, { edgePart, ratio, pathIndex });
}

try {
  await openWorkflow();
  const marker = await page.evaluate(() => {
    const el = document.getElementById('pt-marker');
    return { exists: !!el, hidden: el.hidden, off: el.hasAttribute('data-off'), fab: !!document.getElementById('pt-fab'), panel: !!document.getElementById('pt-panel') };
  });
  check('marker is the only UI', marker.exists && !marker.hidden && !marker.off && !marker.fab && !marker.panel, marker);

  await wait(200);
  let snapshot = await state();
  check('nothing traced before clicking a node', snapshot.paths.length === 0, snapshot.paths);

  await traceEnd();
  snapshot = await state();
  check('clicking a node traces immediately', snapshot.target === 'End' && snapshot.paths.length === 3, snapshot);

  const overlay = await page.evaluate(() => {
    const strokeOf = (part) => {
      const edge = [...document.querySelectorAll('g[data-pt-edge]')]
        .find((group) => group.getAttribute('data-pt-edge').includes(part));
      const line = edge && edge.querySelector('path[data-pt-line]');
      return line ? line.getAttribute('stroke') : null;
    };
    const lines = [...document.querySelectorAll('svg[data-pt-overlay-svg] path[data-pt-line]')];
    return {
      groups: document.querySelectorAll('svg[data-pt-overlay-svg] g[data-pt-edge]').length,
      lines: lines.length,
      dashed: lines.filter((line) => line.getAttribute('stroke-dasharray')).length,
      sparks: document.querySelectorAll('svg[data-pt-overlay-svg] .pt-spark').length,
      sparkStrokes: [...document.querySelectorAll('svg[data-pt-overlay-svg] .pt-spark')].map((node) => node.getAttribute('stroke')),
      splitLines: document.querySelectorAll('svg[data-pt-overlay-svg] g[data-pt-edge*="n2/inputs"] path[data-pt-line]').length,
      trunk: strokeOf('n5/outputs'),
      branchA: strokeOf('n2/inputs'),
      branchB: strokeOf('n3/inputs'),
      dimNodes: [...document.querySelectorAll('.vue-flow__node[data-pt-dim] .canvas-node')].map((e) => e.getAttribute('data-node-name')),
      onNodes: [...document.querySelectorAll('.vue-flow__node[data-pt-on] .canvas-node')].map((e) => e.getAttribute('data-node-name')),
      dimEdges: [...document.querySelectorAll('.vue-flow__edge[data-pt-dim]')].map((e) => e.getAttribute('data-id'))
    };
  });
  check('one overlay group per connection', overlay.groups === 7, overlay.groups);
  check('every segment of a split connection is painted', overlay.splitLines === 2, overlay.splitLines);
  check('connections are solid, colors split only at forks', overlay.dashed === 0, overlay.dashed);
  check('shared trunk keeps the first branch color', overlay.trunk === overlay.branchA, { trunk: overlay.trunk, branchA: overlay.branchA });
  check('a fork gets a different color for the second branch', overlay.branchB !== overlay.branchA, { a: overlay.branchA, b: overlay.branchB });
  check('spark animation runs on every segment', overlay.sparks === 16, overlay.sparks);
  check('spark is a lighter tint of the branch color', overlay.sparkStrokes.every((stroke) => /^hsl\(\d+ 95% 80%\)$/.test(stroke)), overlay.sparkStrokes.slice(0, 3));
  check('off-path nodes are dimmed', JSON.stringify(overlay.dimNodes.sort()) === JSON.stringify(['D1', 'D2', 'Unrelated'].sort()), overlay.dimNodes);
  check('path nodes stay highlighted', ['Start', 'A', 'B', 'C', 'M', 'End'].every((name) => overlay.onNodes.includes(name)), overlay.onNodes);
  check('unrelated connection is dimmed', overlay.dimEdges.length === 1 && overlay.dimEdges[0].includes('D1'), overlay.dimEdges);

  const anim = await page.evaluate(async () => {
    const spark = document.querySelector('svg[data-pt-overlay-svg] .pt-spark');
    const style = getComputedStyle(spark);
    const read = () => parseFloat(getComputedStyle(spark).strokeDashoffset);
    const a = read();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const b = read();
    const dash = parseFloat(String(style.strokeDasharray).split(/[ ,]+/)[0]);
    return {
      delta: Math.abs(a - b),
      a,
      b,
      dash,
      gap: parseFloat(spark.style.getPropertyValue('--pt-gap')),
      duration: parseFloat(style.animationDuration),
      raw: {
        dasharray: style.strokeDasharray,
        offset: style.strokeDashoffset,
        duration: style.animationDuration,
        inline: spark.getAttribute('style')
      }
    };
  });
  check('spark moves along the whole segment without a short reset', anim.delta > 0 && anim.delta < (anim.dash + anim.gap) * 0.6, anim);
  check('spark period follows the segment length', anim.gap > 60 && anim.duration > 0.6, anim);
  const drag = await page.evaluate(async () => {
    const edge = [...document.querySelectorAll('.vue-flow__edge[data-id]')]
      .find((el) => el.getAttribute('data-id').includes('n2/inputs'));
    const native = edge.querySelector('.vue-flow__edge-path');
    const sparkBefore = document.querySelector('svg[data-pt-overlay-svg] .pt-spark');
    const moved = 'M 120 480 C 220 480, 300 300, 400 300';
    native.setAttribute('d', moved);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const overlayShapes = [...document.querySelectorAll('svg[data-pt-overlay-svg] path')]
      .map((node) => node.getAttribute('d'));
    return {
      copies: overlayShapes.filter((shape) => shape === moved).length,
      sameSpark: document.querySelector('svg[data-pt-overlay-svg] .pt-spark') === sparkBefore,
      sparkMoved: [...document.querySelectorAll('svg[data-pt-overlay-svg] .pt-spark')]
        .filter((node) => node.getAttribute('d') === moved).length >= 2
    };
  });
  check('overlay follows a moving connection on the next frame', drag.copies === 4 && drag.sparkMoved, drag);
  check('moving a node does not restart the animation', drag.sameSpark, drag);
  const dump = await page.evaluate(() => {
    const data = window.__pathTracer.dump();
    const edge = data.edges.find((item) => item.source === 'Start' && item.target === 'A');
    return { shapes: edge ? edge.shapes.length : 0, edges: data.edges.length };
  });
  check('dump reports both segments of the split connection', dump.shapes === 2, dump);

  const firstSegment = await pointOnEdge('n2/inputs', 0.5, 0);
  await page.mouse.click(firstSegment.x, firstSegment.y);
  await wait(200);
  snapshot = await state();
  check('clicking a connection isolates the path', snapshot.isolated === 0, snapshot.isolated);

  await page.mouse.click(firstSegment.x, firstSegment.y);
  await wait(200);
  snapshot = await state();
  check('clicking it again keeps the path isolated', snapshot.isolated === 0 && snapshot.paths.length === 3, snapshot.isolated);

  const secondSegment = await pointOnEdge('n2/inputs', 0.5, 1);
  await page.mouse.click(secondSegment.x, secondSegment.y);
  await wait(200);
  snapshot = await state();
  check('clicking the second segment isolates the same path', snapshot.isolated === 0, snapshot.isolated);

  const arrowTip = await pointOnEdge('n2/inputs', 0.985, 0);
  await page.mouse.click(arrowTip.x, arrowTip.y);
  await wait(200);
  snapshot = await state();
  check('clicking near the arrowhead isolates the path', snapshot.isolated === 0, snapshot.isolated);

  const otherPath = await pointOnEdge('n3/inputs', 0.5, 0);
  await page.mouse.click(otherPath.x, otherPath.y);
  await wait(200);
  snapshot = await state();
  check('clicking another path switches isolation', snapshot.isolated === 1, snapshot.isolated);

  const isolated = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('g[data-pt-edge]')].filter((group) => group.style.display !== 'none');
    return {
      keys: groups.map((group) => group.getAttribute('data-pt-edge')),
      strokes: groups.flatMap((group) => [...group.querySelectorAll('path[data-pt-line]')].map((line) => line.getAttribute('stroke'))),
      dim: [...document.querySelectorAll('.vue-flow__node[data-pt-dim] .canvas-node')].map((e) => e.getAttribute('data-node-name'))
    };
  });
  check('isolated path shows only its own connections', isolated.keys.length === 3
    && isolated.keys.some((key) => key.includes('n3/inputs'))
    && isolated.keys.some((key) => key.includes('n5/inputs')), isolated.keys);
  check('isolated path is painted in one color', new Set(isolated.strokes).size === 1, isolated.strokes);
  check('nodes outside the path are dimmed', ['A', 'C'].every((name) => isolated.dim.includes(name)), isolated.dim);

  await page.mouse.click(1300, 750);
  await wait(150);
  snapshot = await state();
  check('click on empty canvas shows all paths', snapshot.isolated === null && snapshot.paths.length === 3, snapshot.isolated);

  await page.keyboard.press('Escape');
  await wait(150);
  snapshot = await state();
  check('escape clears the trace', snapshot.target === null && snapshot.paths.length === 0, snapshot);
  const leftover = await page.evaluate(() => document.querySelectorAll('[data-pt-dim]').length);
  check('highlight is fully cleared', leftover === 0, leftover);

  await openWorkflow('?store=1');
  await traceEnd();
  const storeInfo = await page.evaluate(() => ({
    source: window.__pathTracer.readGraph().source,
    shapes: window.__pathTracer.dump().edges.find((e) => e.source === 'Start' && e.target === 'A')?.shapes.length,
    paths: window.__pathTracer.getState().paths.length
  }));
  check('graph is read from the pinia store', storeInfo.source === 'store', storeInfo);
  check('store mode finds the same three paths', storeInfo.paths === 3, storeInfo);
  check('store mode paints both segments too', storeInfo.shapes === 2, storeInfo);

  await page.evaluate(() => window.__pathTracer.disable());
  await wait(150);
  const off = await page.evaluate(() => ({
    off: document.getElementById('pt-marker').hasAttribute('data-off'),
    dimmed: document.querySelectorAll('[data-pt-dim]').length,
    traced: document.getElementById('pt-marker') ? window.__pathTracer.getState().paths.length : -1
  }));
  check('disable clears the trace and dims the marker', off.off && off.dimmed === 0 && off.traced === 0, off);

  await page.evaluate(() => window.__pathTracer.enable());
  await wait(150);
  const on = await page.evaluate(() => ({ off: document.getElementById('pt-marker').hasAttribute('data-off') }));
  check('enable restores the marker', on.off === false, on);

  await traceEnd();
  snapshot = await state();
  check('tracing works again after enable', snapshot.paths.length === 3 && snapshot.target === 'End', snapshot);
} catch (error) {
  failed++;
  results.push('FAIL exception :: ' + error.message);
} finally {
  await browser.close();
  server.close();
}

console.log(results.join('\n'));
console.log('\npassed=' + passed + ' failed=' + failed);
if (errors.length) console.log('\npage errors:\n' + errors.join('\n'));
process.exit(failed ? 1 : 0);













