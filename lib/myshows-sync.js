const MYSHOWS_ORIGIN = 'https://myshows.me';
const MYSHOWS_RPC_URL = `${MYSHOWS_ORIGIN}/v3/rpc/`;
const SYNC_REPORT_KEY = 'kino-pub-improve-myshows-report';
const SYNC_STATE_KEY = 'kino-pub-improve-myshows-sync-state';
const SYNC_MODE_KEY = 'kino-pub-improve-myshows-sync-mode';
const SYNC_CONTENT_TYPE_KEY = 'kino-pub-improve-myshows-sync-content-type';

const SYNC_MODES = {
  cache: 'cache',
  currentPage: 'currentPage',
  history: 'history',
};

// Паузы по умолчанию; в рантайме подменяются из getRuntimeSettings().
let DELAY_BETWEEN_ITEMS_MS = 450;
let DELAY_BETWEEN_MYSHOWS_RPC_MS = 300;
const DELAY_BETWEEN_HISTORY_PAGES_MS = 500;
const FETCH_MAX_ATTEMPTS = 3;

let activeSyncPromise = null;
let syncCancelRequested = false;
let lastMyShowsRpcAt = 0;

async function applyRuntimeSyncSettings() {
  const runtimeSettings = await getRuntimeSettings();
  DELAY_BETWEEN_ITEMS_MS = runtimeSettings.syncDelayMs;
  DELAY_BETWEEN_MYSHOWS_RPC_MS = runtimeSettings.myshowsRpcDelayMs;
  return runtimeSettings;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function waitBeforeMyShowsRpc() {
  const elapsedMs = Date.now() - lastMyShowsRpcAt;
  if (elapsedMs < DELAY_BETWEEN_MYSHOWS_RPC_MS) {
    await sleep(DELAY_BETWEEN_MYSHOWS_RPC_MS - elapsedMs);
  }
  lastMyShowsRpcAt = Date.now();
}

function createEmptySyncReport(mode, options = {}) {
  return {
    mode,
    dryRun: Boolean(options.dryRun),
    kinoOrigin: options.kinoOrigin || null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    totals: {
      candidates: 0,
      movies: 0,
      synced: 0,
      skipped: 0,
      errors: 0,
    },
    synced: [],
    skipped: [],
    errors: [],
  };
}

function pushSkipped(report, item) {
  report.skipped.push(item);
  report.totals.skipped += 1;
}

function pushError(report, item) {
  report.errors.push(item);
  report.totals.errors += 1;
}

function pushSynced(report, item) {
  report.synced.push(item);
  report.totals.synced += 1;
}

async function saveSyncReport(report) {
  await chrome.storage.local.set({ [SYNC_REPORT_KEY]: report });
}

async function getMyShowsAuthToken() {
  const authCookie = await chrome.cookies.get({
    url: MYSHOWS_ORIGIN,
    name: 'msAuthToken',
  });

  if (authCookie?.value) {
    return authCookie.value;
  }

  throw new Error(
    'Нет сессии MyShows. Открой myshows.me, войди в аккаунт и попробуй снова.'
  );
}

function requestSyncCancel() {
  syncCancelRequested = true;
}

function isSyncCancelRequested() {
  return syncCancelRequested;
}

function isSyncRunning() {
  return Boolean(activeSyncPromise);
}

async function saveSyncState(state) {
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: state });
}

async function clearSyncState() {
  await chrome.storage.local.remove(SYNC_STATE_KEY);
}

async function loadSyncState() {
  const storage = await chrome.storage.local.get(SYNC_STATE_KEY);
  return storage[SYNC_STATE_KEY] || null;
}

