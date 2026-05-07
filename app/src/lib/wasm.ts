import { initWasm as initAlizarin, setWasmURL as setAlizarinWasmURL } from 'alizarin';
import { initWasm as initRosMadair, setWasmURL as setRosMadairWasmURL } from 'ros-madair';
import '@alizarin/clm';

let initialized = false;

export async function initAll(): Promise<void> {
  if (initialized) return;

  try {
    await Promise.all([
      initAlizarin(),
      initRosMadair(),
    ]);
    initialized = true;
    console.log('[wasm] alizarin + ros-madair initialized');
  } catch (err) {
    console.error('[wasm] initialization failed:', err);
    throw err;
  }
}

export const ready: Promise<void> = initAll();
