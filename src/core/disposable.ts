// Explicit, total teardown — replaces the reference's IDestroyable (architecture
// §4.1). Every owned resource exposes `dispose()`; the universal cleanup idiom is
// `someEvent.unsubscribeAll(this)` inside each dispose.
export interface Disposable {
  dispose(): void;
}