async function callMyShowsRpc(methodName, params, authToken) {
  let lastError = null;

  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
    await waitBeforeMyShowsRpc();

    try {
      const response = await fetch(
        `${MYSHOWS_RPC_URL}?method=${encodeURIComponent(methodName)}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization2: `Bearer ${authToken}`,
            Platform: 'desktop',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: methodName,
            params,
          }),
          credentials: 'include',
        }
      );

      if (response.status === 429 || response.status === 503) {
        lastError = new Error(
          `MyShows временно ограничил запросы (HTTP ${response.status}).`
        );
        await sleep(1500 * attempt);
        continue;
      }

      if (!response.ok) {
        throw new Error(`MyShows RPC HTTP ${response.status} (${methodName})`);
      }

      const payload = await response.json();
      if (payload.error) {
        throw new Error(payload.error.message || `MyShows RPC error (${methodName})`);
      }

      return payload.result;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const isRetryable =
        message.includes('временно ограничил') ||
        message.includes('Failed to fetch') ||
        message.includes('NetworkError');

      if (!isRetryable || attempt === FETCH_MAX_ATTEMPTS) {
        throw error;
      }

      await sleep(800 * attempt);
    }
  }

  throw lastError || new Error(`MyShows RPC failed (${methodName})`);
}

function buildKinoItemUrl(origin, itemId) {
  return `${origin}/item/view/${itemId}`;
}

async function fetchKinoItemHtml(origin, itemId) {
  let lastError = null;

  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(buildKinoItemUrl(origin, itemId), {
        credentials: 'include',
        cache: 'no-cache',
      });

      if (response.status === 429 || response.status === 503) {
        lastError = new Error(`Kino временно ограничил запросы (HTTP ${response.status})`);
        await sleep(1200 * attempt);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Kino HTTP ${response.status} для item ${itemId}`);
      }

      return response.text();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const isRetryable =
        message.includes('временно ограничил') ||
        message.includes('Failed to fetch') ||
        message.includes('NetworkError');

      if (!isRetryable || attempt === FETCH_MAX_ATTEMPTS) {
        throw error;
      }

      await sleep(700 * attempt);
    }
  }

  throw lastError || new Error(`Kino fetch failed для item ${itemId}`);
}

function parseKinoMovieDetails(htmlText, itemId, origin) {
  const playlist = parseWindowJsonAssignment(htmlText, 'PLAYER_PLAYLIST') || [];
  const seasons = parseWindowJsonAssignment(htmlText, 'PLAYER_SEASONS') || [];
  const titles = splitKinoTitle(playlist[0]?.title || '');
  const year = extractYearFromHtml(htmlText, playlist);
  const isMovie = isKinoMovie(htmlText, seasons);
  const isWatched = isKinoItemWatched(playlist, seasons);
  const externalIds = extractExternalIdsFromHtml(htmlText);

  let titleRu = titles.titleRu;
  let titleOriginal = titles.titleOriginal;

  const ogTitleMatch = htmlText.match(
    /<meta\s+property="og:title"\s+content="([^"]+)"/i
  );
  if (ogTitleMatch?.[1]) {
    const ogTitles = splitKinoTitle(ogTitleMatch[1]);
    if (!titleRu && ogTitles.titleRu) {
      titleRu = ogTitles.titleRu;
    }
    if (ogTitles.titleOriginal) {
      titleOriginal = titleOriginal || ogTitles.titleOriginal;
    }
  }

  const documentTitleMatch = htmlText.match(/<title>\s*([^<]+?)\s*<\/title>/i);
  if (documentTitleMatch?.[1]) {
    const documentTitles = splitKinoTitle(documentTitleMatch[1]);
    if (!titleRu && documentTitles.titleRu) {
      titleRu = documentTitles.titleRu;
    }
    if (documentTitles.titleOriginal) {
      titleOriginal = titleOriginal || documentTitles.titleOriginal;
    }
  }

  const headingMatch = htmlText.match(/<h3>\s*([\s\S]*?)<\/h3>/i);
  if (headingMatch) {
    const headingHtml = headingMatch[1];
    const ruMatch = headingHtml.match(/^([^<]+)/);
    const originalMatch = headingHtml.match(/<small[^>]*>\s*([^<]+)/i);

    if (ruMatch?.[1]?.trim()) {
      titleRu = ruMatch[1].trim();
    }

    if (originalMatch?.[1]?.trim()) {
      const originalCandidate = originalMatch[1]
        .trim()
        .replace(/\s+(UHD|4K|HD|\+).*$/i, '')
        .trim();
      if (originalCandidate) {
        titleOriginal = originalCandidate;
      }
    }
  }

  if (!titleOriginal && titleRu.includes(' / ')) {
    const splitTitles = splitKinoTitle(titleRu);
    titleRu = splitTitles.titleRu || titleRu;
    titleOriginal = splitTitles.titleOriginal;
  }

  return {
    itemId: String(itemId),
    url: buildKinoItemUrl(origin, itemId),
    titleRu,
    titleOriginal,
    year,
    kinopoiskId: externalIds.kinopoiskId,
    imdbId: externalIds.imdbId,
    isMovie,
    isWatched,
  };
}

