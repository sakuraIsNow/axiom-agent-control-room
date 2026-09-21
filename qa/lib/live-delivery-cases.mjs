import { z } from 'zod';

const reference = z.object({ id: z.string(), url: z.string().url() }).strict();
export const liveDeliveryCases = [
  {
    id: 'supplied-source-comparison', mode: 'decide',
    message: 'Compare these fictional services using only the supplied records. Source SRC-N, https://north.example/spec: capacity 120 jobs/hour, fee 30 credits/day. Source SRC-S, https://south.example/spec: capacity 80 jobs/hour, fee 20 credits/day. We need at least 100 jobs/hour. Neither record measures latency. Return only JSON with recommendedService (North or South), requiredCapacity (number), selectedCapacity (number), dailyFee (number), latencyVerified (boolean), and references (array of objects with id and url, include both sources). Do not browse or claim to have visited the URLs.',
    schema: z.object({ recommendedService: z.literal('North'), requiredCapacity: z.literal(100), selectedCapacity: z.literal(120), dailyFee: z.literal(30), latencyVerified: z.literal(false), references: z.array(reference).length(2) }).strict(),
    verify: (value) => ['SRC-N|https://north.example/spec', 'SRC-S|https://south.example/spec'].every((key) => value.references.some((item) => `${item.id}|${item.url}` === key)),
    scope: 'Supplied synthetic evidence, exact source attribution and unsupported latency; no live web search.',
  },
  {
    id: 'word-budget-analysis', mode: 'analyze', document: true,
    message: 'Analyze the attached project budget. Apply the revised decision, not the superseded review charge. Return only JSON with currency, currentTotal (number), removedReviewFee (number), acceptedItems (array of item IDs), and missingTaxRate (boolean). Use only the document and do not invent a tax rate.',
    documentLines: ['Project: Cedar', 'Currency: CNY', 'A: implementation 2800', 'B: testing 1900', 'C: review 500', 'Revised decision: cancel item C entirely. A and B remain approved.', 'No tax rate is stated.'],
    schema: z.object({ currency: z.literal('CNY'), currentTotal: z.literal(4700), removedReviewFee: z.literal(500), acceptedItems: z.array(z.enum(['A', 'B'])).length(2), missingTaxRate: z.literal(true) }).strict(),
    verify: (value) => new Set(value.acceptedItems).size === 2,
    scope: 'Actual DOCX extraction plus derived amounts; no OCR or image-recognition claim.',
  },
  {
    id: 'changed-user-requirements', mode: 'analyze',
    history: [{ role: 'user', content: 'Prepare a rollout for 20 people on 2027-02-03, budget 6000 CNY. Include email and SMS.' }, { role: 'assistant', content: 'Draft requirements recorded; nothing has been sent or scheduled.' }],
    message: 'Update that draft: the budget is now 4500 CNY, use email only, and keep the date and participant count unchanged. Do not send anything or create a schedule. Return only JSON with date (YYYY-MM-DD), participants (number), budgetCny (number), channels (array), and dispatched (boolean).',
    schema: z.object({ date: z.literal('2027-02-03'), participants: z.literal(20), budgetCny: z.literal(4500), channels: z.tuple([z.literal('email')]), dispatched: z.literal(false) }).strict(),
    verify: () => true,
    scope: 'Supplied two-turn context, replacement and retained constraints; no external messages or schedules.',
  },
  {
    id: 'svg-status-board', mode: 'build', svg: true,
    message: 'Create a standalone SVG status board as source text, not an image-service call. Return one svg fenced block and nothing else. Use viewBox="0 0 320 160". It must contain exactly three circles with radius 12, centers (60,80), (160,80), (260,80), colored #22c55e, #eab308, #ef4444 respectively. Add exactly three text elements Ready, Review, Blocked with explicit in-view x/y coordinates and font sizes from 8 to 32. Include one title element. Use only svg, title, desc, g, rect, circle and text elements, plain presentation attributes and opaque colors. An optional background rect must be first, x=0, y=0, width=320, height=160. No transforms, style attributes, scripts, stylesheets, external resources, foreignObject, animation or tools. Do not claim a file was saved.',
    scope: 'Small static SVG subset parsed structurally in an offline browser without mounting it; not a screenshot, visual-legibility score or image-generation-provider test.',
  },
];

