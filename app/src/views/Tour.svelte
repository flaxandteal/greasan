<script lang="ts">
  // First-run guided tour overlay. A dimming scrim (so the live screen behind
  // stays visible) plus a bottom coach-card; navigation is driven by tour.ts,
  // which rides the app's existing store-based routing.
  import { tourActive, tourStep, TOUR_STEPS, nextStep, prevStep, endTour } from '../lib/tour';
  import { t } from '../lib/i18n';

  const total = TOUR_STEPS.length;
  let step = $derived(TOUR_STEPS[$tourStep]);
  let isLast = $derived($tourStep === total - 1);
  let isFirst = $derived($tourStep === 0);
</script>

{#if $tourActive}
  <div class="tour-root" role="dialog" aria-modal="true" aria-label={$t('tour.welcome.title')}>
    <!-- Scrim: tap advances, matching the coach-card feel; the card owns real controls. -->
    <button class="tour-scrim" aria-hidden="true" tabindex="-1" onclick={() => nextStep()}></button>

    <div class="tour-card">
      <div class="tour-top">
        <span class="tour-icon" aria-hidden="true">{step.icon}</span>
        <button class="tour-skip" onclick={() => endTour()}>{$t('tour.skip')}</button>
      </div>

      <h2 class="tour-title">{$t('tour.' + step.key + '.title')}</h2>
      <p class="tour-body">{$t('tour.' + step.key + '.body')}</p>

      <div class="tour-dots" aria-hidden="true">
        {#each TOUR_STEPS as _, i}
          <span class="tour-dot" class:active={i === $tourStep}></span>
        {/each}
      </div>

      <div class="tour-actions">
        <button class="tour-btn ghost" disabled={isFirst} onclick={() => prevStep()}>
          {$t('tour.back')}
        </button>
        <span class="tour-count">{$t('tour.progress', { n: $tourStep + 1, total })}</span>
        <button class="tour-btn primary" onclick={() => nextStep()}>
          {isLast ? $t('tour.finish') : $t('tour.next')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tour-root {
    position: fixed;
    inset: 0;
    z-index: 9500;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }

  .tour-scrim {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    margin: 0;
    background: rgba(0, 0, 0, 0.45);
    cursor: pointer;
  }

  .tour-card {
    position: relative;
    z-index: 1;
    margin: 0 auto;
    width: 100%;
    max-width: 460px;
    background: var(--bg, #fff);
    color: var(--fg-default, var(--fg, #111));
    border-top-left-radius: 18px;
    border-top-right-radius: 18px;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.28);
    padding: 16px 20px calc(16px + env(safe-area-inset-bottom, 0px));
    animation: tour-rise 0.28s ease;
  }

  @keyframes tour-rise {
    from { transform: translateY(24px); opacity: 0.4; }
    to   { transform: translateY(0);    opacity: 1; }
  }

  .tour-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .tour-icon { font-size: 30px; line-height: 1; }

  .tour-skip {
    background: none;
    border: 0;
    padding: 4px;
    font-size: var(--fs-small, 13px);
    color: var(--fg-soft, #888);
    cursor: pointer;
  }

  .tour-title {
    margin: 2px 0 6px;
    font-size: var(--fs-large, 20px);
    font-weight: 700;
    color: var(--teal-deep, var(--fg-default, #111));
  }

  .tour-body {
    margin: 0;
    font-size: var(--fs-body, 15px);
    line-height: 1.5;
    color: var(--fg-default, #333);
  }

  .tour-dots {
    display: flex;
    gap: 6px;
    justify-content: center;
    margin: 16px 0 12px;
  }

  .tour-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fg-soft, #ccc);
    opacity: 0.4;
    transition: opacity 0.2s, transform 0.2s;
  }

  .tour-dot.active {
    opacity: 1;
    transform: scale(1.25);
    background: var(--teal-deep, var(--accent, #3b6));
  }

  .tour-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .tour-count {
    font-size: var(--fs-micro, 11px);
    color: var(--fg-soft, #999);
    white-space: nowrap;
  }

  .tour-btn {
    border: 0;
    border-radius: 10px;
    padding: 10px 18px;
    font-size: var(--fs-body, 15px);
    font-weight: 600;
    cursor: pointer;
  }

  .tour-btn.ghost {
    background: none;
    color: var(--fg-soft, #888);
  }

  .tour-btn.ghost:disabled {
    opacity: 0;
    pointer-events: none;
  }

  .tour-btn.primary {
    background: var(--teal-deep, var(--accent, #2a6b5e));
    color: var(--cream, #fff);
  }
</style>
