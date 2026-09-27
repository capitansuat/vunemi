/** Decimal gigabytes, one decimal: the unit Hugging Face and Finder show. */
export function formatGB(bytes: number, locale: string): string {
  const n = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1e9);
  return `${n} GB`;
}

/** Whole minutes left, rounded up; null until there is a speed to go by. */
export function etaMinutes(remainingBytes: number, bytesPerSecond: number): number | null {
  if (bytesPerSecond <= 0) return null;
  return Math.ceil(remainingBytes / bytesPerSecond / 60);
}

/** Context lengths the setting offers, up to what each model was trained for. */
const CONTEXT_STEPS = [8192, 16384, 32768, 65536, 131072, 262144];

export function contextChoices(current: number, max: number): number[] {
  return [...new Set([...CONTEXT_STEPS.filter((n) => n <= max), current, max])].sort((a, b) => a - b);
}

/** Working buffers llama.cpp keeps besides the weights and the context; a round guess. */
const WORKING_BYTES = 512 * 1024 * 1024;

/**
 * Roughly what a model takes loaded with this context: weights, the context's
 * key/value cache, and working buffers. Null when the file didn't say how the
 * context grows.
 */
export function contextMemory(weights: number, kvBytesPerToken: number | undefined, context: number): number | null {
  if (!kvBytesPerToken) return null;
  return weights + kvBytesPerToken * context + WORKING_BYTES;
}

/** macOS lets the GPU use about three quarters of memory; more than that won't load or will swap. */
export function tooLarge(bytes: number, totalMemory: number): boolean {
  return bytes > totalMemory * 0.75;
}
