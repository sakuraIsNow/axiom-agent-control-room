import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
// Fixed UI smoke budgets, not a claim about model latency or production capacity.
const budgets = { durationMs: 30000, minFrames: 500, frameP95Ms: 50, frameP99Ms: 100,
    interactionP95Ms: 150, minInteractions: 12, heapGrowthBytes: 32 * 1024 * 1024,
    retainedHeapBytes: 128 * 1024 * 1024, minUpdates: 250, maxEventRows: 32 };
const report = { generatedAt: new Date().toISOString(), status: 'running', renderer: 'css-3d',
    scope: 'Production AgentSignalGraph source; isolated synthetic telemetry; no API or model calls.',
    budgets, environment: { platform: os.platform(), release: os.release(), arch: os.arch(),
        cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), node: process.version,
        build: 'Vite development source', headless: true }, results: [] };
const scratch = await mkdtemp(path.join(os.tmpdir(), 'axiom-graph-qa-'));
let server;
let browser;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
const distribution = (values) => ({ samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95),
    p99: percentile(values, .99), max: values.length ? Math.max(...values) : null });
const check = async (viewport, name, run) => {
    try {
        const evidence = await run();
        report.results.push({ viewport, name, status: 'passed', ...(evidence ? { evidence } : {}) });
    }
    catch (error) {
        report.results.push({ viewport, name, status: 'failed', error: error.message });
    }
    const result = report.results.at(-1);
    console.log(`[graph ${viewport}] ${result.status}: ${name}${result.error ? ` (${result.error.slice(0, 500)})` : ''}`);
};
const fixtureSource = (reactUrl, reactDomUrl) => `
import React from ${JSON.stringify(reactUrl)};
import ReactDOM from ${JSON.stringify(reactDomUrl)};
import { AgentSignalGraph } from '/src/components/dashboard/AgentSignalGraph.tsx';
import { UiLanguageProvider, useUiLanguage } from '/src/lib/uiLanguage.tsx';
import '/src/styles.css';
import '/src/styles/dashboard.css';
const root = ReactDOM.createRoot(document.getElementById('root'));
const roles = ['planner','researcher','analyst','builder','reviewer','synthesizer'];
const graphFor = (prefix, count, completed = false) => ({ revision: 1,
  nodes: Array.from({length:count}, (_,i) => ({id:prefix+i,stepId:prefix+i,role:roles[i%roles.length],title:'Agent '+i,
    status:completed?'completed':i===0?'running':'queued',dependsOn:i?[prefix+(i-1)]:[],skillIds:['fixture-skill'],tokens:i*100,attempts:1})),
  edges: Array.from({length:Math.max(0,count-1)},(_,i)=>({from:prefix+i,to:prefix+(i+1),kind:i%3===0?'review':'dependency'})) });
const eventsFor = (prefix, count) => Array.from({length:count},(_,i)=>({id:prefix+i,phase:'inference',label:prefix+' event '+i,at:1700000000000+i*100}));
window.qaGraph = { props: {agents:[],graph:graphFor('live-',6),phase:'inference',events:eventsFor('live-',500),selectedNodeId:null}, updates:0 };
const qa = window.qaGraph;
function LanguageControl(){qa.setLanguage=useUiLanguage().setLanguage;return null;}
qa.render = () => root.render(React.createElement(UiLanguageProvider,null,React.createElement(React.Fragment,null,React.createElement(LanguageControl),
  React.createElement('main',{className:'axiom-dashboard',style:{display:'grid',gridTemplate:'minmax(0,1fr) / minmax(0,1fr)',height:'100dvh',padding:'12px'}},
  React.createElement(AgentSignalGraph,{...qa.props,onSelectAgent:id=>qa.update({selectedNodeId:id})})))));
qa.update = patch => {qa.props={...qa.props,...patch};qa.render();};
qa.history = name => qa.update({agents:[],graph:graphFor(name+'-',name==='past'?3:6,name==='past'),phase:name==='past'?'complete':'inference',
  events:eventsFor(name+'-',name==='past'?12:500),selectedNodeId:null});
qa.dense = () => qa.update({agents:[],graph:graphFor('load-',20),events:eventsFor('load-',500),phase:'inference',selectedNodeId:null});
qa.start = () => { qa.stop();qa.updates=0;qa.timer=setInterval(()=>{qa.updates++;const n=qa.updates;
  qa.update({graph:{...qa.props.graph,revision:n+1,nodes:qa.props.graph.nodes.map((node,i)=>({...node,status:i===n%16?'running':i<n%16?'completed':'queued',tokens:node.tokens+7,durationMs:n*100}))},
    events:[...qa.props.events.slice(1),{id:'tick-'+n,phase:'inference',label:'Telemetry '+n,at:1700000500000+n*100}]});
},100);};
qa.stop = () => {clearInterval(qa.timer);qa.timer=null;};
qa.render();
`;
async function inspectLayout(page, expectedNodes) {
    const layout = await page.evaluate(() => {
        const stage = document.querySelector('.dash-agent-graph-stage').getBoundingClientRect();
        const header = document.querySelector('.dash-agent-signal-graph > header').getBoundingClientRect();
        const nodes = [...document.querySelectorAll('.dash-agent-signal-node')].map(element => {
            const bounds = element.querySelector('.dash-agent-sphere').getBoundingClientRect();
            const label = element.querySelector('.dash-agent-node-meta').getBoundingClientRect();
            const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            return { id: element.dataset.agentId, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
                label: { x: label.x, y: label.y, width: label.width, height: label.height },
                visible: getComputedStyle(element).visibility === 'visible' && getComputedStyle(element).opacity !== '0',
                accessible: !!hit?.closest('[data-agent-id="' + element.dataset.agentId + '"]'),
                inside: bounds.left >= stage.left - 1 && bounds.right <= stage.right + 1 && bounds.top >= stage.top - 1 && bounds.bottom <= stage.bottom + 1 };
        });
        const intersects = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2;
        const overlaps = nodes.flatMap((a, i) => nodes.slice(i + 1).filter(b => intersects(a, b) || intersects(a.label, b.label)).map(b => [a.id, b.id]));
        const controls = [...document.querySelectorAll('.dash-agent-graph-actions button')].map(el => el.getBoundingClientRect());
        return { nodes, overlaps, headerFits: controls.every(r => r.top >= header.top && r.bottom <= header.bottom && r.right <= header.right),
            overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.equal(layout.nodes.length, expectedNodes);
    assert.equal(await page.locator('.dash-agent-graph-world > svg path').count(), expectedNodes - 1);
    assert.ok(layout.nodes.every(n => n.width > 24 && n.height > 24 && n.visible && n.accessible && n.inside), JSON.stringify(layout));
    assert.deepEqual(layout.overlaps, [], 'Node silhouettes or labels overlap: ' + JSON.stringify(layout.overlaps));
    assert.ok(layout.headerFits && !layout.overflow, 'Graph controls overflow their header or viewport.');
    return layout;
}
async function heapSnapshot(cdp) {
    try {
        await cdp.send('HeapProfiler.collectGarbage');
        const usage = await cdp.send('Runtime.getHeapUsage');
        assert.ok(Number.isFinite(usage.usedSize) && usage.usedSize > 0);
        return { status: 'supported', method: 'CDP Runtime.getHeapUsage after explicit GC', usedBytes: usage.usedSize, totalBytes: usage.totalSize };
    }
    catch (error) {
        return { status: 'unsupported', usedBytes: null, reason: error.message };
    }
}
async function runViewport(viewport) {
    const label = `${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({ viewport, reducedMotion: 'no-preference', hasTouch: viewport.width < 700, permissions: ['local-network-access'] });
    const page = await context.newPage();
    const errors = [];
    const blocked = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error')
        errors.push(message.text()); });
    const main = await (await fetch(`${report.environment.fixtureOrigin}/src/main.tsx`)).text();
    const reactUrl = main.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    const reactDomUrl = main.match(/["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
    assert.ok(reactUrl && reactDomUrl, 'Vite React modules are required for the production component fixture.');
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== report.environment.fixtureOrigin || url.pathname.startsWith('/api/')) {
            blocked.push(url.origin + url.pathname);
            return route.abort('blockedbyclient');
        }
        if (url.pathname === '/__qa/graph.html')
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/__qa/graph.js");</script></body></html>' });
        if (url.pathname === '/__qa/graph.js')
            return route.fulfill({ contentType: 'text/javascript', body: fixtureSource(reactUrl, reactDomUrl) });
        return route.continue();
    });
    try {
        await page.goto(`${report.environment.fixtureOrigin}/__qa/graph.html?lang=zh-CN`);
        await page.locator('[data-renderer="css-3d"] [data-agent-id="live-5"]').waitFor();
        report.environment[label] = await page.evaluate(() => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory ?? null, devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
            motion: document.querySelector('[data-renderer]').dataset.motion, performanceObserverTypes: PerformanceObserver.supportedEntryTypes }));
        await check(label, 'production renderer, visible pixels, six agents and unclipped controls', async () => {
            await page.locator('.dash-agent-graph-focus').click();
            const screenshot = await page.screenshot({ path: `qa/agentgraph-${label}.png` });
            const layout = await inspectLayout(page, 6);
            const png = PNG.sync.read(screenshot);
            const colors = new Set();
            for (const node of layout.nodes) {
                for (let y = Math.ceil(node.y); y < Math.floor(node.y + node.height); y += 2)
                    for (let x = Math.ceil(node.x); x < Math.floor(node.x + node.width); x += 2) {
                        const index = (y * png.width + x) * 4;
                        colors.add(`${png.data[index] >> 3},${png.data[index + 1] >> 3},${png.data[index + 2] >> 3}`);
                    }
            }
            assert.ok(colors.size > 40, `Only ${colors.size} quantized colors inside the actual rendered agent silhouettes.`);
            return { nodes: layout.nodes.length, pixelColors: colors.size, screenshot: `qa/agentgraph-${label}.png` };
        });
        await check(label, 'pointer drag changes view without selecting a node', async () => {
            const stage = await page.locator('.dash-agent-graph-stage').boundingBox();
            const before = await page.locator('.dash-agent-graph-world').getAttribute('style');
            await page.mouse.move(stage.x + 20, stage.y + stage.height * .9);
            await page.mouse.down();
            await page.mouse.move(stage.x + 80, stage.y + stage.height * .85, { steps: 8 });
            await page.mouse.up();
            assert.notEqual(await page.locator('.dash-agent-graph-world').getAttribute('style'), before);
            assert.equal(await page.evaluate(() => window.qaGraph.props.selectedNodeId), null);
        });
        await check(label, 'live updates preserve camera and inspector; history replaces node state', async () => {
            await page.locator('.dash-agent-graph-focus').click();
            await page.locator('[data-agent-id="live-0"]').press('Enter');
            await page.locator('.dash-agent-node-detail').waitFor();
            const transform = await page.locator('.dash-agent-graph-world').getAttribute('style');
            await page.evaluate(() => window.qaGraph.update({ graph: { ...window.qaGraph.props.graph, nodes: window.qaGraph.props.graph.nodes.map((node, i) => i === 0 ? { ...node, status: 'failed', tokens: 4321, failureReason: 'Fixture source unavailable' } : node) } }));
            await page.locator('.dash-agent-node-state .status-failed').waitFor();
            await page.getByText('4,321', { exact: true }).waitFor();
            assert.equal(await page.locator('.dash-agent-graph-world').getAttribute('style'), transform);
            assert.equal(await page.locator('[data-agent-id="live-0"]').getAttribute('aria-pressed'), 'true');
            await page.evaluate(() => window.qaGraph.history('past'));
            await page.locator('[data-agent-id="past-2"].status-completed').waitFor();
            await page.waitForFunction(() => {
                const camera = new DOMMatrix(getComputedStyle(document.querySelector('.dash-agent-graph-world')).transform);
                return Math.abs(camera.m41) < .1 && Math.abs(camera.m42) < .1;
            });
            assert.equal(await page.locator('[data-agent-id^="live-"]').count(), 0);
            assert.equal(await page.locator('.dash-agent-node-state .status-failed').count(), 0);
            await page.evaluate(() => window.qaGraph.history('live'));
            await page.locator('[data-agent-id="live-5"].status-queued').waitFor();
            assert.equal(await page.locator('[data-agent-id^="past-"]').count(), 0);
            await page.keyboard.press('Escape');
        });
        await check(label, 'full screen and event virtualization remain reachable', async () => {
            await page.locator('.dash-agent-graph-expand').click();
            await page.locator('.dash-agent-graph-events').click();
            const list = page.locator('.dash-agent-event-list');
            await list.waitFor();
            assert.ok(await list.evaluate(element => element.clientHeight >= 120), 'The virtual event viewport collapsed below three rows.');
            assert.equal(await list.getAttribute('data-total-events'), '500');
            assert.ok(await page.locator('.dash-agent-event-row').count() <= budgets.maxEventRows);
            await list.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
            await page.locator('.dash-agent-event-row strong', { hasText: 'live- event 0' }).waitFor();
            const hit = await page.locator('.dash-agent-graph-panel > header button').last().evaluate(el => {
                const rect = el.getBoundingClientRect();
                return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            });
            assert.ok(hit, 'Panel close button is covered.');
            await page.screenshot({ path: `qa/agentgraph-events-${label}.png` });
            await page.locator('.dash-agent-graph-panel > header button').last().click();
            await page.keyboard.press('Escape');
        });
        await check(label, 'paused and offscreen graphs avoid repeated transform writes', async () => {
            await page.locator('.dash-agent-graph-focus').click();
            const writes = await page.evaluate(async () => {
                const world = document.querySelector('.dash-agent-graph-world');
                let count = 0;
                let setters = 0;
                const original = CSSStyleDeclaration.prototype.setProperty;
                CSSStyleDeclaration.prototype.setProperty = function (...args) { if (this === world.style)
                    setters++; return original.apply(this, args); };
                const observer = new MutationObserver(records => count += records.length);
                observer.observe(world, { attributes: true, attributeFilter: ['style'] });
                await new Promise(resolve => setTimeout(resolve, 700));
                observer.disconnect();
                CSSStyleDeclaration.prototype.setProperty = original;
                return { mutations: count, setters };
            });
            assert.equal(writes.setters, 0, `Paused graph performed ${writes.setters} transform setters and ${writes.mutations} mutations in 700 ms.`);
            await page.locator('.dash-agent-graph-auto').click();
            const offscreen = await page.evaluate(async () => {
                const graph = document.querySelector('.dash-agent-signal-graph');
                graph.style.transform = 'translateY(200vh)';
                await new Promise(resolve => setTimeout(resolve, 150));
                const world = graph.querySelector('.dash-agent-graph-world');
                let count = 0;
                const observer = new MutationObserver(records => count += records.length);
                observer.observe(world, { attributes: true, attributeFilter: ['style'] });
                await new Promise(resolve => setTimeout(resolve, 500));
                observer.disconnect();
                graph.style.transform = '';
                return count;
            });
            assert.equal(offscreen, 0);
            return { pausedStyleMutations: writes, offscreenStyleMutations: offscreen };
        });
        await check(label, 'dense source graph preserves node cap and visible layout', async () => {
            await page.evaluate(() => window.qaGraph.dense());
            await page.locator('[data-agent-id="load-15"]').waitFor();
            await page.locator('.dash-agent-graph-focus').click();
            assert.equal(await page.locator('.dash-agent-graph-actions > strong').innerText(), '16/20');
            await page.screenshot({ path: `qa/agentgraph-dense-${label}.png` });
            const layout = await inspectLayout(page, 16);
            return { sourceNodes: 20, renderedNodes: layout.nodes.length };
        });
        await check(label, '30-second telemetry frame, interaction and retained-heap budgets', async () => {
            let cdp;
            let measurementFailure;
            try {
            await page.evaluate(() => window.qaGraph.dense());
            if (await page.locator('.dash-agent-graph-panel').count())
                await page.locator('.dash-agent-graph-panel > header button').last().click();
            await page.locator('.dash-agent-graph-focus').click();
            await page.mouse.move(1, 1);
            if (await page.locator('.dash-agent-graph-auto').isEnabled())
                await page.locator('.dash-agent-graph-auto').click();
            await page.locator('.dash-agent-graph-expand').click();
            await page.locator('.dash-agent-graph-events').click();
            assert.ok(await page.locator('.dash-agent-event-list').evaluate(element => element.clientHeight >= 120));
            cdp = await context.newCDPSession(page);
            await cdp.send('Performance.enable');
            const heapBefore = await heapSnapshot(cdp);
            const cpuBefore = await cdp.send('Performance.getMetrics');
            await page.evaluate(() => {
                const sample = window.graphSample = { frames: [], interactions: [], longTasks: [], started: performance.now(), last: null, active: true };
                const tick = now => { if (!sample.active)
                    return; if (sample.last !== null)
                    sample.frames.push(now - sample.last); sample.last = now; sample.raf = requestAnimationFrame(tick); };
                sample.raf = requestAnimationFrame(tick);
                if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
                    sample.observer = new PerformanceObserver(list => sample.longTasks.push(...list.getEntries().map(entry => entry.duration)));
                    sample.observer.observe({ type: 'longtask' });
                }
                sample.pointer = event => {
                    if (event.buttons !== 1)
                        return;
                    const start = performance.now();
                    const before = document.querySelector('.dash-agent-graph-world').style.transform;
                    requestAnimationFrame(() => requestAnimationFrame(() => { if (sample.active)
                        sample.interactions.push({ ms: performance.now() - start, changed: document.querySelector('.dash-agent-graph-world').style.transform !== before, trusted: event.isTrusted }); }));
                };
                document.addEventListener('pointermove', sample.pointer, true);
                window.qaGraph.start();
            });
            const started = Date.now();
            let interactions = 0;
            while (Date.now() - started < budgets.durationMs) {
                const stage = await page.locator('.dash-agent-graph-stage').boundingBox();
                await page.mouse.move(stage.x + 12, stage.y + stage.height * .08);
                await page.mouse.down();
                await page.mouse.move(stage.x + 30 + (interactions % 2) * 12, stage.y + stage.height * .1);
                await page.mouse.up();
                interactions++;
                await page.waitForTimeout(1000);
            }
            const sample = await page.evaluate(() => {
                const s = window.graphSample;
                s.active = false;
                cancelAnimationFrame(s.raf);
                s.observer?.disconnect();
                document.removeEventListener('pointermove', s.pointer, true);
                window.qaGraph.stop();
                return { frames: s.frames, interactions: s.interactions, longTasks: s.longTasks, durationMs: performance.now() - s.started, updates: window.qaGraph.updates,
                    nodes: document.querySelectorAll('.dash-agent-signal-node').length, events: window.qaGraph.props.events.length };
            });
            const cpuAfter = await cdp.send('Performance.getMetrics');
            const heapAfter = await heapSnapshot(cdp);
            const metric = name => (cpuAfter.metrics.find(m => m.name === name)?.value ?? 0) - (cpuBefore.metrics.find(m => m.name === name)?.value ?? 0);
            const evidence = { ...sample, frames: distribution(sample.frames), interactions: distribution(sample.interactions.map(i => i.ms)), longTasks: distribution(sample.longTasks),
                interactionMethod: 'Trusted pointermove handler entry to second requestAnimationFrame after transform change; paint opportunity proxy, not INP.',
                frameMethod: 'requestAnimationFrame intervals during production CSS 3D rendering and 10 Hz telemetry; includes browser scheduling.',
                mainThread: { taskMs: metric('TaskDuration') * 1000, layoutMs: metric('LayoutDuration') * 1000, recalcStyleMs: metric('RecalcStyleDuration') * 1000 },
                heap: { before: heapBefore, after: heapAfter, growthBytes: heapBefore.status === 'supported' && heapAfter.status === 'supported' ? heapAfter.usedBytes - heapBefore.usedBytes : null } };
            // Keep measurements when a budget fails; do not discard the first failed sample.
            report.results.push({ viewport: label, name: 'workload measurements', status: 'measured', evidence });
            assert.equal(sample.nodes, 16);
            assert.equal(sample.events, 500);
            assert.ok(sample.durationMs >= budgets.durationMs && sample.updates >= budgets.minUpdates, `Insufficient workload: ${JSON.stringify({ durationMs: sample.durationMs, updates: sample.updates })}`);
            assert.ok(evidence.frames.samples >= budgets.minFrames && evidence.frames.p95 <= budgets.frameP95Ms && evidence.frames.p99 <= budgets.frameP99Ms, JSON.stringify(evidence.frames));
            assert.ok(sample.interactions.length >= budgets.minInteractions && sample.interactions.every(i => i.changed && i.trusted), 'Missing trusted pointer interactions or camera updates.');
            assert.ok(evidence.interactions.p95 <= budgets.interactionP95Ms, JSON.stringify(evidence.interactions));
            assert.equal(heapBefore.status, 'supported', 'Heap measurement unavailable: ' + heapBefore.reason);
            assert.equal(heapAfter.status, 'supported', 'Heap measurement unavailable: ' + heapAfter.reason);
            assert.ok(evidence.heap.growthBytes <= budgets.heapGrowthBytes && heapAfter.usedBytes <= budgets.retainedHeapBytes, JSON.stringify(evidence.heap));
            assert.ok(await page.locator('.dash-agent-event-row').count() <= budgets.maxEventRows);
            await page.locator('.dash-agent-graph-focus').click();
            await page.screenshot({ path: `qa/agentgraph-load-${label}.png` });
            } catch (error) {
                measurementFailure = error;
                throw error;
            } finally {
                // A failed budget is still a failure, but must not leave telemetry,
                // pointer state or a toggled panel behind for the next scenario.
                const cleanupErrors = [];
                const cleanup = async (action) => {
                    try { await action(); } catch (error) { cleanupErrors.push(error.message); }
                };
                await cleanup(() => page.evaluate(() => {
                    window.qaGraph.stop();
                    const sample = window.graphSample;
                    if (!sample) return;
                    sample.active = false;
                    cancelAnimationFrame(sample.raf);
                    sample.observer?.disconnect();
                    if (sample.pointer) document.removeEventListener('pointermove', sample.pointer, true);
                }));
                await cleanup(() => page.mouse.up());
                if (cdp) await cleanup(() => cdp.detach());
                await cleanup(async () => {
                    if (await page.locator('.dash-agent-graph-panel').count())
                        await page.locator('.dash-agent-graph-panel > header button').last().click();
                    await page.keyboard.press('Escape');
                    await page.locator('.dash-agent-signal-graph:not(.is-expanded)').waitFor();
                });
                if (cleanupErrors.length) {
                    const error = new Error(`Performance fixture cleanup failed: ${cleanupErrors.join(' | ')}`);
                    if (!measurementFailure) throw error;
                    report.results.push({ viewport: label, name: 'performance fixture cleanup', status: 'failed', error: error.message });
                }
            }
        });
        await check(label, 'custom graph names survive bilingual state and ARIA updates', async () => {
            await page.evaluate(() => {
                window.qaGraph.update({ graph: { nodes: [{ id: 'named', role: 'custom-helper', title: '\u7814\u7a76\u5458', dependsOn: [], status: 'running' },
                            { id: 'builtin', role: 'researcher', title: 'Builtin', dependsOn: ['named'], status: 'queued' }], edges: [] }, selectedNodeId: null });
                window.qaGraph.setLanguage('en');
            });
            await page.locator('[data-agent-id="builtin"] em', { hasText: 'Researcher' }).waitFor();
            assert.equal(await page.locator('[data-agent-id="named"] em').innerText(), '\u7814\u7a76\u5458');
            assert.equal(await page.locator('[data-agent-id="named"]').getAttribute('aria-label'), '\u7814\u7a76\u5458\uff0cExecuting');
            await page.evaluate(() => window.qaGraph.update({ graph: { ...window.qaGraph.props.graph, nodes: window.qaGraph.props.graph.nodes.map(n => n.id === 'named' ? { ...n, status: 'failed' } : n) } }));
            await page.locator('[data-agent-id="named"][aria-label$="Failed"]').waitFor();
            await page.evaluate(() => window.qaGraph.setLanguage('zh-CN'));
            await page.locator('[data-agent-id="named"][aria-label$="\u5931\u8d25"]').waitFor();
            assert.equal(await page.locator('[data-agent-id="named"] em').innerText(), '\u7814\u7a76\u5458');
            await page.evaluate(() => window.qaGraph.history('live'));
        });
        await check(label, 'system event translation preserves names and verbatim source text', async () => {
            await page.evaluate(() => window.qaGraph.update({ events: [
                { id: 'saved', phase: 'inference', label: '\u4efb\u52a1\u5df2\u6301\u4e45\u5316', labelSource: 'system', at: 1700000000000 },
                { id: 'failed', phase: 'error', label: '\u7814\u7a76\u5458\u7684\u9636\u6bb5\u8c03\u7528\u672a\u5b8c\u6210', labelSource: 'system', at: 1700000000100 },
                { id: 'verbatim', phase: 'inference', label: '\u4efb\u52a1\u5df2\u6301\u4e45\u5316', labelSource: 'verbatim', at: 1700000000200 },
                { id: 'legacy', phase: 'inference', label: '\u4efb\u52a1\u7ba1\u7406', at: 1700000000300 },
            ] }));
            // Enter a known state rather than toggling a panel inherited from a
            // previous scenario. Translation assertions below remain exact.
            if (await page.locator('.dash-agent-signal-graph.is-expanded').count() === 0)
                await page.locator('.dash-agent-graph-expand').click();
            await page.locator('.dash-agent-signal-graph.is-expanded').waitFor();
            if (await page.locator('.dash-agent-graph-events').getAttribute('aria-pressed') !== 'true')
                await page.locator('.dash-agent-graph-events').click();
            await page.locator('.dash-agent-event-list[data-total-events="4"]').waitFor();
            await page.waitForFunction(() => document.querySelectorAll('.dash-agent-event-row strong').length === 4);
            const english = ['\u4efb\u52a1\u7ba1\u7406', '\u4efb\u52a1\u5df2\u6301\u4e45\u5316', "\u7814\u7a76\u5458's stage call did not complete", 'Task saved durably'];
            const chinese = ['\u4efb\u52a1\u7ba1\u7406', '\u4efb\u52a1\u5df2\u6301\u4e45\u5316', '\u7814\u7a76\u5458\u7684\u9636\u6bb5\u8c03\u7528\u672a\u5b8c\u6210', '\u4efb\u52a1\u5df2\u6301\u4e45\u5316'];
            for (const [language, expected] of [['en', english], ['zh-CN', chinese], ['en', english]]) {
                await page.evaluate(value => window.qaGraph.setLanguage(value), language);
                await page.waitForFunction(values => {
                    const nodes = [...document.querySelectorAll('.dash-agent-event-row strong')];
                    return nodes.length === values.length && nodes.every((node, index) => node.textContent === values[index] && node.title === values[index]);
                }, expected);
            }
            await page.evaluate(() => window.qaGraph.update({ events: [...window.qaGraph.props.events,
                { id: 'started', phase: 'inference', label: '\u4efb\u52a1\u7ba1\u7406\u5f00\u59cb\u6267\u884c', labelSource: 'system', at: 1700000000400 },
            ] }));
            await page.locator('.dash-agent-event-row strong', { hasText: '\u4efb\u52a1\u7ba1\u7406 started execution' }).waitFor();
            await page.locator('.dash-agent-graph-panel > header button').last().click();
            await page.keyboard.press('Escape');
            await page.evaluate(() => { window.qaGraph.setLanguage('zh-CN'); window.qaGraph.history('live'); });
        });
        await check(label, 'reduced motion disables auto rotation without disabling pointer control', async () => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.locator('[data-motion="reduced"]').waitFor();
            assert.ok(await page.locator('.dash-agent-graph-auto').isDisabled());
            const before = await page.locator('.dash-agent-graph-world').getAttribute('style');
            const stage = await page.locator('.dash-agent-graph-stage').boundingBox();
            await page.mouse.move(stage.x + 10, stage.y + stage.height * .9);
            await page.mouse.down();
            await page.mouse.move(stage.x + 60, stage.y + stage.height * .85);
            await page.mouse.up();
            assert.notEqual(await page.locator('.dash-agent-graph-world').getAttribute('style'), before);
        });
        await check(label, 'no browser errors or network/API calls', async () => { assert.deepEqual(errors, []); assert.deepEqual(blocked, []); });
    }
    finally {
        await context.close();
    }
}
try {
    server = await createServer({ cacheDir: path.join(scratch, 'node_modules', '.vite'), envFile: false, server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, proxy: {} } });
    assert.ok(server.httpServer, 'Graph QA needs an isolated HTTP server.');
    const listening = once(server.httpServer, 'listening');
    server.httpServer.listen(0, '127.0.0.1');
    await listening;
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    report.environment.fixtureOrigin = `http://127.0.0.1:${address.port}`;
    server.config.server.port = address.port;
    browser = await chromium.launch({ headless: true });
    report.environment.browser = browser.version();
    const browserCdp = await browser.newBrowserCDPSession();
    const system = await browserCdp.send('SystemInfo.getInfo');
    report.environment.graphics = { devices: system.gpu.devices, features: system.gpu.featureStatus };
    await browserCdp.detach();
    await mkdir('qa', { recursive: true });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await runViewport(viewport);
    }
}
catch (error) {
    report.results.push({ name: 'fixture setup or execution', status: 'failed', error: error.stack ?? error.message });
}
finally {
    await browser?.close();
    await server?.close();
    await rm(scratch, { recursive: true, force: true });
    report.status = report.results.some(r => r.status === 'failed') ? 'failed' : 'passed';
    const serialized = JSON.stringify(report, null, 2) + '\n';
    await writeFile(`qa/agentgraph-performance-${report.generatedAt.replace(/[:.]/g, '-')}-results.json`, serialized);
    await writeFile('qa/agentgraph-performance-results.json', serialized);
    console.log(serialized);
    if (report.status === 'failed')
        process.exitCode = 1;
}
