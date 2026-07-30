import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface BuildLayerResult {
  layer_id: string;
  output_path: string;
}

export interface BuildLayerStatus {
  state: string;
  progress: number;
  error: string | null;
  output_path: string | null;
}

export interface LayerInfo {
  layer_id: string;
  output_path: string;
  has_pagefind: boolean;
}

export async function buildLayer(opts: {
  sourceUrl: string;
  format: string;
  layerName: string;
}): Promise<BuildLayerResult> {
  return invoke('build_layer', {
    sourceUrl: opts.sourceUrl,
    format: opts.format,
    layerName: opts.layerName,
  });
}

export async function getLayerStatus(layerId: string): Promise<BuildLayerStatus> {
  return invoke('get_layer_status', { layerId });
}

export async function listLayers(): Promise<LayerInfo[]> {
  return invoke('list_layers');
}

/** List locally-built v2 layers (a `head.sqlite` present) for restore on startup. */
export async function listV2Layers(): Promise<LayerInfo[]> {
  return invoke('list_v2_layers');
}

/** Check if a named index directory exists on-device. Returns the path or null. */
export async function checkLocalIndex(name: string): Promise<string | null> {
  return invoke('check_local_index', { name });
}

/** Poll getLayerStatus until terminal state. Returns the final status. */
export async function waitForBuild(
  layerId: string,
  onProgress?: (status: BuildLayerStatus) => void,
  intervalMs = 500,
): Promise<BuildLayerStatus> {
  while (true) {
    const status = await getLayerStatus(layerId);
    onProgress?.(status);
    if (status.state === 'complete' || status.state === 'failed') {
      return status;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/** Remove a layer's files from disk. */
export async function removeLayerFiles(layerName: string): Promise<void> {
  return invoke('remove_layer_files', { layerName });
}

/** Check if a specific layer has pagefind indices. */
export async function layerHasPagefind(layerName: string): Promise<boolean> {
  return invoke('layer_has_pagefind', { layerName });
}

/** Convert a native file path to a webview-loadable asset URL. */
export function assetUrl(filePath: string): string {
  return convertFileSrc(filePath, 'asset');
}
