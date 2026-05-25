<script lang="ts">
  import { overlayView } from '../lib/store';
  import { t } from '../lib/i18n';

  function close() {
    overlayView.set(null);
  }
</script>

<div class="ge-page" style="padding-bottom:0;">
  <div style="background:var(--teal-deep);color:var(--cream);padding:0 0 18px;position:relative;">
    <div class="ge-navbar" style="background:transparent;border-bottom:0;color:var(--cream);">
      <div class="ge-navbar-side">
        <button class="ge-back" style="color:var(--cream);" onclick={close}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          {$t('nav.back')}
        </button>
      </div>
      <div class="ge-navbar-title" style="color:rgba(246,244,235,0.65);font-size:13px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;">{$t('faq.title')}</div>
      <div class="ge-navbar-side right"></div>
    </div>

    <div style="padding:4px 18px 0;">
      <div class="ge-headword display" style="color:var(--cream);font-size:48px;">{$t('search.title')}</div>
      <div class="ge-hero-rule"></div>
    </div>
  </div>

  <div class="faq-content">
    <section class="faq-section">
      <h2 class="ge-block-title">{$t('faq.whatIsThis')}</h2>
      <p class="faq-body">{$t('faq.whatIsThisBody')}</p>
    </section>

    <section class="faq-section">
      <h2 class="ge-block-title">{$t('faq.howItWorks')}</h2>
      <p class="faq-body">{$t('faq.howItWorksBody')}</p>
    </section>

    <section class="faq-section">
      <h2 class="ge-block-title">{$t('faq.features')}</h2>
      <ul class="faq-list">
        <li>{$t('faq.featureStars')}</li>
        <li>{$t('faq.featureRecent')}</li>
        <li>{$t('faq.featureLayers')}</li>
      </ul>
    </section>

    <section class="faq-section">
      <h2 class="ge-block-title">{$t('faq.licensing')}</h2>
      <p class="faq-body">{$t('faq.licensingBody')}</p>
    </section>

    <section class="faq-section" style="padding-bottom:32px;">
      <h2 class="ge-block-title">{$t('faq.openSource')}</h2>
      <p class="faq-body">{$t('faq.openSourceBody')}</p>
    </section>
  </div>
</div>

<style>
  .faq-content {
    padding: 0 16px;
  }

  .faq-section {
    margin-bottom: 4px;
  }

  .faq-body {
    font-size: var(--fs-body);
    line-height: 1.55;
    color: var(--fg-default);
    margin: 0;
    padding: 0 0 0 2px;
  }

  .faq-list {
    font-size: var(--fs-body);
    line-height: 1.55;
    color: var(--fg-default);
    margin: 0;
    padding: 0 0 0 20px;
    list-style: disc;
  }

  .faq-list li {
    margin-bottom: 6px;
  }
</style>
