/**
 * A fixed-capacity ring buffer. Pushing past capacity overwrites the oldest
 * item, so the structure never grows beyond `capacity` entries — this is the
 * in-memory bound that makes the whole extension safe to run forever.
 */
export class RingBuffer<T> {
  private items: T[];
  private head = 0; // index of the oldest item
  private count = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.items = new Array<T>(capacity);
  }

  /** Append an item, evicting the oldest when at capacity. Returns the evicted item, if any. */
  push(item: T): T | undefined {
    const evicted = this.count === this.capacity ? this.items[this.head] : undefined;
    const idx = (this.head + this.count) % this.capacity;
    this.items[idx] = item;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    return evicted;
  }

  get size(): number {
    return this.count;
  }

  /** All items in insertion order (oldest first). */
  toArray(): T[] {
    const out = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.items[(this.head + i) % this.capacity];
    }
    return out;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }
}
