const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHost,
  hostToMatchPattern,
  isUrlMatchingHosts,
  isScanAllowedOnUrl,
  normalizeRuntimeSettings,
  readBooleanStorageValue,
  DEFAULT_RUNTIME_SETTINGS,
} = require('../lib/hosts.js');

describe('normalizeHost', () => {
  it('нормализует URL и hostname', () => {
    assert.equal(normalizeHost('https://Kino.Watch/path'), 'kino.watch');
    assert.equal(normalizeHost('kino.pub'), 'kino.pub');
    assert.equal(normalizeHost(''), null);
    assert.equal(normalizeHost('localhost'), null);
  });
});

describe('host helpers', () => {
  it('строит match pattern и проверяет URL', () => {
    assert.equal(hostToMatchPattern('kino.watch'), '*://kino.watch/*');
    assert.equal(
      isUrlMatchingHosts('https://kino.watch/movie', ['kino.watch', 'kino.pub']),
      true
    );
    assert.equal(isUrlMatchingHosts('https://example.com', ['kino.watch']), false);
  });

  it('исключает watchlist из скана', () => {
    assert.equal(isScanAllowedOnUrl('https://kino.watch/movie'), true);
    assert.equal(isScanAllowedOnUrl('https://kino.watch/watchlist'), false);
    assert.equal(isScanAllowedOnUrl('https://kino.watch/watchlist/user'), false);
  });
});

describe('runtime settings / booleans', () => {
  it('читает legacy string booleans', () => {
    assert.equal(readBooleanStorageValue('true', false), true);
    assert.equal(readBooleanStorageValue(false, true), false);
    assert.equal(readBooleanStorageValue(undefined, true), true);
  });

  it('нормализует runtime-настройки', () => {
    assert.deepEqual(normalizeRuntimeSettings({}), DEFAULT_RUNTIME_SETTINGS);
    assert.equal(normalizeRuntimeSettings({ scanBatchSize: 100 }).scanBatchSize, 20);
    assert.equal(normalizeRuntimeSettings({ unwatchedTtlHours: 0 }).unwatchedTtlHours, 12);
  });
});
