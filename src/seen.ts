/** Bounded "have we already announced this?" set; evicts the oldest entry when full. */
export class SeenSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly capacity = 10_000) {}

  /** Adds `item`; returns `false` if it was already present. */
  add(item: T): boolean {
    if (this.items.has(item)) return false;
    this.items.add(item);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }
    return true;
  }
}
