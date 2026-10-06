/**
 * Resolves when `work` settles, or after `ms` if it has not by then: one step
 * that never finishes must not keep Vunemi from closing.
 */
export function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}
