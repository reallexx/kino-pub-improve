(() => {
  if (window.__kinoPubImproveInitialized) {
    window.__kinoPubImproveRequestScan?.();
    return;
  }

  window.__kinoPubImproveInitialized = true;

  const ITEM_SELECTORS = ['.item-poster', '.item-media', '.util-item'];
  const ITEM_LINK_SELECTOR = 'a[href*="/item/view/"]';
  const SCAN_DEBOUNCE_MS = 350;
  const PROCESSED_ATTRIBUTE = 'data-kpi-processed';
  const CACHE_STORAGE_KEY = STORAGE_KEYS.cache;
  const MANUAL_FLAG_KEY = STORAGE_KEYS.manualFlag;
  const BACKGROUND_FLAG_KEY = STORAGE_KEYS.backgroundFlag;
  const HIDE_WATCHED_FLAG_KEY = STORAGE_KEYS.hideWatchedFlag;
  const HIDDEN_CLASS = 'kpi-hidden-watched';
  const CACHE_VERSION = 2;
  const MAX_WATCHED_CACHE_ENTRIES = 8000;
  const SCAN_PROGRESS_KEY = 'kino-pub-improve-scan-progress';
  const FETCH_MAX_ATTEMPTS = 3;
  // Периодически перепроверяем «просмотрено», чтобы не залипать после снятия отметки на сайте.
  const WATCHED_POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  let scanTimerId = null;
  let isScanRunning = false;
  let isScanQueued = false;
  let watchedCache = null;
  let hideWatchedEnabled = false;
  let scanBatchSize = DEFAULT_RUNTIME_SETTINGS.scanBatchSize;
  let unwatchedNegativeTtlMs =
    DEFAULT_RUNTIME_SETTINGS.unwatchedTtlHours * 60 * 60 * 1000;

  async function refreshRuntimeScanSettings() {
    const runtimeSettings = await getRuntimeSettings();
    scanBatchSize = runtimeSettings.scanBatchSize;
    unwatchedNegativeTtlMs = runtimeSettings.unwatchedTtlHours * 60 * 60 * 1000;
  }

  function extractItemId(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.origin);
      const match = url.pathname.match(/\/item\/view\/(\d+)/i);
      return match?.[1] || null;
    } catch (error) {
      return null;
    }
  }

  function normalizeItemUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.origin);
      const itemId = extractItemId(url.href);
      if (!itemId) {
        return null;
      }

      return `${url.origin}/item/view/${itemId}`;
    } catch (error) {
      return null;
    }
  }

  function getItemAnchor(itemElement) {
    if (!(itemElement instanceof Element)) {
      return null;
    }

    if (itemElement.matches(ITEM_LINK_SELECTOR)) {
      return itemElement;
    }

    return (
      itemElement.querySelector(`:scope > ${ITEM_LINK_SELECTOR}`) ||
      itemElement.querySelector(ITEM_LINK_SELECTOR) ||
      null
    );
  }

  function collectItemEntries(rootNode = document) {
    const searchRoot = rootNode instanceof Element || rootNode === document
      ? rootNode
      : document;
    const itemElements = searchRoot.querySelectorAll
      ? searchRoot.querySelectorAll(ITEM_SELECTORS.join(','))
      : [];

    const entries = [];
    const seenItemIds = new Set();

    for (const itemElement of itemElements) {
      const anchorElement = getItemAnchor(itemElement);
      const itemId = extractItemId(anchorElement?.href);
      const normalizedUrl = normalizeItemUrl(anchorElement?.href);

      if (!itemId || !normalizedUrl || seenItemIds.has(itemId)) {
        continue;
      }

      seenItemIds.add(itemId);
      entries.push({
        itemElement,
        anchorElement,
        href: normalizedUrl,
        itemId,
        alreadyMarkedBySite: Boolean(
          anchorElement.classList.contains('darken') ||
            anchorElement.classList.contains('darken-mini')
        ),
      });
    }

    return entries;
  }

  function getListCardContainer(entry) {
    const itemElement = entry.itemElement;

    if (itemElement.classList.contains('util-item')) {
      return itemElement;
    }

    if (
      itemElement.classList.contains('item-poster') ||
      itemElement.classList.contains('item-media')
    ) {
      return (
        itemElement.closest('[class*="col-"]') ||
        itemElement.parentElement ||
        itemElement
      );
    }

    return itemElement;
  }

  function applyHideStateToEntry(entry) {
    const cardContainer = getListCardContainer(entry);
    if (!cardContainer) {
      return;
    }

    const isWatched =
      entry.itemElement.getAttribute(PROCESSED_ATTRIBUTE) === 'watched' ||
      entry.alreadyMarkedBySite ||
      entry.anchorElement?.classList.contains('darken') ||
      entry.anchorElement?.classList.contains('darken-mini') ||
      entry.anchorElement?.classList.contains('kpi-watched');

    if (hideWatchedEnabled && isWatched) {
      cardContainer.classList.add(HIDDEN_CLASS);
    } else {
      cardContainer.classList.remove(HIDDEN_CLASS);
    }
  }

  function refreshHiddenWatchedCards() {
    const allEntries = collectItemEntries(document);

    for (const entry of allEntries) {
      applyHideStateToEntry(entry);
    }

    if (!hideWatchedEnabled) {
      document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((element) => {
        element.classList.remove(HIDDEN_CLASS);
      });
    }
  }

  function markElementAsWatched(entry) {
    const targets = [entry.itemElement, entry.anchorElement].filter(Boolean);
    const isPosterCard =
      entry.itemElement.classList.contains('item-poster') ||
      Boolean(entry.itemElement.closest('.item-poster'));

    for (const target of targets) {
      target.classList.add('kpi-watched');
      target.classList.add(isPosterCard ? 'darken' : 'darken-mini');
    }

    entry.itemElement.setAttribute(PROCESSED_ATTRIBUTE, 'watched');
    entry.itemElement.classList.remove('kpi-watched-processing');
    entry.alreadyMarkedBySite = true;
    applyHideStateToEntry(entry);
  }

  function markElementAsUnwatched(entry) {
    entry.itemElement.setAttribute(PROCESSED_ATTRIBUTE, 'unwatched');
    entry.itemElement.classList.remove('kpi-watched-processing');
    applyHideStateToEntry(entry);
  }

  function markElementAsFailed(entry) {
    entry.itemElement.setAttribute(PROCESSED_ATTRIBUTE, 'failed');
    entry.itemElement.classList.remove('kpi-watched-processing');
  }

  function setProcessingState(entry, isProcessing) {
    entry.itemElement.classList.toggle('kpi-watched-processing', isProcessing);
  }

  function sleep(delayMs) {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  async function publishScanProgress(progress) {
    try {
      await chrome.storage.local.set({
        [SCAN_PROGRESS_KEY]: {
          ...progress,
          updatedAt: Date.now(),
        },
      });
    } catch (error) {
      // storage может быть недоступен — прогресс не критичен.
    }
  }

  async function fetchItemHtmlWithRetry(itemUrl) {
    let lastErrorMessage = '';

    for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(itemUrl, {
          credentials: 'include',
          cache: 'no-cache',
        });

        if (response.status === 429 || response.status === 503) {
          lastErrorMessage = `HTTP ${response.status}`;
          await sleep(400 * attempt);
          continue;
        }

        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            htmlText: null,
            errorMessage: `HTTP ${response.status}`,
          };
        }

        return {
          ok: true,
          status: response.status,
          htmlText: await readResponseTextForWatchedProbe(response),
          errorMessage: '',
        };
      } catch (error) {
        lastErrorMessage = error?.message || 'network error';
        await sleep(300 * attempt);
      }
    }

    return {
      ok: false,
      status: 0,
      htmlText: null,
      errorMessage: lastErrorMessage || 'fetch failed',
    };
  }

  function createEmptyCacheStore() {
    return {
      version: CACHE_VERSION,
      watched: {},
      unwatched: {},
    };
  }

  function normalizeLegacyCache(rawCache) {
    const cacheStore = createEmptyCacheStore();
    if (!rawCache || typeof rawCache !== 'object') {
      return cacheStore;
    }

    if (rawCache.version === CACHE_VERSION && rawCache.watched && rawCache.unwatched) {
      cacheStore.watched = { ...rawCache.watched };
      cacheStore.unwatched = { ...rawCache.unwatched };
      return cacheStore;
    }

    const now = Date.now();
    for (const [cacheKey, cacheValue] of Object.entries(rawCache)) {
      if (cacheKey === 'version' || cacheKey === 'watched' || cacheKey === 'unwatched') {
        continue;
      }

      const itemIdMatch = String(cacheKey).match(/(\d{3,})/);
      const itemId = itemIdMatch?.[1];
      if (!itemId) {
        continue;
      }

      if (cacheValue === true) {
        cacheStore.watched[itemId] = now;
      }
    }

    return cacheStore;
  }

  function pruneCacheStore(cacheStore) {
    const now = Date.now();

    for (const [itemId, checkedAt] of Object.entries(cacheStore.unwatched)) {
      if (!checkedAt || now - checkedAt > unwatchedNegativeTtlMs) {
        delete cacheStore.unwatched[itemId];
      }
    }

    const watchedEntries = Object.entries(cacheStore.watched);
    if (watchedEntries.length <= MAX_WATCHED_CACHE_ENTRIES) {
      return cacheStore;
    }

    watchedEntries.sort((leftEntry, rightEntry) => leftEntry[1] - rightEntry[1]);
    const removeCount = watchedEntries.length - MAX_WATCHED_CACHE_ENTRIES;
    for (let index = 0; index < removeCount; index += 1) {
      delete cacheStore.watched[watchedEntries[index][0]];
    }

    return cacheStore;
  }

  async function loadWatchedCache() {
    if (watchedCache) {
      return watchedCache;
    }

    const storage = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    watchedCache = pruneCacheStore(normalizeLegacyCache(storage[CACHE_STORAGE_KEY]));
    return watchedCache;
  }

  async function persistWatchedCache() {
    if (!watchedCache) {
      return;
    }

    pruneCacheStore(watchedCache);
    await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: watchedCache });
  }

  function getCacheWatchState(cacheStore, itemId) {
    const watchedCheckedAt = cacheStore.watched[itemId];
    if (watchedCheckedAt) {
      if (Date.now() - watchedCheckedAt <= WATCHED_POSITIVE_TTL_MS) {
        return 'watched';
      }

      return 'unknown';
    }

    const unwatchedCheckedAt = cacheStore.unwatched[itemId];
    if (unwatchedCheckedAt && Date.now() - unwatchedCheckedAt <= unwatchedNegativeTtlMs) {
      return 'unwatched';
    }

    return 'unknown';
  }

  function rememberWatched(cacheStore, itemId) {
    const now = Date.now();
    cacheStore.watched[itemId] = now;
    delete cacheStore.unwatched[itemId];
  }

  function rememberUnwatched(cacheStore, itemId) {
    cacheStore.unwatched[itemId] = Date.now();
    delete cacheStore.watched[itemId];
  }

  async function processInBatches(entries, progressState) {
    const cacheStore = await loadWatchedCache();
    let cacheDirty = false;

    for (let index = 0; index < entries.length; index += scanBatchSize) {
      const batch = entries.slice(index, index + scanBatchSize);

      await Promise.all(
        batch.map(async (entry) => {
          try {
            const cachedState = getCacheWatchState(cacheStore, entry.itemId);

            if (entry.alreadyMarkedBySite || cachedState === 'watched') {
              markElementAsWatched(entry);

              if (!cacheStore.watched[entry.itemId]) {
                rememberWatched(cacheStore, entry.itemId);
                cacheDirty = true;
              }

              progressState.watched += 1;
              return;
            }

            if (cachedState === 'unwatched') {
              markElementAsUnwatched(entry);
              progressState.unwatched += 1;
              return;
            }

            setProcessingState(entry, true);

            const fetchResult = await fetchItemHtmlWithRetry(entry.href);

            if (!fetchResult.ok) {
              markElementAsFailed(entry);
              progressState.failed += 1;
              console.warn(
                `KinoPub Improve: не удалось загрузить ${entry.href}: ${fetchResult.errorMessage}`
              );
              return;
            }

            const isWatched = htmlIndicatesWatched(fetchResult.htmlText);

            if (isWatched) {
              rememberWatched(cacheStore, entry.itemId);
              markElementAsWatched(entry);
              progressState.watched += 1;
            } else {
              rememberUnwatched(cacheStore, entry.itemId);
              markElementAsUnwatched(entry);
              progressState.unwatched += 1;
            }

            cacheDirty = true;
          } catch (error) {
            markElementAsFailed(entry);
            progressState.failed += 1;
            console.error(`KinoPub Improve: ошибка обработки ${entry.href}`, error);
          } finally {
            setProcessingState(entry, false);
            progressState.processed += 1;
            await publishScanProgress({
              status: 'running',
              processed: progressState.processed,
              total: progressState.total,
              watched: progressState.watched,
              unwatched: progressState.unwatched,
              failed: progressState.failed,
            });
          }
        })
      );
    }

    if (cacheDirty) {
      await persistWatchedCache();
    }
  }

  async function markWatched(rootNode = document) {
    const allEntries = collectItemEntries(rootNode);
    const pendingEntries = allEntries.filter((entry) => {
      const processedState = entry.itemElement.getAttribute(PROCESSED_ATTRIBUTE);
      return (
        processedState !== 'watched' &&
        processedState !== 'unwatched' &&
        processedState !== 'failed'
      );
    });

    const progressState = {
      total: pendingEntries.length,
      processed: 0,
      watched: 0,
      unwatched: 0,
      failed: 0,
    };

    if (pendingEntries.length === 0) {
      await publishScanProgress({
        status: 'done',
        processed: 0,
        total: 0,
        watched: 0,
        unwatched: 0,
        failed: 0,
      });
      return progressState;
    }

    await publishScanProgress({
      status: 'running',
      processed: 0,
      total: progressState.total,
      watched: 0,
      unwatched: 0,
      failed: 0,
    });

    await processInBatches(pendingEntries, progressState);

    await publishScanProgress({
      status: 'done',
      processed: progressState.processed,
      total: progressState.total,
      watched: progressState.watched,
      unwatched: progressState.unwatched,
      failed: progressState.failed,
    });

    return progressState;
  }

  async function runScan(rootNode = document) {
    if (!isScanAllowedOnUrl()) {
      return { ok: true, skipped: true, reason: 'excluded-path' };
    }

    if (isScanRunning) {
      isScanQueued = true;
      return { ok: true, queued: true };
    }

    isScanRunning = true;

    try {
      await refreshRuntimeScanSettings();
      const progressState = await markWatched(rootNode);
      refreshHiddenWatchedCards();
      return {
        ok: true,
        processed: progressState?.processed || 0,
        total: progressState?.total || 0,
        watched: progressState?.watched || 0,
        unwatched: progressState?.unwatched || 0,
        failed: progressState?.failed || 0,
      };
    } finally {
      isScanRunning = false;

      if (isScanQueued) {
        isScanQueued = false;
        scheduleScan();
      }
    }
  }

  function scheduleScan() {
    if (!isScanAllowedOnUrl()) {
      return;
    }

    if (scanTimerId) {
      clearTimeout(scanTimerId);
    }

    scanTimerId = setTimeout(() => {
      scanTimerId = null;
      runScan(document);
    }, SCAN_DEBOUNCE_MS);
  }

  function nodeMayContainItems(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    if (ITEM_SELECTORS.some((selector) => node.matches(selector))) {
      return true;
    }

    return ITEM_SELECTORS.some((selector) => Boolean(node.querySelector(selector)));
  }

  function startMutationObserver() {
    const mutationObserver = new MutationObserver((mutations) => {
      const shouldScan = mutations.some((mutation) => {
        if (mutation.type !== 'childList') {
          return false;
        }

        return Array.from(mutation.addedNodes).some(nodeMayContainItems);
      });

      if (shouldScan) {
        scheduleScan();
      }
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function startPjaxListeners() {
    const pjaxEventNames = [
      'pjax:end',
      'pjax:success',
      'pjax:complete',
      'turbo:load',
    ];

    for (const eventName of pjaxEventNames) {
      document.addEventListener(eventName, () => scheduleScan(), true);
    }

    const bindJqueryPjax = () => {
      if (!window.jQuery?.fn?.on) {
        return false;
      }

      window.jQuery(document).on('pjax:end pjax:success pjax:complete', () => {
        scheduleScan();
      });
      return true;
    };

    if (!bindJqueryPjax()) {
      const jqueryWaitTimerId = setInterval(() => {
        if (bindJqueryPjax()) {
          clearInterval(jqueryWaitTimerId);
        }
      }, 300);

      setTimeout(() => clearInterval(jqueryWaitTimerId), 15000);
    }
  }

  async function shouldRunAutomatically() {
    const storageItems = await chrome.storage.sync.get([
      MANUAL_FLAG_KEY,
      BACKGROUND_FLAG_KEY,
    ]);

    const manualFlag = readBooleanStorageValue(storageItems[MANUAL_FLAG_KEY], false);
    const backgroundFlag = storageItems[BACKGROUND_FLAG_KEY];

    if (manualFlag) {
      await chrome.storage.sync.set({ [MANUAL_FLAG_KEY]: false });
      return true;
    }

    if (backgroundFlag === undefined) {
      await chrome.storage.sync.set({ [BACKGROUND_FLAG_KEY]: true });
      return true;
    }

    return readBooleanStorageValue(backgroundFlag, true);
  }

  window.__kinoPubImproveRequestScan = () => {
    scheduleScan();
  };

  async function loadHideWatchedSetting() {
    const storageItems = await chrome.storage.sync.get(HIDE_WATCHED_FLAG_KEY);
    hideWatchedEnabled = readBooleanStorageValue(
      storageItems[HIDE_WATCHED_FLAG_KEY],
      false
    );
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[CACHE_STORAGE_KEY]) {
      watchedCache = null;
    }

    if (areaName === 'sync' && changes[STORAGE_KEYS.runtimeSettings]) {
      refreshRuntimeScanSettings().catch(() => undefined);
    }

    if (areaName !== 'sync' || !changes[HIDE_WATCHED_FLAG_KEY]) {
      return;
    }

    hideWatchedEnabled = readBooleanStorageValue(
      changes[HIDE_WATCHED_FLAG_KEY].newValue,
      false
    );
    refreshHiddenWatchedCards();

    if (hideWatchedEnabled && isScanAllowedOnUrl()) {
      scheduleScan();
    }
  });

  function isEntryWatchedOnPage(entry) {
    return (
      entry.itemElement.getAttribute(PROCESSED_ATTRIBUTE) === 'watched' ||
      entry.alreadyMarkedBySite ||
      entry.anchorElement?.classList.contains('darken') ||
      entry.anchorElement?.classList.contains('darken-mini') ||
      entry.anchorElement?.classList.contains('kpi-watched')
    );
  }

  function collectWatchedItemIdsFromPage() {
    const watchedItemIds = new Set();

    for (const entry of collectItemEntries(document)) {
      if (entry.itemId && isEntryWatchedOnPage(entry)) {
        watchedItemIds.add(String(entry.itemId));
      }
    }

    document
      .querySelectorAll(
        [
          'a[href*="/item/view/"].darken',
          'a[href*="/item/view/"].darken-mini',
          'a[href*="/item/view/"].kpi-watched',
          `[${PROCESSED_ATTRIBUTE}="watched"] a[href*="/item/view/"]`,
          `a[href*="/item/view/"][${PROCESSED_ATTRIBUTE}="watched"]`,
        ].join(', ')
      )
      .forEach((anchorElement) => {
        const itemId = extractItemId(anchorElement.href);
        if (itemId) {
          watchedItemIds.add(String(itemId));
        }
      });

    // Страницы поиска/списков: poster может быть отмечен, а ссылка с id — рядом.
    document.querySelectorAll(`.kpi-watched, .darken, .darken-mini`).forEach((element) => {
      const anchorElement =
        element.closest?.(ITEM_LINK_SELECTOR) ||
        element.querySelector?.(ITEM_LINK_SELECTOR) ||
        (element.matches?.(ITEM_LINK_SELECTOR) ? element : null);

      const itemId = extractItemId(anchorElement?.href);
      if (itemId) {
        watchedItemIds.add(String(itemId));
      }
    });

    return [...watchedItemIds];
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'kpi-set-hide-watched') {
      hideWatchedEnabled = Boolean(message.enabled);
      refreshHiddenWatchedCards();

      if (hideWatchedEnabled && isScanAllowedOnUrl()) {
        scheduleScan();
      }

      sendResponse({ ok: true, hideWatchedEnabled });
      return false;
    }

    if (message?.type === 'kpi-get-watched-item-ids') {
      try {
        sendResponse({
          ok: true,
          itemIds: collectWatchedItemIdsFromPage(),
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || 'Не удалось собрать просмотренные id.',
        });
      }
      return false;
    }

    if (message?.type !== 'kpi-scan') {
      return false;
    }

    if (!isScanAllowedOnUrl()) {
      sendResponse({
        ok: false,
        skipped: true,
        error: 'На страницах watchlist расширение не запускается.',
      });
      return false;
    }

    runScan()
      .then((result) => {
        refreshHiddenWatchedCards();
        sendResponse(result || { ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || 'Ошибка сканирования' });
      });

    return true;
  });

  (async () => {
    try {
      await refreshRuntimeScanSettings();
      await loadHideWatchedSetting();
      startMutationObserver();
      startPjaxListeners();

      if (!isScanAllowedOnUrl()) {
        return;
      }

      const shouldRun = await shouldRunAutomatically();
      if (shouldRun) {
        await runScan();
      }

      refreshHiddenWatchedCards();
    } catch (error) {
      console.error('KinoPub Improve: ошибка инициализации', error);
    }
  })();
})();
