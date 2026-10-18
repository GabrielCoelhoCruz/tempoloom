export interface Interval {
  start: number;
  end: number;
}

/** A set of disjoint, sorted half-open time intervals [start, end). */
export class TimeSet {
  #items: Interval[];

  private constructor(items: Interval[]) {
    this.#items = items;
  }

  static empty(): TimeSet {
    return new TimeSet([]);
  }

  static from(intervals: Iterable<Interval>): TimeSet {
    const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
    const out: Interval[] = [];
    for (const i of sorted) {
      const last = out.at(-1);
      if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
      else out.push({ start: i.start, end: i.end });
    }
    return new TimeSet(out);
  }

  intervals(): readonly Interval[] {
    return this.#items;
  }

  clone(): TimeSet {
    return new TimeSet(this.#items.map((i) => ({ ...i })));
  }

  total(): number {
    let sum = 0;
    for (const i of this.#items) sum += i.end - i.start;
    return sum;
  }

  /** Index of the first interval whose end is after t. */
  #firstEndingAfter(t: number): number {
    let lo = 0;
    let hi = this.#items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.#items[mid] as Interval).end <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** True when [start, end) lies inside one interval of the set. */
  contains(range: Interval): boolean {
    const i = this.#items[this.#firstEndingAfter(range.start)];
    return i !== undefined && i.start <= range.start && i.end >= range.end;
  }

  overlaps(range: Interval): boolean {
    const i = this.#items[this.#firstEndingAfter(range.start)];
    return i !== undefined && i.start < range.end && range.end > range.start;
  }

  /** Removes a range from the set, in place. */
  subtract(range: Interval): void {
    if (range.end <= range.start) return;
    const idx = this.#firstEndingAfter(range.start);
    const replacement: Interval[] = [];
    let removeCount = 0;
    while (idx + removeCount < this.#items.length) {
      const i = this.#items[idx + removeCount] as Interval;
      if (i.start >= range.end) break;
      if (i.start < range.start) replacement.push({ start: i.start, end: range.start });
      if (i.end > range.end) replacement.push({ start: range.end, end: i.end });
      removeCount++;
    }
    if (removeCount > 0) this.#items.splice(idx, removeCount, ...replacement);
  }

  /** Time present in both sets. */
  intersect(other: TimeSet): TimeSet {
    const a = this.#items;
    const b = other.#items;
    const out: Interval[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const x = a[i] as Interval;
      const y = b[j] as Interval;
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
      if (x.end < y.end) i++;
      else j++;
    }
    return new TimeSet(out);
  }

  /** The part of the set inside [from, to). */
  clip(from: number, to: number): TimeSet {
    return this.intersect(new TimeSet(to > from ? [{ start: from, end: to }] : []));
  }

  /**
   * Start times, in order, where a block of `length` fits inside one interval.
   * Starts are multiples of `step` counted from the epoch, so they line up
   * with clock times such as :00, :15, :30 and :45.
   */
  *candidates(length: number, step: number): Generator<number> {
    for (const i of this.#items) {
      for (let t = Math.ceil(i.start / step) * step; t + length <= i.end; t += step) yield t;
    }
  }
}
