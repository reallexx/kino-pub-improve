const DEFAULT_MAIN_HOST = 'kino.watch';

const STORAGE_KEYS = {
  mainHost: 'kino-pub-improve-main-host',
  mirrorHosts: 'kino-pub-improve-mirror-hosts',
  backgroundFlag: 'kino-pub-improve-background-flag',
  manualFlag: 'kino-pub-improve-manual-flag',
  hideWatchedFlag: 'kino-pub-improve-hide-watched-flag',
  cache: 'kino-pub-improve-cache',
  runtimeSettings: 'kino-pub-improve-runtime-settings',
};

const DEFAULT_RUNTIME_SETTINGS = {
  unwatchedTtlHours: 12,
  scanBatchSize: 5,
  syncDelayMs: 450,
  myshowsRpcDelayMs: 300,
};

function readBooleanStorageValue(value, defaultValue = false) {
  if (value === true || value === 'true') {
    return true;
  }

  if (value === false || value === 'false') {
    return false;
  }

  return defaultValue;
}

function normalizeRuntimeSettings(rawSettings) {
  const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};

  const unwatchedTtlHours = Number(source.unwatchedTtlHours);
  const scanBatchSize = Number(source.scanBatchSize);
  const syncDelayMs = Number(source.syncDelayMs);
  const myshowsRpcDelayMs = Number(source.myshowsRpcDelayMs);

  return {
    unwatchedTtlHours:
      Number.isFinite(unwatchedTtlHours) && unwatchedTtlHours >= 1
        ? Math.min(Math.round(unwatchedTtlHours), 168)
        : DEFAULT_RUNTIME_SETTINGS.unwatchedTtlHours,
    scanBatchSize:
      Number.isFinite(scanBatchSize) && scanBatchSize >= 1
        ? Math.min(Math.round(scanBatchSize), 20)
        : DEFAULT_RUNTIME_SETTINGS.scanBatchSize,
    syncDelayMs:
      Number.isFinite(syncDelayMs) && syncDelayMs >= 0
        ? Math.min(Math.round(syncDelayMs), 5000)
        : DEFAULT_RUNTIME_SETTINGS.syncDelayMs,
    myshowsRpcDelayMs:
      Number.isFinite(myshowsRpcDelayMs) && myshowsRpcDelayMs >= 0
        ? Math.min(Math.round(myshowsRpcDelayMs), 5000)
        : DEFAULT_RUNTIME_SETTINGS.myshowsRpcDelayMs,
  };
}

async function getRuntimeSettings() {
  const storageItems = await chrome.storage.sync.get(STORAGE_KEYS.runtimeSettings);
  return normalizeRuntimeSettings(storageItems[STORAGE_KEYS.runtimeSettings]);
}

async function saveRuntimeSettings(rawSettings) {
  const normalizedSettings = normalizeRuntimeSettings(rawSettings);
  await chrome.storage.sync.set({
    [STORAGE_KEYS.runtimeSettings]: normalizedSettings,
  });
  return normalizedSettings;
}

const CONTENT_SCRIPT_ID = 'kino-pub-improve-content';

/**
 * Нормализует ввод пользователя до hostname без схемы и пути.
 * Примеры: "https://kino.watch/path" -> "kino.watch"
 */
function normalizeHost(rawValue) {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const trimmedValue = rawValue.trim().toLowerCase();
  if (!trimmedValue) {
    return null;
  }

  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedValue);
    const url = new URL(hasScheme ? trimmedValue : `https://${trimmedValue}`);
    const hostname = url.hostname.replace(/\.$/, '');

    if (!hostname || hostname.includes(' ') || !hostname.includes('.')) {
      return null;
    }

    return hostname;
  } catch (error) {
    return null;
  }
}

function hostToMatchPattern(hostname) {
  return `*://${hostname}/*`;
}

function isUrlMatchingHosts(pageUrl, hosts) {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    return hosts.some((host) => host === hostname);
  } catch (error) {
    return false;
  }
}

const EXCLUDED_SCAN_PATH_PREFIXES = ['/watchlist'];

function isScanAllowedOnUrl(pageUrl) {
  try {
    const resolvedPageUrl =
      pageUrl ||
      (typeof location !== 'undefined' && location.href ? location.href : '');
    const pathname = new URL(resolvedPageUrl).pathname.toLowerCase();
    return !EXCLUDED_SCAN_PATH_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
  } catch (error) {
    return false;
  }
}

async function getHostSettings() {
  const storageItems = await chrome.storage.sync.get([
    STORAGE_KEYS.mainHost,
    STORAGE_KEYS.mirrorHosts,
  ]);

  const mainHost = normalizeHost(storageItems[STORAGE_KEYS.mainHost]) || DEFAULT_MAIN_HOST;
  const rawMirrors = storageItems[STORAGE_KEYS.mirrorHosts];
  const mirrorHosts = Array.isArray(rawMirrors)
    ? [...new Set(rawMirrors.map(normalizeHost).filter(Boolean))].filter(
        (host) => host !== mainHost
      )
    : [];

  return {
    mainHost,
    mirrorHosts,
    allHosts: [mainHost, ...mirrorHosts],
  };
}

async function saveHostSettings(mainHostInput, mirrorHostsInput) {
  const mainHost = normalizeHost(mainHostInput) || DEFAULT_MAIN_HOST;
  const mirrorHosts = [...new Set((mirrorHostsInput || []).map(normalizeHost).filter(Boolean))]
    .filter((host) => host !== mainHost);

  await chrome.storage.sync.set({
    [STORAGE_KEYS.mainHost]: mainHost,
    [STORAGE_KEYS.mirrorHosts]: mirrorHosts,
  });

  return {
    mainHost,
    mirrorHosts,
    allHosts: [mainHost, ...mirrorHosts],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_MAIN_HOST,
    DEFAULT_RUNTIME_SETTINGS,
    STORAGE_KEYS,
    CONTENT_SCRIPT_ID,
    EXCLUDED_SCAN_PATH_PREFIXES,
    normalizeHost,
    hostToMatchPattern,
    isUrlMatchingHosts,
    isScanAllowedOnUrl,
    readBooleanStorageValue,
    normalizeRuntimeSettings,
    getRuntimeSettings,
    saveRuntimeSettings,
    getHostSettings,
    saveHostSettings,
  };
}
