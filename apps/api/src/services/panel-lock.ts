/** Serialize async work per key so panel replace cannot race itself. */
export class KeyedAsyncLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(
      () => gate,
      () => gate,
    );
    this.tails.set(key, chained);
    await prev.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === chained) this.tails.delete(key);
    }
  }
}
