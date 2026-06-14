// Browser-side conformance driver (design 03 §9). Bundled to an IIFE by run.mjs and
// evaluated in a Playwright Chromium page. Renders one fixture through the REAL
// canvasBackend() (real bindings, real bitmap discovery) and returns the base-layer
// canvas as a PNG data URL for snapshot comparison. Exposed on window for the runner.
import { canvasBackend } from '../../src/backend-canvas';
import { fixtures, type Fixture } from './fixtures';

declare global {
  interface Window {
    __tvConformance: {
      fixtureNames(): string[];
      render(name: string): Promise<{ width: number; height: number; dataUrl: string }>;
    };
  }
}

function byName(name: string): Fixture {
  const f = fixtures.find((x) => x.name === name);
  if (!f) throw new Error(`unknown fixture ${name}`);
  return f;
}

async function render(name: string): Promise<{ width: number; height: number; dataUrl: string }> {
  const fixture = byName(name);
  const backend = canvasBackend();
  const mount = document.createElement('div');
  mount.style.position = 'absolute';
  mount.style.left = '0';
  mount.style.top = '0';
  mount.style.width = `${fixture.mediaSize.width}px`;
  mount.style.height = `${fixture.mediaSize.height}px`;
  document.body.appendChild(mount);

  const surface = backend.createSurface(mount);
  surface.setMediaSize(fixture.mediaSize);
  // Let the bitmap-discovery observer (RO device-pixel-content-box or matchMedia)
  // settle, then apply + render inside a 'full' frame.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  surface.beginFrame('full');
  surface.renderLayer('base', fixture.base);
  surface.renderLayer('overlay', []);
  surface.endFrame();

  // Read the base canvas (z-index 1) back as PNG.
  const base = mount.querySelector('canvas') as HTMLCanvasElement;
  const dataUrl = base.toDataURL('image/png');
  surface.dispose();
  mount.remove();
  backend.dispose();
  return { width: base.width, height: base.height, dataUrl };
}

window.__tvConformance = {
  fixtureNames: () => fixtures.map((f) => f.name),
  render,
};