function mergeCatalogAndDetailedMovie(catalogMovie, detailedMovie) {
  return {
    ...catalogMovie,
    ...detailedMovie,
    id: catalogMovie.id || detailedMovie.id,
    userMovie: catalogMovie.userMovie || detailedMovie.userMovie || null,
  };
}

async function fetchMyShowsMovieById(movieId, authToken) {
  return callMyShowsRpc(
    'movies.GetById',
    {
      movieId: Number(movieId),
    },
    authToken
  );
}

function prioritizeCandidatesForIdLookup(candidateMovies, movieDetails) {
  return [...candidateMovies].sort((leftMovie, rightMovie) => {
    const leftYearMatch =
      movieDetails.year && Number(leftMovie.year) === Number(movieDetails.year) ? 1 : 0;
    const rightYearMatch =
      movieDetails.year && Number(rightMovie.year) === Number(movieDetails.year) ? 1 : 0;

    if (leftYearMatch !== rightYearMatch) {
      return rightYearMatch - leftYearMatch;
    }

    const leftExactTitle = pickExactTitleMatches([leftMovie], movieDetails).length > 0 ? 1 : 0;
    const rightExactTitle = pickExactTitleMatches([rightMovie], movieDetails).length > 0 ? 1 : 0;

    if (leftExactTitle !== rightExactTitle) {
      return rightExactTitle - leftExactTitle;
    }

    return (Number(rightMovie.watched) || 0) - (Number(leftMovie.watched) || 0);
  });
}

async function resolveMatchByExternalIds(candidateMovies, movieDetails, authToken) {
  const orderedCandidates = prioritizeCandidatesForIdLookup(candidateMovies, movieDetails);
  const detailsByMovieId = new Map();
  const maxLookups = 20;

  for (const candidateMovie of orderedCandidates.slice(0, maxLookups)) {
    const detailedMovie = await fetchMyShowsMovieById(candidateMovie.id, authToken);
    detailsByMovieId.set(Number(candidateMovie.id), detailedMovie);

    const matchMethod = movieMatchesExternalIds(detailedMovie, movieDetails);
    if (matchMethod) {
      return {
        status: 'matched',
        movie: mergeCatalogAndDetailedMovie(candidateMovie, detailedMovie),
        matchMethod,
        detailsByMovieId,
      };
    }
  }

  return {
    status: 'no-external-match',
    detailsByMovieId,
  };
}

function buildSearchResultBase(movieDetails, queries) {
  return {
    queries,
    titleOriginal: movieDetails.titleOriginal,
    titleRu: movieDetails.titleRu,
    kinopoiskId: movieDetails.kinopoiskId,
    imdbId: movieDetails.imdbId,
  };
}

