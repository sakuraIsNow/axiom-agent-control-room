const conversationEnvelope = /(?:^|\n\n)USER:\s*([\s\S]*?)(?=\n\n(?:ASSISTANT|USER):|$)/gi;

export const latestUserInput = (input?: string) => {
  if (!input) return '';
  const turns = [...input.matchAll(conversationEnvelope)];
  const latest = turns.at(-1)?.[1]?.trim();
  return (latest || input).replace(/^(?:USER:\s*)+/i, '').trim();
};

export const compactStoredUserMessage = (input: string) => (
  /\n\n(?:USER|ASSISTANT):/i.test(input) || /^(?:USER:\s*){2,}/i.test(input)
    ? latestUserInput(input)
    : input
);
