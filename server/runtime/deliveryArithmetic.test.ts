import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { calculationSchema, evaluateCalculation, validateCalculation,
  type CalculationExpression, type DeliveryCalculation } from './deliveryArithmetic.js';

const sources = [{ id: 'input', text: 'Daily jobs: 600. Hourly capacity: 120. Days: 3. Fee: 30. Budget: 100.' }];
const leaf = (value: number, sourceQuote = String(value), sourceId = 'input'): CalculationExpression => ({ sourceId, sourceQuote, value });
const op = (operation: 'add' | 'subtract' | 'multiply' | 'divide', left: CalculationExpression, right: CalculationExpression): CalculationExpression =>
  ({ op: operation, args: [left, right] });
const calc = (expression = op('divide', leaf(600), leaf(120)), path = ['processingHoursPerDay']): DeliveryCalculation => ({ path, expression });

test('independent arithmetic rejects 600 / 120 = 1.25 even if a model would approve it', () => {
  const calculation = calc();
  validateCalculation(calculation, sources);
  const result = '{"processingHoursPerDay":1.25}';
  assert.deepEqual(evaluateCalculation(calculation, result), {
    status: 'unsatisfied', expected: 5, actual: 1.25,
    reason: 'Independent calculation mismatch: expected 5, received 1.25.', outputQuote: result,
  });
  assert.equal(evaluateCalculation(calculation, '{"processingHoursPerDay":5}').status, 'satisfied');
});

test('nested operations, array paths and a single JSON fence are supported', () => {
  const calculation = calc(op('subtract', leaf(100), op('multiply', leaf(30), leaf(3))), ['budget', '0', 'remaining']);
  validateCalculation(calculation, sources);
  const result = '```json\n{"budget":[{"remaining":10}]}\n```';
  const assessment = evaluateCalculation(calculation, result);
  assert.equal(assessment.status, 'satisfied');
  assert.equal(assessment.expected, 10);
  assert.ok(result.includes(assessment.outputQuote));
});

test('addition and decimal operands use the fixed relative tolerance', () => {
  const calculation = calc(op('add', leaf(0.1), leaf(0.2)));
  validateCalculation(calculation, [{ id: 'input', text: 'Values: 0.1 and 0.2.' }]);
  assert.equal(evaluateCalculation(calculation, '{"processingHoursPerDay":0.3}').status, 'satisfied');
  assert.equal(evaluateCalculation(calculation, '{"processingHoursPerDay":0.30000001}').status, 'unsatisfied');
  assert.equal(evaluateCalculation(calc(leaf(100)), '{"processingHoursPerDay":100.00000005}').status, 'satisfied');
  assert.equal(evaluateCalculation(calc(leaf(100)), '{"processingHoursPerDay":100.0000002}').status, 'unsatisfied');
});

test('scientific notation, signed values and leading-dot decimals are grounded as complete tokens', () => {
  for (const [text, value] of [['1.2e+2', 120], ['6E2', 600], ['-1.25', -1.25], ['+1.25', 1.25], ['.5', 0.5], ['1e-3', 0.001]] as const) {
    const calculation = calc(leaf(value, text));
    validateCalculation(calculation, [{ id: 'input', text: `Value: ${text}; end.` }]);
    assert.equal(evaluateCalculation(calculation, JSON.stringify({ processingHoursPerDay: value })).status, 'satisfied');
  }
});

test('source IDs and quotes must be exact and original values cannot be invented', () => {
  assert.throws(() => validateCalculation(calc(leaf(600, '600', 'missing')), sources));
  assert.throws(() => validateCalculation(calc(leaf(600, 'Daily jobs: 601')), sources));
  assert.throws(() => validateCalculation(calc(leaf(601, '600')), sources));
  assert.throws(() => validateCalculation(calc(), []));
  assert.throws(() => validateCalculation(calc(), [sources[0]!, sources[0]!]));
  assert.throws(() => validateCalculation(calc(), [{ id: 'input', text: ' ' }]));
});

test('a quote may not forge a source number by clipping a larger numeric token', () => {
  for (const [text, quote, value] of [
    ['600', '6', 6], ['1.25', '1', 1], ['1.25', '25', 25], ['1e3', '1', 1],
    ['1e3', '3', 3], ['-120', '120', 120], ['A120', '120', 120], ['1.2e+2', '2', 2],
    ['1,200', '1', 1], ['1,200', '200', 200],
  ] as const) {
    assert.throws(() => validateCalculation(calc(leaf(value, quote)), [{ id: 'input', text }]));
  }
});

test('later exact quote occurrences may supply a valid full token', () => {
  validateCalculation(calc(leaf(6)), [{ id: 'input', text: '600 and 6.' }]);
});