async function searchMyShowsMovie(movieDetails, authToken) {
  const queries = buildSearchQueries(movieDetails);
  const candidateMoviesById = new Map();
  let lastAmbiguous = null;
  let titleMatched = null;
  const searchResultBase = buildSearchResultBase(movieDetails, queries);

  for (const query of queries) {
    const catalog = await callMyShowsRpc(
      'movies.GetCatalog',
      {
        search: { query },
        page: 0,
        pageSize: 10,
      },
      authToken
    );

    for (const catalogMovie of extractMoviesFromCatalog(catalog)) {
      if (!candidateMoviesById.has(Number(catalogMovie.id))) {
        candidateMoviesById.set(Number(catalogMovie.id), catalogMovie);
      }
    }

    const matchResult = pickMyShowsMovieMatch(catalog, movieDetails);
    if (matchResult.status === 'matched' && !titleMatched) {
      titleMatched = {
        ...matchResult,
        query,
        matchMethod: 'title',
        ...searchResultBase,
      };
    }

    if (matchResult.status === 'ambiguous') {
      const queryUsesOriginal =
        movieDetails.titleOriginal &&
        normalizeTitleForMatch(query).includes(
          normalizeTitleForMatch(movieDetails.titleOriginal)
        );

      // Первый ambiguous оставляем; русским не затираем, если уже есть от original.
      if (!lastAmbiguous || (queryUsesOriginal && !lastAmbiguous.queryUsesOriginal)) {
        lastAmbiguous = {
          ...matchResult,
          query,
          queryUsesOriginal: Boolean(queryUsesOriginal),
          ...searchResultBase,
        };
      }
    }
  }

  const candidateMovies = [...candidateMoviesById.values()];

  if (hasExternalIds(movieDetails) && candidateMovies.length > 0) {
    let titleFallbackWithoutExternalIds = null;

    // Сначала проверяем title-match по KP/IMDb; без ID не возвращаем сразу —
    // сначала ищем внешние ID среди остальных кандидатов.
    if (titleMatched) {
      const detailedTitleMatch = await fetchMyShowsMovieById(
        titleMatched.movie.id,
        authToken
      );
      const titleMatchMethod = movieMatchesExternalIds(detailedTitleMatch, movieDetails);

      if (titleMatchMethod) {
        return {
          status: 'matched',
          movie: mergeCatalogAndDetailedMovie(titleMatched.movie, detailedTitleMatch),
          matchMethod: titleMatchMethod,
          query: titleMatched.query,
          ...searchResultBase,
        };
      }

      if (!myShowsMovieHasExternalIds(detailedTitleMatch)) {
        titleFallbackWithoutExternalIds = {
          ...titleMatched,
          movie: mergeCatalogAndDetailedMovie(titleMatched.movie, detailedTitleMatch),
          matchMethod: 'title',
        };
      }
    }

    const candidatesForIdLookup = titleMatched
      ? candidateMovies.filter(
          (candidateMovie) => Number(candidateMovie.id) !== Number(titleMatched.movie.id)
        )
      : candidateMovies;

    const externalMatchResult = await resolveMatchByExternalIds(
      candidatesForIdLookup,
      movieDetails,
      authToken
    );

    if (externalMatchResult.status === 'matched') {
      return {
        status: 'matched',
        movie: externalMatchResult.movie,
        matchMethod: externalMatchResult.matchMethod,
        query: titleMatched?.query || lastAmbiguous?.query || queries[0] || '',
        ...searchResultBase,
      };
    }

    if (titleFallbackWithoutExternalIds) {
      return titleFallbackWithoutExternalIds;
    }

    if (lastAmbiguous) {
      return lastAmbiguous;
    }

    return {
      status: 'not-found',
      ...searchResultBase,
    };
  }

  if (titleMatched) {
    return titleMatched;
  }

  if (lastAmbiguous) {
    return lastAmbiguous;
  }

  return {
    status: 'not-found',
    ...searchResultBase,
  };
}

async function markMyShowsMovieFinished(movieId, authToken) {
  return callMyShowsRpc(
    'manage.SetMovieStatus',
    {
      movieId: Number(movieId),
      status: 'finished',
    },
    authToken
  );
}

function collectItemIdsFromHtml(htmlText, options = {}) {
  const preferCardScoped = Boolean(options.preferCardScoped);
  const itemIds = new Set();

  if (preferCardScoped && typeof htmlText === 'string') {
    // Берём ссылки рядом с карточками списка, а не любые /item/view/ со страницы
    // (рекомендации, футер, похожие).
    const cardScopedRegex =
      /(?:item-poster|item-media|util-item|history-item|item\s+item-)[\s\S]{0,2500}?\/item\/view\/(\d+)/gi;
    let cardMatch = cardScopedRegex.exec(htmlText);

    while (cardMatch) {
      itemIds.add(cardMatch[1]);
      cardMatch = cardScopedRegex.exec(htmlText);
    }

    if (itemIds.size > 0) {
      return [...itemIds];
    }
  }

  const hrefRegex = /\/item\/view\/(\d+)/gi;
  let match = hrefRegex.exec(htmlText);

  while (match) {
    itemIds.add(match[1]);
    match = hrefRegex.exec(htmlText);
  }

  return [...itemIds];
}

