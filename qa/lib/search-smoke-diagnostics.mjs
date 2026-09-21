export const redactSearchDiagnostic = (value, limit = 3_000) => String(value ?? '')
  .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
  .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[redacted-key]')
  .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
  .replace(/("?(?:api[_-]?key|access[_-]?token|secret)"?\s*[:=]\s*")[^"]*(")/gi, '$1[redacted]$2')
  .slice(0, limit);

export const searchExchangeDiagnostic = (label, httpStatus, exchange) => {
  const completion = exchange.complete ?? {};
  const safeCompletion = Object.fromEntries(['route', 'agentRole', 'model', 'fallbackDisabled', 'searchCalls']
    .filter((key) => typeof completion[key] === 'string' || typeof completion[key] === 'boolean' || typeof completion[key] === 'number')
    .map((key) => [key, typeof completion[key] === 'string' ? redactSearchDiagnostic(completion[key], 200) : completion[key]]));
  return {
    label, httpStatus,
    completion: safeCompletion,
    statuses: exchange.statuses.slice(-12).map((value) => redactSearchDiagnostic(value, 300)),
    answerCharacters: exchange.text.length,
    answerExcerpt: redactSearchDiagnostic(exchange.text),
    // A citation or mention is content, not proof of an outbound provider call.
    mentionedSourceNames: ['Open-Meteo', 'Bing', 'DuckDuckGo'].filter((name) => exchange.text.toLowerCase().includes(name.toLowerCase())),
    evidenceBasis: 'gateway-route-metadata-and-answer-contract; upstream destinations are not instrumented here',
  };
};