test('malformed, missing, string, null and non-finite JSON values never pass', () => {
  for (const result of ['', 'Five hours', '{"processingHoursPerDay":5', 'Prefix {"processingHoursPerDay":5}',
    '```js\n{"processingHoursPerDay":5}\n```', '```json\n{"processingHoursPerDay":5}\n```\nExtra',
    '{"processingHoursPerDay":"5"}', '{"processingHoursPerDay":null}', '{"processingHoursPerDay":1e309}', '{}', 'null']) {
    assert.equal(evaluateCalculation(calc(), result).status, 'unknown', result);
  }
  assert.equal(evaluateCalculation(calc(leaf(1), ['nested', 'value']), '{"nested":5}').status, 'unknown');
  assert.equal(evaluateCalculation(calc(leaf(0), ['length']), '[]').status, 'satisfied');
});

test('prototype keys and inherited properties cannot be accessed', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const calculation = calc(leaf(5), [key, 'value']);
    assert.equal(calculationSchema.safeParse(calculation).success, false);
    assert.equal(evaluateCalculation(calculation, `{"${key}":{"value":5}}`).status, 'unknown');
  }
  assert.equal(evaluateCalculation(calc(leaf(5), ['toString']), '{}').status, 'unknown');
});

test('path length, operation shape and depth are strictly bounded', () => {
  for (const path of [[], Array(13).fill('field'), [''], [' ']]) assert.equal(calculationSchema.safeParse(calc(leaf(5), path)).success, false);
  assert.equal(calculationSchema.safeParse({ ...calc(), extra: true }).success, false);
  assert.equal(calculationSchema.safeParse(calc({ op: 'pow', args: [leaf(2), leaf(3)] } as never)).success, false);
  assert.equal(calculationSchema.safeParse(calc({ op: 'add', args: [leaf(2), leaf(3), leaf(4)] } as never)).success, false);
  let expression = leaf(1);
  for (let level = 0; level < 5; level++) expression = op('add', expression, expression);
  const max = calc(expression);
  assert.equal(calculationSchema.safeParse(max).success, true);
  assert.equal(evaluateCalculation(max, '{"processingHoursPerDay":32}').status, 'satisfied');
  assert.equal(calculationSchema.safeParse(calc(op('add', expression, leaf(1)))).success, false);
  const cycle = { op: 'add', args: [] } as unknown as CalculationExpression;
  (cycle as { args: CalculationExpression[] }).args.push(cycle, leaf(1));
  assert.equal(calculationSchema.safeParse(calc(cycle)).success, false);
});

test('out-of-range values, divide by zero and intermediate overflow fail closed', () => {
  for (const value of [NaN, Infinity, -Infinity, 1e12 + 1, -1e12 - 1]) {
    assert.equal(calculationSchema.safeParse(calc(leaf(value))).success, false);
    assert.equal(evaluateCalculation(calc(leaf(value)), '{"processingHoursPerDay":5}').status, 'unknown');
  }
  for (const expression of [op('divide', leaf(600), leaf(0)), op('divide', leaf(600), leaf(-0)),
    op('multiply', leaf(1e12), leaf(2)), op('add', leaf(1e12), leaf(1)),
    op('divide', leaf(1), leaf(1e-300)), op('divide', op('multiply', leaf(1e12), leaf(2)), leaf(2))]) {
    assert.throws(() => validateCalculation(calc(expression), [{ id: 'input', text: 'Values 600 0 1000000000000 2 1 1e-300' }]));
    assert.equal(evaluateCalculation(calc(expression), '{"processingHoursPerDay":5}').status, 'unknown');
  }
  assert.equal(evaluateCalculation(calc(leaf(1e12)), '{"processingHoursPerDay":1000000000000}').status, 'satisfied');
  assert.equal(evaluateCalculation(calc(leaf(1)), '{"processingHoursPerDay":1000000000001}').status, 'unknown');
});

test('quotes are exact result excerpts, bounded independently of numeric evidence', () => {
  const short = ' \n{"processingHoursPerDay":5}\n ';
  const assessment = evaluateCalculation(calc(), short);
  assert.equal(assessment.status, 'satisfied');
  assert.ok(short.includes(assessment.outputQuote));
  const long = JSON.stringify({ processingHoursPerDay: 5, notes: 'a'.repeat(8_000) });
  assert.equal(evaluateCalculation(calc(), long).status, 'satisfied');
  assert.equal(evaluateCalculation(calc(), long).outputQuote, '');
  assert.equal(evaluateCalculation(calc(), 'a'.repeat(160_001)).status, 'unknown');
});

test('calculation contracts cannot contain executable expressions or tools', () => {
  for (const expression of ['600 / 120', { code: 'return 600 / 120' }, { tool: 'calculator', input: '600/120' }]) {
    assert.equal(calculationSchema.safeParse({ path: ['value'], expression }).success, false);
  }
  const source = readFileSync(new URL('./deliveryArithmetic.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:eval|Function|fetch|spawn)\s*\(/);
  assert.doesNotMatch(source, /node:(?:child_process|vm)|from ['"](?:https?|net)['"]/);
});
