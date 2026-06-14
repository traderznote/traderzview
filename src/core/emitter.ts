// The library-wide multicast event emitter (architecture §4.1). The reference's
// Delegate semantics are kept (snapshot-iterate; single-shot pre-removed;
// owner-keyed bulk unsubscribe) with two deliberate changes flagged in §13:
//   - a throwing listener does NOT truncate dispatch; its error is routed to
//     reportError (the reference silently stopped the round — study 01 §4.1);
//   - the modern `Unsubscribe` return + options-bag subscribe idiom.
import type { Disposable } from './disposable';
import { reportError } from './report-error';

export type Unsubscribe = () => void;

export interface ISubscription<A extends unknown[] = []> {
  subscribe(cb: (...args: A) => void, opts?: { owner?: object; once?: boolean }): Unsubscribe;
  unsubscribeAll(owner: object): void;
}

interface Listener<A extends unknown[]> {
  cb: (...args: A) => void;
  owner: object | undefined;
  once: boolean;
}

export class Emitter<A extends unknown[] = []> implements ISubscription<A>, Disposable {
  #listeners: Listener<A>[] = [];

  subscribe(cb: (...args: A) => void, opts?: { owner?: object; once?: boolean }): Unsubscribe {
    const listener: Listener<A> = { cb, owner: opts?.owner, once: opts?.once === true };
    this.#listeners.push(listener);
    return () => {
      const i = this.#listeners.indexOf(listener);
      if (i !== -1) this.#listeners.splice(i, 1);
    };
  }

  unsubscribeAll(owner: object): void {
    this.#listeners = this.#listeners.filter((l) => l.owner !== owner);
  }

  fire(...args: A): void {
    // Iterate a snapshot: listeners added during dispatch run next round, not now.
    const snapshot = this.#listeners.slice();
    // Single-shot listeners are removed BEFORE dispatch, so they run exactly once
    // even if an earlier listener throws.
    if (snapshot.some((l) => l.once)) {
      this.#listeners = this.#listeners.filter((l) => !l.once);
    }
    for (const l of snapshot) {
      try {
        l.cb(...args);
      } catch (error) {
        reportError(error);
      }
    }
  }

  /** Fire only when there are listeners, building the payload lazily (§4.1). */
  fireLazy(build: () => A): void {
    if (this.#listeners.length > 0) this.fire(...build());
  }

  hasListeners(): boolean {
    return this.#listeners.length > 0;
  }

  dispose(): void {
    this.#listeners = [];
  }
}
