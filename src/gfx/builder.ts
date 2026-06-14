// DisplayListBuilder (design 03 §3.3) — the only sanctioned way to construct lists.
// Geometry is written into pooled, growable Float32Array/Uint8Array buffers reused
// frame-to-frame; finish() returns transient views over them (valid until the next
// reset). Consecutive equal fills fold into runs by reference-then-value compare.
import { assert } from '../core';
import type {
  DisplayList,
  DrawCommand,
  FillStyle,
  ImageHandle,
  LineStyle,
  Rect,
  Space,
  StrokeSpec,
  StyleRun,
  TextItem,
} from './commands';

interface MutRun {
  count: number;
  fill: FillStyle;
}

type OpenKind = 'rects' | 'polyline' | 'area' | 'circles' | 'path' | null;

export interface RectsWriter {
  quad(x: number, y: number, w: number, h: number, fill: FillStyle): void;
}
export interface PolylineWriter {
  vertex(x: number, y: number, fill: FillStyle): void;
  gap(): void;
}
export interface AreaWriter {
  vertex(x: number, y: number): void;
}
export interface CirclesWriter {
  circle(x: number, y: number, r: number, fill: FillStyle): void;
}
export interface PathWriter {
  move(x: number, y: number): void;
  line(x: number, y: number): void;
  close(): void;
}

export class DisplayListBuilder {
  #geom = new Float32Array(256);
  #geomLen = 0;
  #verbs = new Uint8Array(64);
  #verbLen = 0;

  #lists: DisplayList[] = [];
  #listOpen = false;
  #space: Space = 'media';
  #clip: Rect | undefined;
  #commands: DrawCommand[] = [];

  #openKind: OpenKind = null;
  #start = 0;
  #verbStart = 0;
  #count = 0;
  #runs: MutRun[] = [];
  #lastFill: FillStyle | undefined;
  #radius: number | undefined;
  #stroke: StrokeSpec | undefined;
  #fill: FillStyle | undefined;
  #width = 1;
  #style: LineStyle = 0 as LineStyle;
  #join: 'round' | 'miter' = 'miter';
  #baseY = 0;

  /** Clear for the next frame; pooled buffers are retained (no allocation). */
  reset(): void {
    this.#geomLen = 0;
    this.#verbLen = 0;
    this.#lists = [];
    this.#commands = [];
    this.#listOpen = false;
    this.#openKind = null;
  }

  beginList(space: Space, clip?: Rect): void {
    this.#closeList();
    this.#space = space;
    this.#clip = clip;
    this.#commands = [];
    this.#listOpen = true;
  }