async function collectWatchedIdsFromCache() {
  const storage = await chrome.storage.local.get(STORAGE_KEYS.cache);
  const cacheStore = storage[STORAGE_KEYS.cache];

  if (!cacheStore) {
    return [];
  }

  if (cacheStore.version === 2 && cacheStore.watched) {
    return Object.keys(cacheStore.watched);
  }

  return Object.entries(cacheStore)
    .filter(([, value]) => value === true)
    .map(([key]) => {
      const match = String(key).match(/(\d{3,})/);
      return match?.[1];
    })
    .filter(Boolean);
}

async function collectWatchedIdsFromHistory(origin) {
  const itemIds = new Set();
  let pageNumber = 1;

  while (pageNumber <= 30) {
    const historyUrl =
      pageNumber === 1 ? `${origin}/history` : `${origin}/history?page=${pageNumber}`;
    const response = await fetch(historyUrl, {
      credentials: 'include',
      cache: 'no-cache',
    });

    if (!response.ok) {
      break;
    }

    const htmlText = await response.text();
    const pageItemIds = collectItemIdsFromHtml(htmlText, { preferCardScoped: true });
    if (pageItemIds.length === 0) {
      break;
    }

    const previousSize = itemIds.size;
    pageItemIds.forEach((itemId) => itemIds.add(itemId));

    const hasNextPage =
      htmlText.includes(`page=${pageNumber + 1}`) ||
      htmlText.includes(`?page=${pageNumber + 1}`) ||
      /rel=["']next["']/i.test(htmlText);

    if (!hasNextPage || itemIds.size === previousSize) {
      break;
    }

    pageNumber += 1;
    await sleep(DELAY_BETWEEN_HISTORY_PAGES_MS);
  }

  return [...itemIds];
}

async function ensureContentScriptOnTab(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content-scripts/styles.css'],
    });
  } catch (error) {
    // CSS мог уже быть внедрён.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['lib/hosts.js', 'lib/match-utils.js', 'content-scripts/content.js'],
  });
}

async function requestWatchedIdsFromTab(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'kpi-get-watched-item-ids',
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Не удалось прочитать текущую страницу.');
  }

  return response.itemIds || [];
}

async function collectWatchedIdsFromCurrentPage(tabId) {
  let targetTabId = Number(tabId) || null;

  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id || null;
  }

  if (!targetTabId) {
    throw new Error('Вкладка Kinopub не найдена.');
  }

  const tab = await chrome.tabs.get(targetTabId);
  const hostSettings = await getHostSettings();
  if (!tab?.url || !isUrlMatchingHosts(tab.url, hostSettings.allHosts)) {
    throw new Error('Открой вкладку Kinopub со списком или поиском и запусти снова.');
  }

  try {
    return await requestWatchedIdsFromTab(targetTabId);
  } catch (firstError) {
    try {
      await ensureContentScriptOnTab(targetTabId);
      return await requestWatchedIdsFromTab(targetTabId);
    } catch (secondError) {
      throw new Error(
        'Не удалось прочитать вкладку Kinopub. Обнови страницу и запусти синхронизацию снова.'
      );
    }
  }
}

async function resolveKinoOrigin(options = {}) {
  const hostSettings = await getHostSettings();
  const candidateTabIds = [];

  if (options.tabId) {
    candidateTabIds.push(Number(options.tabId));
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      candidateTabIds.push(activeTab.id);
    }
  } catch (error) {
    // Нет доступа к tabs — уйдём на mainHost.
  }

  for (const tabId of candidateTabIds) {
    if (!tabId) {
      continue;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && isUrlMatchingHosts(tab.url, hostSettings.allHosts)) {
        return new URL(tab.url).origin;
      }
    } catch (error) {
      // Пробуем следующий tab / fallback.
    }
  }

  return `https://${hostSettings.mainHost}`;
}

