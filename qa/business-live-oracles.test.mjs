import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { chromium } from '@playwright/test';
import { evaluateJsonDelivery, inspectSvgDelivery, liveDeliveryCases, unwrapDelivery } from './lib/live-delivery-cases.mjs';

let browser;
let context;
let page;
const requests = [];
before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  context.on('request', (request) => requests.push(request.url()));
  await context.route('**/*', (route) => route.abort('blockedbyclient'));
  page = await context.newPage();
});
after(async () => { await context?.close(); await browser?.close(); });

const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" width="320" height="160" role="img" aria-labelledby="board-title"><title id="board-title">Status board</title><rect x="0" y="0" width="320" height="160" fill="#202626"/><g font-family="Arial, sans-serif" font-size="14" text-anchor="middle"><circle cx="60" cy="80" r="12" fill="#22c55e"/><circle cx="160" cy="80" r="12" fill="#eab308"/><circle cx="260" cy="80" r="12" fill="#ef4444"/><text x="60" y="120" fill="#ffffff">Ready</text><text x="160" y="120" fill="#ffffff">Review</text><text x="260" y="120" fill="#ffffff">Blocked</text></g></svg>';
const extraElement = (markup) => validSvg.replace('</svg>', `${markup}</svg>`);
async function inspectInert(source) {
  const result = await page.evaluate(inspectSvgDelivery, source);
  assert.equal(await page.locator('body > *').count(), 0, 'generated markup must not be mounted into the browser document');
  assert.deepEqual(requests, [], 'DOMParser validation must not initiate resource requests');
  return result;
}

test('live delivery oracle rejects swapped citations and unsupported facts independently of model review', () => {
  const fixture = liveDeliveryCases[0];
  const correct = { recommendedService: 'North', requiredCapacity: 100, selectedCapacity: 120, dailyFee: 30, latencyVerified: false, references: [{ id: 'SRC-N', url: 'https://north.example/spec' }, { id: 'SRC-S', url: 'https://south.example/spec' }] };
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify(correct)).passed, true);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify({ ...correct, latencyVerified: true })).passed, false);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify({ ...correct, references: correct.references.map((item, index) => ({ ...item, url: correct.references[1 - index].url })) })).passed, false);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify({ ...correct, recommendedService: 'South' })).passed, false);
});

test('live document oracle rejects old totals, missing items, and truncated delivery', () => {
  const fixture = liveDeliveryCases[1];
  const correct = { currency: 'CNY', currentTotal: 4700, removedReviewFee: 500, acceptedItems: ['A', 'B'], missingTaxRate: true };
  assert.equal(evaluateJsonDelivery(fixture, `\x60\x60\x60json\n${JSON.stringify(correct)}\n\x60\x60\x60`).passed, true);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify({ ...correct, currentTotal: 5200 })).passed, false);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify({ ...correct, acceptedItems: ['A', 'A'] })).passed, false);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify(correct).slice(0, -1)).passed, false);
});

test('live multi-turn oracle requires retained constraints and no external dispatch', () => {
  const fixture = liveDeliveryCases[2];
  const correct = { date: '2027-02-03', participants: 20, budgetCny: 4500, channels: ['email'], dispatched: false };
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify(correct)).passed, true);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify({ ...correct, dispatched: true })).passed, false);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify({ ...correct, budgetCny: 6000 })).passed, false);
  assert.equal(evaluateJsonDelivery(fixture, JSON.stringify({ ...correct, channels: ['email', 'SMS'] })).passed, false);
  assert.equal(unwrapDelivery('```svg\n<svg/>\n```', 'svg'), '<svg/>');
  assert.equal(unwrapDelivery('Explanation\n```svg\n<svg/>\n```', 'svg').startsWith('Explanation'), true);
});

test('SVG oracle accepts a bounded static status board without mounting or rendering it', async () => {
  assert.equal(await inspectInert(validSvg), true);
  assert.equal(await inspectInert(`<?xml version="1.0"?>${validSvg}`), true);
  assert.equal(await inspectInert(validSvg.replace('<rect x="0" y="0" width="320" height="160" fill="#202626"/>', '')), true);
});

const invalidSvgs = [
  ['xml-stylesheet processing instruction', `<?xml-stylesheet href="https://fixture.invalid/style.css" type="text/css"?>${validSvg}`],
  ['processing instruction inside SVG', extraElement('<?application fetch="https://fixture.invalid/data"?>')],
  ['external DTD declaration', `<!DOCTYPE svg SYSTEM "https://fixture.invalid/board.dtd">${validSvg}`],
  ['hidden parent visibility', validSvg.replace('<g font-family', '<g visibility="hidden" font-family')],
  ['transparent parent opacity', validSvg.replace('<g font-family', '<g opacity="0" font-family')],
  ['display none', validSvg.replace('<g font-family', '<g display="none" font-family')],
  ['animateMotion', extraElement('<animateMotion path="M0,0 L1000,1000" dur="1s"/>')],
  ['foreign namespace iframe source', extraElement('<iframe xmlns="http://www.w3.org/1999/xhtml" src="https://fixture.invalid/frame"/>')],
  ['foreign namespace circle impersonation', validSvg.replace('<circle cx="60"', '<circle xmlns="http://fixture.invalid/not-svg" cx="60"')],
  ['translated out of view', validSvg.replace('<g font-family', '<g transform="translate(10000 0)" font-family')],
  ['style color overriding required fill', validSvg.replace('fill="#22c55e"', 'fill="#22c55e" style="fill:red"')],
  ['namespaced href', validSvg.replace('<circle cx="60"', '<circle xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://fixture.invalid/shape" cx="60"')],
  ['event handler', validSvg.replace('<circle cx="60"', '<circle onload="globalThis.injected=true" cx="60"')],
  ['zero-size root', validSvg.replace('width="320" height="160" role', 'width="0" height="160" role')],
  ['label moved outside viewport', validSvg.replace('x="60" y="120"', 'x="10000" y="120"')],
  ['invisible label fill', validSvg.replace('fill="#ffffff">Ready', 'fill="transparent">Ready')],
  ['background covering all content', validSvg.replace('<rect x="0" y="0" width="320" height="160" fill="#202626"/>', '').replace('</svg>', '<rect x="0" y="0" width="320" height="160" fill="#202626"/></svg>')],
  ['nested viewport changes coordinates', validSvg.replace('<g font-family', '<svg viewBox="0 0 10000 10000"><g font-family').replace('</g>', '</g></svg>')],
  ['circles hidden inside title', validSvg.replace('<circle cx="60" cy="80" r="12" fill="#22c55e"/>', '').replace('</title>', '<circle cx="60" cy="80" r="12" fill="#22c55e"/></title>')],
  ['wrong circle color', validSvg.replace('fill="#22c55e"', 'fill="#22c55f"')],
  ['non-SVG numeric geometry syntax', validSvg.replace('cx="60"', 'cx="0x3c"')],
  ['duplicate label and missing requested label', validSvg.replace('>Blocked</text>', '>Ready</text>')],
  ['truncated source', validSvg.slice(0, -6)],
];
for (const [name, source] of invalidSvgs) {
  test(`SVG oracle rejects ${name} using inert DOMParser`, async () => {
    assert.equal(await inspectInert(source), false);
  });
}
