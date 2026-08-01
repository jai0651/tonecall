/**
 * Shared OpenAI client. Lazy so the rest of the app boots in stub mode
 * without an API key. We instantiate once and reuse.
 */

import OpenAI from 'openai';

let cached: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY missing while USE_STUBS=false');
  }
  cached = new OpenAI({ apiKey });
  return cached;
}