function shouldTrustSourceAsWatched(mode) {
  // history — источник «уже смотрел»; cache может устареть, проверяем item-страницу.
  return mode === SYNC_MODES.history;
}

async function collectItemIdsForSyncMode(mode, origin, sourceTabId) {
  if (mode === SYNC_MODES.cache) {
    return collectWatchedIdsFromCache();
  }

  if (mode === SYNC_MODES.currentPage) {
    return collectWatchedIdsFromCurrentPage(sourceTabId);
  }

  if (mode === SYNC_MODES.history) {
    return collectWatchedIdsFromHistory(origin);
  }

  throw new Error('Неизвестный режим синхронизации.');
}

async function processSyncItem(itemId, mode, origin, authToken, report, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const htmlText = await fetchKinoItemHtml(origin, itemId);
  const movieDetails = parseKinoMovieDetails(htmlText, itemId, origin);

  if (!movieDetails.isMovie) {
    pushSkipped(report, {
      reason: 'not-movie',
      itemId,
      url: movieDetails.url,
      title: movieDetails.titleRu || movieDetails.titleOriginal,
    });
    return;
  }

  if (!movieDetails.isWatched && !shouldTrustSourceAsWatched(mode)) {
    pushSkipped(report, {
      reason: 'not-watched-on-kino',
      itemId,
      url: movieDetails.url,
      title: movieDetails.titleRu || movieDetails.titleOriginal,
    });
    return;
  }

  report.totals.movies += 1;

  const searchResult = await searchMyShowsMovie(movieDetails, authToken);
  if (searchResult.status === 'not-found') {
    pushSkipped(report, {
      reason: 'not-found',
      itemId,
      url: movieDetails.url,
      title: movieDetails.titleRu || movieDetails.titleOriginal,
      titleOriginal: movieDetails.titleOriginal,
      year: movieDetails.year,
      kinopoiskId: movieDetails.kinopoiskId,
      imdbId: movieDetails.imdbId,
      queries: searchResult.queries || buildSearchQueries(movieDetails),
    });
    return;
  }

  if (searchResult.status === 'ambiguous') {
    pushSkipped(report, {
      reason: 'ambiguous',
      itemId,
      url: movieDetails.url,
      title: movieDetails.titleRu || movieDetails.titleOriginal,
      titleOriginal: movieDetails.titleOriginal,
      year: movieDetails.year,
      kinopoiskId: movieDetails.kinopoiskId,
      imdbId: movieDetails.imdbId,
      query: searchResult.query,
      queries: searchResult.queries || buildSearchQueries(movieDetails),
      candidates: searchResult.candidates,
    });
    return;
  }

  const myShowsMovie = searchResult.movie;
  const watchStatus = myShowsMovie.userMovie?.watchStatus;
  if (watchStatus === 'finished') {
    pushSkipped(report, {
      reason: 'already-finished',
      itemId,
      url: movieDetails.url,
      title: movieDetails.titleRu || movieDetails.titleOriginal,
      kinopoiskId: movieDetails.kinopoiskId,
      imdbId: movieDetails.imdbId,
      matchMethod: searchResult.matchMethod || 'title',
      myshowsId: myShowsMovie.id,
      myshowsUrl: `${MYSHOWS_ORIGIN}/movie/${myShowsMovie.id}/`,
    });
    return;
  }

  if (!dryRun) {
    await markMyShowsMovieFinished(myShowsMovie.id, authToken);
  }

  pushSynced(report, {
    itemId,
    url: movieDetails.url,
    title: movieDetails.titleRu || movieDetails.titleOriginal,
    titleOriginal: movieDetails.titleOriginal,
    year: movieDetails.year,
    kinopoiskId: movieDetails.kinopoiskId,
    imdbId: movieDetails.imdbId,
    matchMethod: searchResult.matchMethod || 'title',
    dryRun,
    myshowsId: myShowsMovie.id,
    myshowsUrl: `${MYSHOWS_ORIGIN}/movie/${myShowsMovie.id}/`,
    query: searchResult.query,
  });
}

