/**
 * In-process promise cache: concurrent requests for the same key share one computation, failures are not kept,
 * and the oldest entries are evicted once the total size passes the budget (the newest entry is always kept).
 */
export class PromiseCache<V> {
  readonly #entries = new Map<string, Promise<V>>();
  readonly #sizes = new Map<string, number>();
  readonly #budget: number;
  readonly #sizeOf: (value: V) => number;
  #total = 0;

  /** @param budget max total size; @param sizeOf size of one value (default 1, i.e. an entry count) */
  constructor(budget: number, sizeOf: (value: V) => number = () => 1) {
    this.#budget = budget;
    this.#sizeOf = sizeOf;
  }

  get(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.#entries.get(key);
    if (hit) return hit;
    const value = compute();
    this.#entries.set(key, value);
    value.then(
      (v) => {
        if (this.#entries.get(key) !== value) return; // evicted meanwhile
        const size = this.#sizeOf(v);
        this.#sizes.set(key, size);
        this.#total += size;
        for (const oldest of this.#entries.keys()) {
          if (this.#total <= this.#budget || this.#entries.size <= 1) break;
          this.#delete(oldest);
        }
      },
      () => this.#delete(key),
    );
    return value;
  }

  #delete(key: string) {
    this.#entries.delete(key);
    this.#total -= this.#sizes.get(key) ?? 0;
    this.#sizes.delete(key);
  }
}