export const unwrapDelivery = (output, language) => {
  const text = output.trim();
  const fenced = text.match(/^```([a-z]*)\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return fenced && (!fenced[1] || fenced[1].toLowerCase() === language) ? fenced[2].trim() : text;
};

export const evaluateJsonDelivery = (fixture, output) => {
  try {
    const parsed = fixture.schema.safeParse(JSON.parse(unwrapDelivery(output, 'json')));
    if (!parsed.success) return { passed: false, reason: 'Delivered fields do not match the independent source/requirement oracle.' };
    return fixture.verify(parsed.data) ? { passed: true, reason: 'All required fields and source references match.' }
      : { passed: false, reason: 'Source attribution or required-item coverage is incorrect.' };
  } catch { return { passed: false, reason: 'Delivery is not a complete JSON document.' }; }
};

// Runs only inside DOMParser. This intentionally small fixture subset is not
// a general SVG sanitizer or a substitute for rendered-pixel verification.
export const inspectSvgDelivery = (source) => {
  if (typeof source !== 'string' || source.length > 16_000 || /<!DOCTYPE\b/i.test(source)) return false;
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.localName !== 'svg' || svg.namespaceURI !== 'http://www.w3.org/2000/svg') return false;
  if (svg.getAttribute('viewBox') !== '0 0 320 160') return false;
  const namespace = 'http://www.w3.org/2000/svg';
  const attributes = {
    svg: ['xmlns', 'viewBox', 'width', 'height', 'role', 'aria-label', 'aria-labelledby'],
    title: [], desc: [], g: [], rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
    circle: ['cx', 'cy', 'r'], text: ['x', 'y', 'dominant-baseline'],
  };
  const presentation = ['id', 'fill', 'font-family', 'font-size', 'font-weight', 'text-anchor'];
  const numeric = (value) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(Number(value));
  const inRange = (value, minimum, maximum) => numeric(value) && Number(value) >= minimum && Number(value) <= maximum;
  const opaqueColor = (value) => /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|black|white|gray|grey|silver)$/i.test(value);
  const ids = new Set();
  let count = 0;
  const inspectNode = (node, depth = 0) => {
    if (depth > 24 || ++count > 128) return false;
    // Reject processing instructions, DTDs and all other active/unknown nodes,
    // including xml-stylesheet before or inside the SVG root.
    if (![1, 3, 4, 8, 9].includes(node.nodeType)) return false;
    if (node.nodeType === 1) {
      const name = node.localName;
      if (node.namespaceURI !== namespace || node.prefix || !Object.hasOwn(attributes, name)) return false;
      if (node !== svg && !['svg', 'g'].includes(node.parentElement?.localName)) return false;
      if (name === 'svg' && node !== svg) return false;
      const allowed = new Set([...presentation, ...attributes[name]]);
      for (const attr of node.attributes) {
        if (attr.name === 'xmlns') {
          if (node !== svg || attr.value !== namespace) return false;
          continue;
        }
        if (attr.namespaceURI || attr.prefix || !allowed.has(attr.name)) return false;
        const value = attr.value;
        if (attr.name === 'id') {
          if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || ids.has(value)) return false;
          ids.add(value);
        }
        if (attr.name === 'fill' && !opaqueColor(value)) return false;
        if (attr.name === 'font-family' && !/^[A-Za-z0-9 ,"'_-]{1,100}$/.test(value)) return false;
        if (attr.name === 'font-size' && !inRange(value, 8, 32)) return false;
        if (attr.name === 'font-weight' && !/^(?:normal|bold|[1-9]00)$/.test(value)) return false;
        if (attr.name === 'text-anchor' && !['start', 'middle', 'end'].includes(value)) return false;
        if (attr.name === 'dominant-baseline' && !['auto', 'middle', 'central', 'hanging', 'text-before-edge', 'text-after-edge', 'alphabetic'].includes(value)) return false;
        if (attr.name === 'role' && value !== 'img') return false;
      }
      if (name === 'svg' && ((node.hasAttribute('width') && node.getAttribute('width') !== '320')
        || (node.hasAttribute('height') && node.getAttribute('height') !== '160'))) return false;
      if (name === 'circle' && ['cx', 'cy', 'r'].some((key) => !numeric(node.getAttribute(key)))) return false;
      if (name === 'text' && (!inRange(node.getAttribute('x'), 1, 319) || !inRange(node.getAttribute('y'), 8, 152))) return false;
      if (name === 'rect' && ['rx', 'ry'].some((key) => node.hasAttribute(key) && !inRange(node.getAttribute(key), 0, 24))) return false;
    }
    return [...node.childNodes].every((child) => inspectNode(child, depth + 1));
  };
  if (!inspectNode(doc)) return false;
  const titles = [...doc.querySelectorAll('title')];
  if (titles.length !== 1 || !titles[0].textContent.trim() || doc.querySelectorAll('desc').length > 1) return false;
  const drawings = [...doc.querySelectorAll('rect, circle, text')];
  const rectangles = drawings.filter((element) => element.localName === 'rect');
  if (rectangles.length > 1) return false;
  if (rectangles.length) {
    const rectangle = rectangles[0];
    if (drawings[0] !== rectangle || rectangle.getAttribute('x') !== '0' || rectangle.getAttribute('y') !== '0'
      || rectangle.getAttribute('width') !== '320' || rectangle.getAttribute('height') !== '160') return false;
  }
  const circles = [...doc.querySelectorAll('circle')];
  if (circles.length !== 3) return false;
  const expected = [[60, '#22c55e'], [160, '#eab308'], [260, '#ef4444']];
  if (!expected.every(([x, color]) => circles.some((circle) => Number(circle.getAttribute('cx')) === x && Number(circle.getAttribute('cy')) === 80 && Number(circle.getAttribute('r')) === 12 && circle.getAttribute('fill')?.toLowerCase() === color))) return false;
  const text = [...doc.querySelectorAll('text')].map((el) => el.textContent.trim());
  return text.length === 3 && ['Ready', 'Review', 'Blocked'].every((label) => text.includes(label));
};
