(function initializeTheme() {
  'use strict';

  var storageKey = 'shelter-theme';
  var theme = 'system';

  try {
    var storedTheme = window.localStorage.getItem(storageKey);
    if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') {
      theme = storedTheme;
    }
  } catch {
    // Storage can be unavailable in hardened or private browser contexts.
  }

  var prefersDark = false;
  try {
    prefersDark = Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    // A missing media-query implementation safely falls back to light mode.
  }

  var resolvedTheme = theme === 'dark' || (theme === 'system' && prefersDark) ? 'dark' : 'light';
  var root = document.documentElement;

  var locale = 'en';
  try {
    var storedLocale = window.localStorage.getItem('shelter.locale');
    if (storedLocale === 'en' || storedLocale === 'de') {
      locale = storedLocale;
    } else if ((window.navigator.languages || [window.navigator.language]).some(function (language) {
      return String(language || '').toLowerCase().indexOf('de') === 0;
    })) {
      locale = 'de';
    }
  } catch {
    // A blocked storage API safely falls back to English.
  }

  root.lang = locale;

  root.classList.remove('light', 'dark');
  root.classList.add(resolvedTheme);
  root.style.colorScheme = resolvedTheme;
  root.dataset.theme = theme;
  root.dataset.resolvedTheme = resolvedTheme;

  var themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute('content', resolvedTheme === 'dark' ? '#0a0a0a' : '#ffffff');
  }
})();
