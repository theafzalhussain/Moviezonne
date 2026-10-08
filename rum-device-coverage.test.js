/* Offline regression coverage for the actual RUM boot shipped in index.html.
 * Run: node rum-device-coverage.test.js
 * No browser, SDK download, network, or installed dependencies are used.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// Remove comments first: documentation contains literal script tag examples.
const scripts = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
  .map(match => match[1]).filter(source => source.includes('window.__mzRumProfile ='));
assert.equal(scripts.length, 1, 'must execute exactly one real RUM boot script');

function boot(nav = {}, hostname = 'moviezonne.example') {
  const inserted = [];
  const configs = [];
  const window = {};
  const document = {
    createElement(tag) { assert.equal(tag, 'script'); return {}; },
    getElementsByTagName(tag) {
      assert.equal(tag, 'script');
      return [{ parentNode: { insertBefore(script) { inserted.push(script); } } }];
    }
  };
  vm.runInNewContext(scripts[0], {
    window, document,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0', ...nav },
    location: { hostname }
  }, { timeout: 1000 });
  if (window.DD_RUM) {
    assert.equal(window.DD_RUM.q.length, 1, 'one queued init');
    window.DD_RUM.init = config => configs.push(config);
    window.DD_RUM.q.forEach(callback => callback());
  }
  return { profile: window.__mzRumProfile, inserted, configs };
}

const cohorts = [
  ['desktop', { deviceMemory: 8, hardwareConcurrency: 8 }, false],
  ['capable phone', { userAgent: 'Mozilla/5.0 Android Mobile', deviceMemory: 8, hardwareConcurrency: 8 }, false],
  ['threshold hardware', { deviceMemory: 4, hardwareConcurrency: 4 }, false],
  ['missing hardware hints', {}, false],
  ['zero hardware hints', { deviceMemory: 0, hardwareConcurrency: 0 }, false],
  ['low memory', { deviceMemory: 2, hardwareConcurrency: 8 }, true],
  ['low CPU', { deviceMemory: 8, hardwareConcurrency: 2 }, true],
  ['low CPU and memory', { deviceMemory: 1, hardwareConcurrency: 1 }, true],
  ...['SMART-TV Tizen', 'Android TV', 'CrKey', 'Roku', 'web0s', 'AFTMM', 'HbbTV', 'AppleTV'].map(ua =>
    [`TV ${ua}`, { userAgent: ua, deviceMemory: 8, hardwareConcurrency: 8 }, true])
];

for (const [name, nav, weak] of cohorts) {
  test(`${name}: resource coverage, unchanged replay/privacy/sampling`, () => {
    const { profile, inserted, configs } = boot(nav);
    assert.equal(profile.weakDevice, weak);
    assert.equal(profile.skipped, false);
    assert.equal(profile.trackResources, true);
    assert.equal(configs.length, 1);
    const config = configs[0];
    assert.equal(config.trackResources, true);
    assert.equal(config.sessionReplaySampleRate, weak ? 0 : 10);
    assert.equal(config.sessionSampleRate, 100);
    assert.equal(config.env, 'production');
    assert.equal(config.defaultPrivacyLevel, 'mask-user-input');
    assert.equal(config.trackLongTasks, true);
    assert.equal(config.trackUserInteractions, true);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].async, 1);
    assert.equal(inserted[0].src.split('/').pop(), weak ? 'datadog-rum-slim.js' : 'datadog-rum.js');
    // Resource events are not dropped, while existing error filtering stays active.
    assert.equal(config.beforeSend({ type: 'resource', resource: { type: 'fetch' } }), true);
    assert.equal(config.beforeSend({ type: 'error', error: { message: 'ResizeObserver loop completed with undelivered notifications' } }), false);
    assert.equal(config.beforeSend({ type: 'error', error: { message: 'TypeError: app crashed' } }), true);
  });
}

for (const host of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '192.168.1.2', '10.0.0.2', '172.16.0.2', '172.31.0.2']) {
  test(`${host}: local sampling remains disabled for capable and weak devices`, () => {
    for (const deviceMemory of [2, 8]) {
      const { configs } = boot({ deviceMemory, hardwareConcurrency: 8 }, host);
      assert.equal(configs[0].sessionSampleRate, 0);
      assert.equal(configs[0].env, 'development');
      assert.equal(configs[0].sessionReplaySampleRate, deviceMemory < 4 ? 0 : 10);
      assert.equal(configs[0].trackResources, true);
    }
  });
}

for (const userAgent of ['Googlebot', 'bingbot', 'DuckDuckBot', 'Twitterbot', 'UptimeRobot']) {
  test(`${userAgent}: crawler gate still skips loading and init`, () => {
    const { profile, inserted, configs } = boot({ userAgent, deviceMemory: 2 });
    assert.equal(profile.skipped, true);
    assert.equal(inserted.length, 0);
    assert.equal(configs.length, 0);
  });
}

for (const userAgent of ['Chrome-Lighthouse', 'Google Page Speed Insights']) {
  test(`${userAgent}: audits retain user-equivalent resource coverage`, () => {
    const { profile, configs } = boot({ userAgent, hardwareConcurrency: 2 });
    assert.equal(profile.skipped, false);
    assert.equal(configs.length, 1);
    assert.equal(configs[0].trackResources, true);
    assert.equal(configs[0].sessionReplaySampleRate, 0);
  });
}