  rects(opts: { radius?: number; stroke?: StrokeSpec }): RectsWriter {
    this.#beginCommand('rects');
    this.#radius = opts.radius;
    this.#stroke = opts.stroke;
    if (__DEV__ && this.#radius !== undefined) assert(this.#radius >= 0, 'rects radius must be ≥ 0');
    return {
      quad: (x, y, w, h, fill) => {
        if (__DEV__) {
          assert(
            !Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(w) && !Number.isNaN(h),
            'rects coords must not be NaN (gaps are polyline/area only)',
          );
          assert(w >= 0 && h >= 0, 'rects w/h must be ≥ 0');
        }
        this.#ensureGeom(4);
        const g = this.#geom;
        const o = this.#geomLen;
        g[o] = x;
        g[o + 1] = y;
        g[o + 2] = w;
        g[o + 3] = h;
        this.#geomLen += 4;
        this.#count++;
        this.#addRun(fill);
      },
    };
  }

  polyline(width: number, style: LineStyle, join: 'round' | 'miter'): PolylineWriter {
    this.#beginCommand('polyline');
    this.#width = width;
    this.#style = style;
    this.#join = join;
    return {
      vertex: (x, y, fill) => {
        this.#ensureGeom(2);
        const g = this.#geom;
        const o = this.#geomLen;
        g[o] = x;
        g[o + 1] = y;
        this.#geomLen += 2;
        this.#count++;
        this.#addRun(fill);
      },
      gap: () => {
        this.#ensureGeom(2);
        const g = this.#geom;
        const o = this.#geomLen;
        g[o] = Number.NaN;
        g[o + 1] = Number.NaN;
        this.#geomLen += 2;
        this.#count++;
        // a gap inherits the current run (no fill change)
        if (this.#runs.length > 0) this.#runs[this.#runs.length - 1]!.count++;
        else this.#runs.push({ count: 1, fill: '' });
      },
    };
  }

  area(baseY: number, fill: FillStyle): AreaWriter {
    this.#beginCommand('area');
    this.#baseY = baseY;
    this.#fill = fill;
    return {
      vertex: (x, y) => {
        this.#ensureGeom(2);
        const g = this.#geom;
        const o = this.#geomLen;
        g[o] = x;
        g[o + 1] = y;
        this.#geomLen += 2;
      },
    };
  }

  circles(stroke?: StrokeSpec): CirclesWriter {
    this.#beginCommand('circles');
    this.#stroke = stroke;
    return {
      circle: (x, y, r, fill) => {
        if (__DEV__) {
          assert(!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(r), 'circles coords must not be NaN');
          assert(r >= 0, 'circle radius must be ≥ 0');
        }
        this.#ensureGeom(3);
        const g = this.#geom;
        const o = this.#geomLen;
        g[o] = x;
        g[o + 1] = y;
        g[o + 2] = r;
        this.#geomLen += 3;
        this.#count++;
        this.#addRun(fill);
      },
    };
  }

  path(fill?: FillStyle, stroke?: StrokeSpec): PathWriter {
    this.#beginCommand('path');
    this.#fill = fill;
    this.#stroke = stroke;
    const push = (verb: number, x: number, y: number, withPoint: boolean): void => {
      this.#ensureVerbs(1);
      this.#verbs[this.#verbLen++] = verb;
      if (withPoint) {
        this.#ensureGeom(2);
        const g = this.#geom;
        const o = this.#geomLen;
        g[o] = x;
        g[o + 1] = y;
        this.#geomLen += 2;
      }
    };
    return {
      move: (x, y) => push(0, x, y, true),
      line: (x, y) => push(1, x, y, true),
      close: () => push(2, 0, 0, false),
    };
  }

  text(items: readonly TextItem[]): void {
    this.#closeCommand();
    if (__DEV__) assert(this.#space === 'media', 'text commands are legal only in media-space lists');
    this.#commands.push({ kind: 'text', items });
  }

  image(image: ImageHandle, src: Rect, dst: Rect, alpha?: number): void {
    this.#closeCommand();
    this.#commands.push({ kind: 'image', image, src, dst, alpha });
  }

  finish(): readonly DisplayList[] {
    this.#closeList();
    return this.#lists;
  }

  // --- internals -----------------------------------------------------------

  #ensureGeom(extra: number): void {
    const need = this.#geomLen + extra;
    if (need <= this.#geom.length) return;
    let cap = this.#geom.length;
    while (cap < need) cap *= 2;
    const bigger = new Float32Array(cap);
    bigger.set(this.#geom.subarray(0, this.#geomLen));
    this.#geom = bigger;
  }

  #ensureVerbs(extra: number): void {
    const need = this.#verbLen + extra;
    if (need <= this.#verbs.length) return;
    let cap = this.#verbs.length;
    while (cap < need) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(this.#verbs.subarray(0, this.#verbLen));
    this.#verbs = bigger;
  }

  #addRun(fill: FillStyle): void {
    const n = this.#runs.length;
    if (n > 0 && this.#lastFill === fill) {
      this.#runs[n - 1]!.count++;
    } else {
      this.#runs.push({ count: 1, fill });
      this.#lastFill = fill;
    }
  }

  #beginCommand(kind: Exclude<OpenKind, null>): void {
    if (__DEV__) assert(this.#listOpen, 'beginList must be called before emitting commands');
    this.#closeCommand();
    this.#openKind = kind;
    this.#start = this.#geomLen;
    this.#verbStart = this.#verbLen;
    this.#count = 0;
    this.#runs = [];
    this.#lastFill = undefined;
    this.#radius = undefined;
    this.#stroke = undefined;
    this.#fill = undefined;
  }

  #closeCommand(): void {
    const kind = this.#openKind;
    if (kind === null) return;
    this.#openKind = null;
    const coords = this.#geom.subarray(this.#start, this.#geomLen);
    const runs = this.#runs as readonly StyleRun[];
    if (kind === 'rects') {
      if (__DEV__) this.#assertRunSum(this.#count);
      this.#commands.push({ kind: 'rects', coords, runs, radius: this.#radius, stroke: this.#stroke });
    } else if (kind === 'polyline') {
      if (__DEV__) this.#assertRunSum(this.#count);
      this.#commands.push({ kind: 'polyline', points: coords, runs, width: this.#width, style: this.#style, join: this.#join });
    } else if (kind === 'area') {
      this.#commands.push({ kind: 'area', points: coords, baseY: this.#baseY, fill: this.#fill ?? '' });
    } else if (kind === 'circles') {
      if (__DEV__) this.#assertRunSum(this.#count);
      this.#commands.push({ kind: 'circles', coords, runs, stroke: this.#stroke });
    } else {
      const verbs = this.#verbs.subarray(this.#verbStart, this.#verbLen);
      this.#commands.push({ kind: 'path', verbs, points: coords, fill: this.#fill, stroke: this.#stroke });
    }
  }

  #assertRunSum(elements: number): void {
    let sum = 0;
    for (const r of this.#runs) sum += r.count;
    assert(sum === elements, `run counts (${sum}) must equal element count (${elements})`);
  }

  #closeList(): void {
    this.#closeCommand();
    if (this.#listOpen) {
      this.#lists.push({ space: this.#space, clip: this.#clip, commands: this.#commands });
      this.#listOpen = false;
    }
  }
}