async function syncWatchedMoviesToMyShows(mode, options = {}) {
  if (activeSyncPromise) {
    throw new Error('Синхронизация уже выполняется.');
  }

  const shouldResume = Boolean(options.resume);
  syncCancelRequested = false;

  // Присваиваем сразу, до первого await внутри — защита от параллельного старта.
  activeSyncPromise = (async () => {
    let report = null;

    try {
      let itemIds = [];
      let startIndex = 0;
      let sourceTabId = options.tabId || null;
      let dryRun = Boolean(options.dryRun);
      let origin = null;

      if (shouldResume) {
        const existingState = await loadSyncState();
        const existingReportStorage = await chrome.storage.local.get(SYNC_REPORT_KEY);
        const existingReport = existingReportStorage[SYNC_REPORT_KEY];

        if (
          !existingState?.itemIds?.length ||
          !existingReport ||
          existingReport.status !== 'running'
        ) {
          throw new Error('Нет прерванной синхронизации для продолжения.');
        }

        report = existingReport;
        itemIds = existingState.itemIds.map(String);
        startIndex = Number(existingState.nextIndex) || 0;
        sourceTabId = existingState.sourceTabId || sourceTabId;
        mode = existingState.mode || mode;
        dryRun = Boolean(existingState.dryRun ?? report.dryRun);
        origin = existingState.kinoOrigin || report.kinoOrigin || null;
      } else {
        // Report сразу в storage — UI не зависает в «running» без отчёта при ошибке auth.
        report = createEmptySyncReport(mode, {
          dryRun,
          kinoOrigin: '',
        });
        if (sourceTabId) {
          report.sourceTabId = sourceTabId;
        }
        await saveSyncReport(report);
      }

      await applyRuntimeSyncSettings();
      const authToken = await getMyShowsAuthToken();
      origin = origin || (await resolveKinoOrigin({ tabId: sourceTabId }));
      report.kinoOrigin = origin;

      if (!shouldResume) {
        itemIds = await collectItemIdsForSyncMode(mode, origin, sourceTabId);
        itemIds = [...new Set(itemIds.map(String))];
        report.totals.candidates = itemIds.length;
        await saveSyncReport(report);
        await saveSyncState({
          mode,
          sourceTabId,
          itemIds,
          nextIndex: 0,
          dryRun,
          kinoOrigin: origin,
        });
      }

      for (let itemIndex = startIndex; itemIndex < itemIds.length; itemIndex += 1) {
        if (isSyncCancelRequested()) {
          report.status = 'cancelled';
          report.finishedAt = new Date().toISOString();
          await saveSyncReport(report);
          await clearSyncState();
          return report;
        }

        const itemId = itemIds[itemIndex];

        try {
          await processSyncItem(itemId, mode, origin, authToken, report, { dryRun });
        } catch (itemError) {
          pushError(report, {
            itemId,
            url: buildKinoItemUrl(origin, itemId),
            message: itemError?.message || 'Ошибка обработки',
          });
        }

        await saveSyncState({
          mode,
          sourceTabId,
          itemIds,
          nextIndex: itemIndex + 1,
          dryRun,
          kinoOrigin: origin,
        });
        await saveSyncReport(report);

        // Не спим после последнего item — иначе SW может умереть и оставить running навсегда.
        if (itemIndex + 1 < itemIds.length) {
          await sleep(DELAY_BETWEEN_ITEMS_MS);
        }
      }

      report.status = 'done';
      report.finishedAt = new Date().toISOString();
      await saveSyncReport(report);
      await clearSyncState();
      return report;
    } catch (error) {
      if (report) {
        report.status = isSyncCancelRequested() ? 'cancelled' : 'failed';
        report.finishedAt = new Date().toISOString();
        pushError(report, {
          message: error?.message || 'Синхронизация прервана',
        });
        await saveSyncReport(report);
      }

      if (isSyncCancelRequested()) {
        await clearSyncState();
      }

      throw error;
    } finally {
      activeSyncPromise = null;
      syncCancelRequested = false;
    }
  })();

  return activeSyncPromise;
}

