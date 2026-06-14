// Recording-mock CanvasRenderingContext2D for headless tests (jsdom has no real
// canvas). Methods push a log entry; properties are plain settable fields. Tests
// assert backend BEHAVIOR against the log, not pixels. Named *.test.ts so the LOC
// gate excludes it (it is pure test scaffolding, imported by the other test files).
import { expect, test } from 'vitest';

export interface LogEntry {
  op: string;
  args: readonly unknown[];
}

export interface MockGradient {
  readonly _tag: 'gradient';
  readonly from: number;
  readonly to: number;
  readonly stops: { offset: number; color: string }[];
  addColorStop(offset: number, color: string): void;
}

export class MockContext {
  readonly log: LogEntry[] = [];

  // settable state properties (replay reads/writes them)
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  lineDashOffset = 0;
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  #dash: number[] = [];

  #rec(op: string, ...args: unknown[]): void {
    this.log.push({ op, args });
  }

  save(): void {
    this.#rec('save');
  }
  restore(): void {
    this.#rec('restore');
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#rec('setTransform', a, b, c, d, e, f);
  }
  resetTransform(): void {
    this.#rec('resetTransform');
  }
  beginPath(): void {
    this.#rec('beginPath');
  }
  closePath(): void {
    this.#rec('closePath');
  }
  moveTo(x: number, y: number): void {
    this.#rec('moveTo', x, y);
  }
  lineTo(x: number, y: number): void {
    this.#rec('lineTo', x, y);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.#rec('rect', x, y, w, h);
  }
  roundRect(x: number, y: number, w: number, h: number, r: number): void {
    this.#rec('roundRect', x, y, w, h, r);
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    this.#rec('arc', x, y, r, a0, a1);
  }
  fill(): void {
    this.#rec('fill', this.fillStyle);
  }
  stroke(): void {
    this.#rec('stroke', this.strokeStyle, this.lineWidth, this.lineDashOffset);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.#rec('fillRect', x, y, w, h, this.fillStyle, this.globalCompositeOperation);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.#rec('clearRect', x, y, w, h);
  }
  clip(): void {
    this.#rec('clip');
  }
  setLineDash(d: number[]): void {
    this.#dash = d.slice();
    this.#rec('setLineDash', d.slice());
  }
  getLineDash(): number[] {
    return this.#dash.slice();
  }
  fillText(text: string, x: number, y: number): void {
    this.#rec('fillText', text, x, y, this.font, this.fillStyle);
  }
  measureText(text: string): { width: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number } {
    this.#rec('measureText', text, this.font);
    return { width: text.length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
  }
  drawImage(...args: unknown[]): void {
    this.#rec('drawImage', ...args);
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): MockGradient {
    this.#rec('createLinearGradient', x0, y0, x1, y1);
    const g: MockGradient = {
      _tag: 'gradient',
      from: y0,
      to: y1,
      stops: [],
      addColorStop(offset: number, color: string): void {
        this.stops.push({ offset, color });
      },
    };
    return g;
  }

  ops(name: string): LogEntry[] {
    return this.log.filter((e) => e.op === name);
  }
}

// A mock <canvas> exposing width/height and getContext returning ONE shared
// MockContext (so a surface's pair of canvases each get a distinct one).
export class MockCanvas {
  width = 0;
  height = 0;
  readonly style: Record<string, string> = {};
  readonly ctx = new MockContext();
  getContext(_id: string, _opts?: unknown): MockContext {
    return this.ctx;
  }
}

test('mock context records ops and is settable', () => {
  const c = new MockContext();
  c.fillStyle = 'red';
  c.fillRect(1, 2, 3, 4);
  expect(c.ops('fillRect')[0].args).toEqual([1, 2, 3, 4, 'red', 'source-over']);
});
