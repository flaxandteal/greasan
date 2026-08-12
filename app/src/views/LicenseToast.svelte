<script lang="ts">
  import { onMount } from 'svelte';
  import { showLicenseToast, dismissLicenseToast, licenseFlowActive } from '../lib/store';
  import { t } from '../lib/i18n';

  let visible = $state(false);
  let dismissed = $state(false);
  // 'disclaimer' = the once-ever first-install notice, shown BEFORE the licensing
  // toast; 'license' = the per-session Open Data toast.
  let stage = $state<'disclaimer' | 'license'>('license');

  // A nav/deep-link redirect bumps `dismissLicenseToast` — hide the toast so it
  // doesn't overlap the target view. Skip the effect's initial (mount) run, and
  // never auto-hide the disclaimer (it must be acknowledged).
  let toastPrimed = false;
  $effect(() => {
    void $dismissLicenseToast;
    if (!toastPrimed) { toastPrimed = true; return; }
    if (visible && stage === 'license') dismiss();
  });

  const licenseWanted = () =>
    $showLicenseToast && !sessionStorage.getItem('ge:licenseSeen');

  export function show() {
    dismissed = false;
    // Manual re-open (from Settings) shows the licensing toast, not the disclaimer.
    stage = 'license';
    visible = true;
  }

  onMount(() => {
    const disclaimerPending =
      typeof localStorage !== 'undefined' && !localStorage.getItem('ge:disclaimerAcked');
    if (disclaimerPending) {
      stage = 'disclaimer';
      setTimeout(() => { visible = true; }, 600);
    } else if (licenseWanted()) {
      stage = 'license';
      setTimeout(() => { visible = true; }, 600);
    } else {
      // Nothing to show this launch — the toast flow is already complete.
      licenseFlowActive.set(false);
    }
  });

  // First-install disclaimer acknowledged → record it (persists across launches),
  // then hand off to the licensing toast, or close if licensing is off/seen.
  function ackDisclaimer() {
    try { localStorage.setItem('ge:disclaimerAcked', '1'); } catch { /* ignore */ }
    if (licenseWanted()) {
      stage = 'license';
    } else {
      dismiss();
    }
  }

  function dismiss() {
    visible = false;
    dismissed = true;
    sessionStorage.setItem('ge:licenseSeen', '1');
    // Toast flow finished — release the first-run tour gate.
    licenseFlowActive.set(false);
  }

  interface Props {
    onShowFull?: () => void;
  }

  let { onShowFull }: Props = $props();
</script>

{#if visible && !dismissed}
  <div class="toast-backdrop" onclick={stage === 'disclaimer' ? ackDisclaimer : dismiss} role="presentation">
    <div class="toast-card" onclick={(e) => e.stopPropagation()} role="dialog" aria-label={$t('toast.aria')}>
      <div class="toast-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 16v-4M12 8h.01"/>
        </svg>
      </div>
      <div class="toast-body">
        {#if stage === 'disclaimer'}
          <div class="toast-title">{$t('toast.disclaimerTitle')}</div>
          <div class="toast-text">{$t('toast.disclaimerBody')}</div>
          <div class="toast-actions">
            <button class="toast-dismiss" onclick={ackDisclaimer}>
              {$t('toast.disclaimerOk')}
            </button>
          </div>
        {:else}
          <div class="toast-title">{$t('toast.title')}</div>
          <div class="toast-text">
            {$t('toast.body')}
          </div>
          <div class="toast-actions">
            <button class="toast-link" onclick={() => { dismiss(); onShowFull?.(); }}>
              {$t('toast.details')}
            </button>
            <button class="toast-dismiss" onclick={dismiss}>
              {$t('toast.ok')}
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .toast-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 16px;
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    animation: fadeIn 0.3s ease;
  }

  .toast-card {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    background: var(--teal-deep);
    color: var(--cream);
    border-radius: 14px;
    padding: 14px 16px;
    max-width: 380px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.12);
    animation: slideUp 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .toast-icon {
    flex-shrink: 0;
    opacity: 0.7;
    margin-top: 2px;
  }

  .toast-body {
    flex: 1;
    min-width: 0;
  }

  .toast-title {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
    margin-bottom: 3px;
  }

  .toast-text {
    font-size: 13px;
    line-height: 1.4;
    opacity: 0.85;
  }

  .toast-text strong {
    font-weight: 600;
    opacity: 1;
  }

  .toast-actions {
    display: flex;
    gap: 12px;
    margin-top: 10px;
  }

  .toast-link {
    background: none;
    border: 1px solid rgba(246,244,235,0.3);
    border-radius: 6px;
    color: var(--cream);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    cursor: pointer;
    opacity: 0.9;
  }

  .toast-link:hover { opacity: 1; background: rgba(246,244,235,0.08); }

  .toast-dismiss {
    background: rgba(246,244,235,0.15);
    border: 0;
    border-radius: 6px;
    color: var(--cream);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 12px;
    cursor: pointer;
  }

  .toast-dismiss:hover { background: rgba(246,244,235,0.25); }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
</style>
