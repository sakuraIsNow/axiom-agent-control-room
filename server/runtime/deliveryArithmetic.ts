import { z } from 'zod';

const MAX_MAGNITUDE = 1e12;
const MAX_DEPTH = 6;
const MAX_NODES = 63;
const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
const boundedNumber = z.number().finite().min(-MAX_MAGNITUDE).max(MAX_MAGNITUDE);
const nonBlank = (max: number) => z.string().min(1).max(max).refine((value) => Boolean(value.trim()));

export type CalculationSource = { id: string; text: string };
export type CalculationExpression = { sourceId: string; sourceQuote: string; value: number }
  | { op: 'add' | 'subtract' | 'multiply' | 'divide'; args: [CalculationExpression, CalculationExpression] };
export type DeliveryCalculation = { path: string[]; expression: CalculationExpression };
export type CalculationEvaluation = {
  status: 'satisfied' | 'unsatisfied' | 'unknown';
  expected: number | null;
  actual: number | null;
  reason: string;
  outputQuote: string;
};

export class DeliveryCalculationError extends Error {
  readonly code = 'DELIVERY_CALCULATION_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryCalculationError';
  }
}

const leafSchema = z.object({ sourceId: nonBlank(250), sourceQuote: nonBlank(4_000), value: boundedNumber }).strict();
// Construct a bounded schema, so deeply nested or cyclic input never reaches an unbounded recursive parser.
const expressionSchema = (depth: number): z.ZodType<CalculationExpression> => {
  if (depth === MAX_DEPTH) return leafSchema;
  const child = expressionSchema(depth + 1);
  return z.union([leafSchema, z.object({
    op: z.enum(['add', 'subtract', 'multiply', 'divide']),
    args: z.tuple([child, child]),
  }).strict()]);
};

export const calculationSchema: z.ZodType<DeliveryCalculation> = z.object({
  path: z.array(nonBlank(250).refine((key) => !blockedKeys.has(key), 'Prototype keys are not permitted.')).min(1).max(12),
  expression: expressionSchema(1),
}).strict();

type NumberToken = { start: number; end: number; value: number };
const numberTokens = (text: string): NumberToken[] => {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/g)) {
    const start = match.index;
    const end = start + match[0].length;
    // Do not turn a decimal, exponent, signed number or identifier fragment into a new source value.
    if (/[A-Za-z0-9_.+-]/.test(text[start - 1] ?? '') || /[A-Za-z0-9_+-]/.test(text[end] ?? '')
      || text[end] === '.' && /[.\d]/.test(text[end + 1] ?? '')
      || text[start - 1] === ',' && /\d/.test(text[start - 2] ?? '')
      || text[end] === ',' && /\d/.test(text[end + 1] ?? '')) continue;
    const value = Number(match[0]);
    if (Number.isFinite(value)) tokens.push({ start, end, value });
  }
  return tokens;
};

const compute = (expression: CalculationExpression): number => {
  let nodes = 0;
  const visit = (item: CalculationExpression, depth: number): number => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new DeliveryCalculationError('Calculation exceeds its complexity limit.');
    let value: number;
    if ('value' in item) value = item.value;
    else {
      const left = visit(item.args[0], depth + 1);
      const right = visit(item.args[1], depth + 1);
      switch (item.op) {
        case 'add': value = left + right; break;
        case 'subtract': value = left - right; break;
        case 'multiply': value = left * right; break;
        case 'divide':
          if (right === 0) throw new DeliveryCalculationError('Division by zero cannot be verified.');
          value = left / right;
          break;
      }
    }
    if (!Number.isFinite(value) || Math.abs(value) > MAX_MAGNITUDE) {
      throw new DeliveryCalculationError('Calculation contains an out-of-range value or intermediate result.');
    }
    return value;
  };
  return visit(expression, 1);
};

export const validateCalculation = (calculation: DeliveryCalculation, sources: readonly CalculationSource[]): void => {
  const parsed = calculationSchema.parse(calculation);
  if (!sources.length || sources.some((source) => !source.id.trim() || !source.text.trim())
    || new Set(sources.map((source) => source.id)).size !== sources.length
    || sources.reduce((total, source) => total + source.text.length, 0) > 48_000) {
    throw new DeliveryCalculationError('Calculation sources must be complete, bounded and uniquely identified.');
  }
  const sourceMap = new Map(sources.map((source) => [source.id,
    { text: source.text, tokens: new Map(numberTokens(source.text).map((token) => [token.start, token])) }]));
  const visit = (item: CalculationExpression): void => {
    if ('args' in item) {
      item.args.forEach(visit);
      return;
    }
    const source = sourceMap.get(item.sourceId);
    if (!source || !source.text.includes(item.sourceQuote)) {
      throw new DeliveryCalculationError('A calculation operand has no exact source quote.');
    }
    const candidates = numberTokens(item.sourceQuote).filter((token) => token.value === item.value);
    let grounded = false;
    let offset = source.text.indexOf(item.sourceQuote);
    while (!grounded && offset !== -1) {
      grounded = candidates.some((candidate) => {
        const token = source.tokens.get(offset + candidate.start);
        return token?.end === offset + candidate.end && token.value === item.value;
      });
      offset = source.text.indexOf(item.sourceQuote, offset + 1);
    }
    if (!grounded) throw new DeliveryCalculationError('A calculation operand must be a complete numeric token in its quoted source.');
  };
  visit(parsed.expression);
  compute(parsed.expression);
};

export const evaluateCalculation = (calculation: DeliveryCalculation, result: string): CalculationEvaluation => {
  let expected: number | null = null;
  let outputQuote = '';
  const unknown = (reason: string): CalculationEvaluation => ({ status: 'unknown', expected, actual: null, reason, outputQuote });
  try {
    const parsed = calculationSchema.parse(calculation);
    expected = compute(parsed.expression);
    if (result.length > 160_000 || !result.trim()) return unknown('The delivery is empty or exceeds the structured calculation limit.');
    const trimmed = result.trim();
    const fenced = /^```json[ \t]*\r?\n([\s\S]*)\r?\n```$/i.exec(trimmed);
    const json = fenced ? fenced[1]! : trimmed;
    let actual: unknown;
    try { actual = JSON.parse(json) as unknown; }
    catch { return unknown('A calculation requires one complete JSON result or one JSON code fence.'); }
    outputQuote = json.length <= 8_000 ? json : '';
    for (const key of parsed.path) {
      if (actual === null || typeof actual !== 'object' || blockedKeys.has(key) || !Object.hasOwn(actual, key)) {
        return unknown('The calculation output path is missing or inaccessible.');
      }
      actual = (actual as Record<string, unknown>)[key];
    }
    if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual) > MAX_MAGNITUDE) {
      return unknown('The calculation output must be a finite number within the supported range.');
    }
    const satisfied = Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
    return { status: satisfied ? 'satisfied' : 'unsatisfied', expected, actual, outputQuote,
      reason: satisfied ? `Independent calculation matches: expected ${expected}, received ${actual}.`
        : `Independent calculation mismatch: expected ${expected}, received ${actual}.` };
  } catch (error) {
    return unknown(error instanceof DeliveryCalculationError ? error.message : 'The calculation contract is invalid.');
  }
};
