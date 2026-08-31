/**
 * Consume complete Server-Sent Events blocks from a growing buffer.
 * SSE permits either LF or CRLF line endings; the returned remainder is kept
 * until the next network chunk completes the block.
 */
export const consumeSseBlocks = (buffer: string, onBlock: (block: string) => void) => {
  let remaining = buffer;
  while (true) {
    const boundary = /\r?\n\r?\n/.exec(remaining);
    if (!boundary || boundary.index === undefined) return remaining;
    onBlock(remaining.slice(0, boundary.index));
    remaining = remaining.slice(boundary.index + boundary[0].length);
  }
};

