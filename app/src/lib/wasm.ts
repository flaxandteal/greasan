import { wasmReady } from 'alizarin';
import '@alizarin/clm';
import { diagStart, diagEnd } from './diagnostics';

// With the combined ros-madair-alizarin binary, a single WASM module contains
// both alizarin (heritage viewer) and ros-madair (SPARQL engine).  The Vite
// combinedWasmPlugin redirects alizarin's internal WASM import to the combined
// binary, so alizarin's auto-init loads everything in one go.
//
// No separate ros-madair initWasm() call is needed - the combined binary's init
// initialises SparqlStore, connect_tile_source, and all alizarin WASM types
// from a single WebAssembly.instantiate.

let initialized = false;

export async function initAll(): Promise<void> {
  if (initialized) return;

  const did = diagStart('WASM binary init');
  try {
    await wasmReady;
    initialized = true;
    diagEnd(did);
    console.log('[wasm] initialized (combined ros-madair-alizarin binary)');
  } catch (err) {
    diagEnd(did);
    console.error('[wasm] initialization failed:', err);
    throw err;
  }
}

export const ready: Promise<void> = initAll();
