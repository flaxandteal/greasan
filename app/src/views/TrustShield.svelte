<script lang="ts">
  import type { LayerTrust } from '../lib/v2';

  // A layer's attestation trust as a coloured shield: green = verified (a valid
  // signature over the current content), yellow = unverified (unsigned, e.g. an
  // old or third-party layer), red = tampered (altered since signed, or an
  // invalid signature). `reason` (when present) is the tooltip.
  let { status, reason = '' }: { status: LayerTrust; reason?: string } = $props();

  const COLOR: Record<LayerTrust, string> = {
    verified: '#2e7d52',
    unverified: '#c08a00',
    tampered: '#c0392b',
  };
  const LABEL: Record<LayerTrust, string> = {
    verified: 'Verified',
    unverified: 'Unverified (unsigned)',
    tampered: 'Tampered',
  };
</script>

<span
  class="trust-shield"
  style="color:{COLOR[status]}"
  title={reason || LABEL[status]}
  aria-label={reason || LABEL[status]}
  role="img"
>
  <svg width="15" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 2 L20 5 V11 C20 16.5 16.4 20.5 12 22 C7.6 20.5 4 16.5 4 11 V5 Z"
      fill="currentColor"
    />
    {#if status === 'verified'}
      <!-- check -->
      <path
        d="M8.5 11.8 L11 14.3 L15.6 8.8"
        fill="none"
        stroke="#fff"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else if status === 'tampered'}
      <!-- cross -->
      <path
        d="M9 9 L15 15 M15 9 L9 15"
        fill="none"
        stroke="#fff"
        stroke-width="2"
        stroke-linecap="round"
      />
    {:else}
      <!-- exclamation (unsigned / unknown) -->
      <path d="M12 7.5 V13" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" />
      <circle cx="12" cy="16" r="1.15" fill="#fff" />
    {/if}
  </svg>
</span>

<style>
  .trust-shield {
    display: inline-flex;
    align-items: center;
    line-height: 0;
    vertical-align: middle;
  }
</style>
