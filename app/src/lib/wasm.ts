import { wasmReady } from 'alizarin';
import '@alizarin/clm';
import { diagStart, diagEnd } from './diagnostics';

// alizarin loads its own WASM (alizarin_bg.wasm) via its auto-init. The v1
// combined ros-madair-alizarin binary (which bundled the ros-madair SPARQL/tile
// engine alongside alizarin) is retired - the v2 read path is native (v2.rs /
// dictionary-v2), so all we need here is alizarin's viewer WASM.

let initialized = false;

export async function initAll(): Promise<void> {
  if (initialized) return;

  const did = diagStart('WASM binary init');
  try {
    await wasmReady;
    initialized = true;
    diagEnd(did);
    console.log('[wasm] initialized (alizarin viewer WASM)');
  } catch (err) {
    diagEnd(did);
    console.error('[wasm] initialization failed:', err);
    throw err;
  }
}

export const ready: Promise<void> = initAll();
