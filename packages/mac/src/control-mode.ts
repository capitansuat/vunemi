/** Explicit user intent; native background snapshots independently prohibit
 * foreground input even if a later continuation has only "continue" as goal. */
export const BACKGROUND_ONLY = /arka\s*plan|background|without\s+(?:changing|stealing)\s+(?:the\s+)?focus|odak\s*değiş(?:tirmeden|meden)/iu;
