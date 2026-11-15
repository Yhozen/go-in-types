// Go maps: insertion-ordered (deleted keys removed; a re-inserted key goes
// to the end), iterable with a serialisable cursor (the sequence number of
// the last entry visited), see docs/DESIGN.md "Value model".

export interface Entry {
  k: any;
  v: any;
  seq: number;
  alive: boolean;
}

export class GoMap {
  idx = new Map<any, Entry>();
  es: Entry[] = [];
  dead = 0;
  nextSeq = 0;
  /** Bumped on compaction (iterators re-find their position). */
  ver = 0;
  t: number;
  keyOf: (k: any) => any;
  constructor(t: number, keyOf: (k: any) => any) {
    this.t = t;
    this.keyOf = keyOf;
  }

  get size(): number {
    return this.idx.size;
  }

  get(k: any): Entry | undefined {
    return this.idx.get(this.keyOf(k));
  }

  set(k: any, v: any): void {
    const c = this.keyOf(k);
    const e = this.idx.get(c);
    if (e) {
      e.v = v;
      return;
    }
    const n: Entry = { k, v, seq: this.nextSeq++, alive: true };
    this.idx.set(c, n);
    this.es.push(n);
  }

  delete(k: any): void {
    const c = this.keyOf(k);
    const e = this.idx.get(c);
    if (!e) return;
    e.alive = false;
    this.idx.delete(c);
    this.dead++;
    if (this.dead > 32 && this.dead * 2 > this.es.length) {
      this.es = this.es.filter((x) => x.alive);
      this.dead = 0;
      this.ver++;
    }
  }

  clear(): void {
    for (const e of this.es) e.alive = false;
    this.idx.clear();
    this.es = [];
    this.dead = 0;
    this.ver++;
  }

  /** Re-adds an entry while restoring a snapshot. */
  restore(k: any, v: any, seq: number): void {
    const n: Entry = { k, v, seq, alive: true };
    this.idx.set(this.keyOf(k), n);
    this.es.push(n);
  }
}

export class MapIter {
  pos = 0;
  ver: number;
  m: GoMap | null;
  seq: number;
  constructor(m: GoMap | null, seq = -1) {
    this.m = m;
    this.seq = seq;
    this.ver = m ? m.ver : 0;
    if (m && seq >= 0) this.ver = -1;
  }

  next(): Entry | null {
    const m = this.m;
    if (!m) return null;
    const es = m.es;
    if (this.ver !== m.ver) {
      // Binary search: first entry with seq > this.seq.
      let lo = 0;
      let hi = es.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (es[mid]!.seq <= this.seq) lo = mid + 1;
        else hi = mid;
      }
      this.pos = lo;
      this.ver = m.ver;
    }
    while (this.pos < es.length) {
      const e = es[this.pos++]!;
      if (e.alive) {
        this.seq = e.seq;
        return e;
      }
    }
    return null;
  }
}