let resumeInterruptedSyncPromise = null;

async function finalizeStuckRunningSync(report, existingState) {
  if (!report || report.status !== 'running') {
    return false;
  }

  const itemIds = existingState?.itemIds || [];
  const nextIndex = Number(existingState?.nextIndex) || 0;

  if (itemIds.length > 0 && nextIndex >= itemIds.length) {
    report.status = 'done';
    report.finishedAt = new Date().toISOString();
    await saveSyncReport(report);
    await clearSyncState();
    return true;
  }

  if (!itemIds.length) {
    report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    pushError(report, {
      message: 'Синхронизация прервана (нет checkpoint).',
    });
    await saveSyncReport(report);
    await clearSyncState();
    return true;
  }

  return false;
}

async function maybeResumeInterruptedSync() {
  if (activeSyncPromise) {
    return false;
  }

  if (resumeInterruptedSyncPromise) {
    return resumeInterruptedSyncPromise;
  }

  resumeInterruptedSyncPromise = (async () => {
    try {
      if (activeSyncPromise) {
        return false;
      }

      const existingState = await loadSyncState();
      const reportStorage = await chrome.storage.local.get(SYNC_REPORT_KEY);
      const report = reportStorage[SYNC_REPORT_KEY];

      if (report?.status === 'running') {
        const finalizedStuck = await finalizeStuckRunningSync(report, existingState);
        if (finalizedStuck) {
          return false;
        }
      }

      if (
        !existingState?.itemIds?.length ||
        report?.status !== 'running' ||
        Number(existingState.nextIndex) >= existingState.itemIds.length
      ) {
        return false;
      }

      if (activeSyncPromise) {
        return false;
      }

      syncWatchedMoviesToMyShows(existingState.mode || SYNC_MODES.cache, {
        resume: true,
        tabId: existingState.sourceTabId || null,
      }).catch((error) => {
        console.error('MyShows sync resume failed:', error);
      });

      return true;
    } finally {
      resumeInterruptedSyncPromise = null;
    }
  })();

  return resumeInterruptedSyncPromise;
}

async function markAmbiguousCandidateAsFinished(payload = {}) {
  const movieId = Number(payload.movieId);
  const itemId = payload.itemId != null ? String(payload.itemId) : '';
  const candidateTitle = payload.candidateTitle || '';

  if (!movieId) {
    throw new Error('Не указан movieId кандидата MyShows.');
  }

  if (!itemId) {
    throw new Error('Не указан itemId Kinopub.');
  }

  const authToken = await getMyShowsAuthToken();
  await markMyShowsMovieFinished(movieId, authToken);

  const reportStorage = await chrome.storage.local.get(SYNC_REPORT_KEY);
  const report = reportStorage[SYNC_REPORT_KEY];
  if (!report || typeof report !== 'object') {
    throw new Error('Отчёт синхронизации не найден.');
  }

  const skippedItems = Array.isArray(report.skipped) ? report.skipped : [];
  const skippedIndex = skippedItems.findIndex(
    (item) => item?.reason === 'ambiguous' && String(item.itemId) === itemId
  );

  if (skippedIndex < 0) {
    throw new Error('Запись ambiguous для этого item не найдена в отчёте.');
  }

  const skippedItem = skippedItems[skippedIndex];
  skippedItems.splice(skippedIndex, 1);
  report.skipped = skippedItems;
  report.totals.skipped = Math.max(0, (report.totals.skipped || 0) - 1);

  pushSynced(report, {
    itemId,
    url: skippedItem.url,
    title: skippedItem.title || candidateTitle,
    titleOriginal: skippedItem.titleOriginal,
    year: skippedItem.year,
    kinopoiskId: skippedItem.kinopoiskId,
    imdbId: skippedItem.imdbId,
    matchMethod: 'manual',
    myshowsId: movieId,
    myshowsUrl: `${MYSHOWS_ORIGIN}/movie/${movieId}/`,
    query: skippedItem.query,
  });

  await saveSyncReport(report);
  return report;
}
