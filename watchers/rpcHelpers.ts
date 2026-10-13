/** Resolves after `ms` milliseconds. Used to space out and back off RPC calls. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if an RPC error is a rate-limit response (HTTP 429, or Alchemy's -32016 code). */
export function isRateLimitError(err: unknown): boolean {
  const code = (err as { info?: { error?: { code?: number } } })?.info?.error?.code;
  return code === -32016 || code === 429;
}

/** Pulls the underlying JSON-RPC error message out of an ethers error, if present. */
export function extractErrorMessage(err: unknown): string {
  const rpcMessage = (err as { info?: { error?: { message?: string } } })?.info?.error?.message;
  return rpcMessage ?? (err instanceof Error ? err.message : String(err));
}

// Providers advertise their eth_getLogs range cap in different ways. Alchemy's free tier
// replies with the exact usable range, e.g. "...should work: [0x30fb946, 0x30fb94f]".
// Others (Infura, etc.) just state a number, e.g. "range is limited to 10000 blocks".
/** Extracts a provider's suggested max eth_getLogs block-range width from its error message. */
export function parseSuggestedRangeWidth(message: string): number | null {
  const bracketMatch = message.match(/\[0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+)\]/);
  if (bracketMatch) {
    return parseInt(bracketMatch[2], 16) - parseInt(bracketMatch[1], 16) + 1;
  }
  const numberMatch = message.match(/([\d,]+)\s*block/i);
  if (numberMatch) {
    return parseInt(numberMatch[1].replace(/,/g, ""), 10);
  }
  return null;
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
