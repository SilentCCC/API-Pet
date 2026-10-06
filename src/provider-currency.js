(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProviderCurrency = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const symbols = { USD: '$', CNY: '￥', RMB: '￥', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩', INR: '₹' };
  function normalizeCurrency(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (['$', '￥', '¥', '€', '£', '₩', '₹'].includes(text)) return text;
    const code = text.toUpperCase();
    if (symbols[code]) return symbols[code];
    return /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf('currency').includes(code) ? code : '';
  }
  function detectCurrency(...payloads) {
    for (const payload of payloads) {
      const containers = [payload, payload?.data, payload?.result, payload?.user, payload?.data?.user, payload?.billing];
      for (const value of containers) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const key of ['currency', 'currency_code', 'currencyCode', 'currency_symbol', 'currencySymbol', '_currencyHeader']) {
          const currency = normalizeCurrency(value[key]);
          if (currency) return currency;
        }
      }
    }
    return '';
  }
  function currencySettings(provider = {}) {
    // Older non-dollar choices were explicit user overrides; retain them.
    const currencyMode = provider.currencyMode === 'manual' || (!provider.currencyMode && provider.currency && provider.currency !== '$') ? 'manual' : 'auto';
    const detectedCurrency = normalizeCurrency(provider.detectedCurrency || provider.balance?.detectedCurrency);
    const currency = currencyMode === 'manual' ? String(provider.currency || '$').trim().slice(0, 16) : detectedCurrency || '$';
    return { currencyMode, currency, detectedCurrency, currencyDetection: provider.currencyDetection || 'pending' };
  }
  function balanceCurrency(provider, payloads, knownCurrency = '') {
    const settings = currencySettings(provider);
    const detectedCurrency = detectCurrency(...payloads) || normalizeCurrency(knownCurrency);
    return {
      currency: settings.currencyMode === 'manual' ? settings.currency : detectedCurrency || settings.detectedCurrency || '$',
      detectedCurrency: detectedCurrency || settings.detectedCurrency,
      currencyDetection: detectedCurrency ? 'detected' : 'failed'
    };
  }
  function rememberCurrency(provider, result) {
    if (Object.prototype.hasOwnProperty.call(result, 'detectedCurrency')) {
      provider.detectedCurrency = result.detectedCurrency;
      provider.currencyDetection = result.currencyDetection;
    }
    Object.assign(provider, currencySettings(provider));
  }
  function withCurrencyHeader(payload, response, envelope) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      Object.defineProperty(payload, '_currencyHeader', { value: response.headers?.get?.('x-currency') || detectCurrency(envelope), enumerable: false });
    }
    return payload;
  }
  return { normalizeCurrency, detectCurrency, currencySettings, balanceCurrency, rememberCurrency, withCurrencyHeader };
});
