document.addEventListener('DOMContentLoaded', async () => {
  const markWatchedButton = document.getElementById('markWatchedButton');
  const backgroundButton = document.getElementById('backgroundButton');
  const hideWatchedButton = document.getElementById('hideWatchedButton');
  const resetCacheButton = document.getElementById('resetCacheButton');
  const exportCacheButton = document.getElementById('exportCacheButton');
  const importCacheButton = document.getElementById('importCacheButton');
  const importCacheInput = document.getElementById('importCacheInput');
  const mainHostInput = document.getElementById('mainHostInput');
  const mirrorHostInput = document.getElementById('mirrorHostInput');
  const addMirrorButton = document.getElementById('addMirrorButton');
  const mirrorsList = document.getElementById('mirrorsList');
  const saveHostsButton = document.getElementById('saveHostsButton');
  const hostsStatus = document.getElementById('hostsStatus');
  const myshowsSyncSectionToggle = document.getElementById('myshowsSyncSectionToggle');
  const myshowsSyncSectionBody = document.getElementById('myshowsSyncSectionBody');
  const myshowsSyncContentType = document.getElementById('myshowsSyncContentType');
  const myshowsSyncMode = document.getElementById('myshowsSyncMode');
  const myshowsSyncButton = document.getElementById('myshowsSyncButton');
  const myshowsCancelButton = document.getElementById('myshowsCancelButton');
  const myshowsDryRunToggle = document.getElementById('myshowsDryRunToggle');
  const myshowsReportLink = document.getElementById('myshowsReportLink');
  const myshowsSyncStatus = document.getElementById('myshowsSyncStatus');
  const hostsSectionToggle = document.getElementById('hostsSectionToggle');

  const MYSHOWS_ORIGIN_PATTERN = '*://myshows.me/*';
  const SYNC_MODE_KEY = 'kino-pub-improve-myshows-sync-mode';
  const SYNC_CONTENT_TYPE_KEY = 'kino-pub-improve-myshows-sync-content-type';
  const SYNC_DRY_RUN_KEY = 'kino-pub-improve-myshows-sync-dry-run';
  const SYNC_SECTION_ENABLED_KEY = 'kino-pub-improve-myshows-sync-section-enabled';
  const HOSTS_SECTION_ENABLED_KEY = 'kino-pub-improve-hosts-section-enabled';
  const SYNC_REPORT_KEY = 'kino-pub-improve-myshows-report';
  const SCAN_PROGRESS_KEY = 'kino-pub-improve-scan-progress';
  const READY_SYNC_CONTENT_TYPES = new Set(['movies']);

  let isMyshowsSyncRunningUi = false;

  function setHostsStatus(message, isError = false) {
    if (!hostsStatus) {
      return;
    }

    hostsStatus.textContent = message || '';
    hostsStatus.classList.toggle('error', Boolean(isError && message));
  }

  const hostsForm = initHostsForm({
    mainHostInput,
    mirrorHostInput,
    addMirrorButton,
    mirrorsList,
    saveHostsButton,
    setStatus: setHostsStatus,
  });

  function getOriginMatchPattern(pageUrl) {
    try {
      const hostname = new URL(pageUrl).hostname.toLowerCase();
      return hostToMatchPattern(hostname);
    } catch (error) {
      return null;
    }
  }

  async function ensureTabHostPermission(pageUrl) {
    const originPattern = getOriginMatchPattern(pageUrl);
    if (!originPattern) {
      return false;
    }

    const alreadyGranted = await chrome.permissions.contains({
      origins: [originPattern],
    });

    if (alreadyGranted) {
      return true;
    }

    return chrome.permissions.request({
      origins: [originPattern],
    });
  }

  async function executeContentScript() {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id || !activeTab.url) {
        console.error('Активная вкладка не найдена.');
        setHostsStatus('Активная вкладка не найдена.', true);
        return;
      }

      const hostSettings = await getHostSettings();
      if (!isUrlMatchingHosts(activeTab.url, hostSettings.allHosts)) {
        setHostsStatus(
          `Откройте ${hostSettings.mainHost} или добавленное зеркало.`,
          true
        );
        return;
      }

      if (!isScanAllowedOnUrl(activeTab.url)) {
        setHostsStatus('На watchlist расширение не запускается.', true);
        return;
      }

      const permissionGranted = await ensureTabHostPermission(activeTab.url);
      if (!permissionGranted) {
        setHostsStatus('Нужно разрешить доступ к этому сайту.', true);
        return;
      }

      setHostsStatus('Сканирование...');

      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'kpi-scan' });
        if (response?.ok) {
          if (response.queued) {
            setHostsStatus('Скан уже идёт, повтор поставлен в очередь.');
            return;
          }

          setHostsStatus(
            `Готово: ${response.processed || 0}/${response.total || 0}` +
              (response.failed ? `, ошибок: ${response.failed}` : '')
          );
          return;
        }
      } catch (messageError) {
        // Скрипт ещё не внедрён на вкладке — инжектим ниже.
      }

      await chrome.storage.sync.set({ [STORAGE_KEYS.manualFlag]: true });

      await chrome.scripting.insertCSS({
        target: { tabId: activeTab.id },
        files: ['content-scripts/styles.css'],
      });

      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['lib/hosts.js', 'lib/match-utils.js', 'content-scripts/content.js'],
      });

      setHostsStatus('Скрипт внедрён, идёт скан...');
    } catch (error) {
      console.error('Ошибка при выполнении контент-скрипта:', error);
      setHostsStatus(error?.message || 'Не удалось выполнить скрипт.', true);
    }
  }

  if (markWatchedButton) {
    markWatchedButton.addEventListener('click', executeContentScript);
  }

  if (backgroundButton) {
    chrome.storage.sync.get([STORAGE_KEYS.backgroundFlag], async (result) => {
      const backgroundFlag = result[STORAGE_KEYS.backgroundFlag];

      if (backgroundFlag === undefined) {
        await chrome.storage.sync.set({ [STORAGE_KEYS.backgroundFlag]: true });
        backgroundButton.checked = true;
      } else {
        backgroundButton.checked = readBooleanStorageValue(backgroundFlag, true);
      }
    });

    backgroundButton.addEventListener('change', async () => {
      const isChecked = backgroundButton.checked;

      try {
        await chrome.storage.sync.set({
          [STORAGE_KEYS.backgroundFlag]: isChecked,
        });

        if (isChecked && markWatchedButton) {
          markWatchedButton.click();
        }
      } catch (error) {
        console.error('Ошибка при изменении состояния фонового режима:', error);
      }
    });
  }

  if (hideWatchedButton) {
    chrome.storage.sync.get([STORAGE_KEYS.hideWatchedFlag], async (result) => {
      const hideWatchedFlag = result[STORAGE_KEYS.hideWatchedFlag];

      if (hideWatchedFlag === undefined) {
        await chrome.storage.sync.set({ [STORAGE_KEYS.hideWatchedFlag]: false });
        hideWatchedButton.checked = false;
      } else {
        hideWatchedButton.checked = readBooleanStorageValue(hideWatchedFlag, false);
      }
    });

    hideWatchedButton.addEventListener('change', async () => {
      const isChecked = hideWatchedButton.checked;

      try {
        await chrome.storage.sync.set({
          [STORAGE_KEYS.hideWatchedFlag]: isChecked,
        });

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          try {
            await chrome.tabs.sendMessage(activeTab.id, {
              type: 'kpi-set-hide-watched',
              enabled: isChecked,
            });
          } catch (messageError) {
            // Скрипт ещё не на вкладке — применится после загрузки/скана.
          }
        }

        if (isChecked && markWatchedButton) {
          markWatchedButton.click();
        }

        setHostsStatus(
          isChecked ? 'Просмотренные скрываются.' : 'Просмотренные снова видны.'
        );
      } catch (error) {
        console.error('Ошибка при изменении скрытия просмотренных:', error);
        setHostsStatus('Не удалось изменить настройку.', true);
      }
    });
  }

  async function getCacheStats() {
    const storage = await chrome.storage.local.get(STORAGE_KEYS.cache);
    const cacheStore = storage[STORAGE_KEYS.cache];

    if (!cacheStore || typeof cacheStore !== 'object') {
      return { watchedCount: 0, unwatchedCount: 0 };
    }

    if (cacheStore.version === 2) {
      return {
        watchedCount: Object.keys(cacheStore.watched || {}).length,
        unwatchedCount: Object.keys(cacheStore.unwatched || {}).length,
      };
    }

    const watchedCount = Object.values(cacheStore).filter((value) => value === true).length;
    return { watchedCount, unwatchedCount: 0 };
  }

  if (resetCacheButton) {
    resetCacheButton.addEventListener('click', async () => {
      try {
        const cacheStats = await getCacheStats();
        const confirmed = window.confirm(
          `Сбросить кэш просмотренных?\n\nПросмотренных: ${cacheStats.watchedCount}\nНепросмотренных: ${cacheStats.unwatchedCount}`
        );
        if (!confirmed) {
          return;
        }

        await chrome.storage.local.remove(STORAGE_KEYS.cache);
        setHostsStatus(
          `Кэш сброшен (${cacheStats.watchedCount} просм., ${cacheStats.unwatchedCount} непросм.).`
        );
      } catch (error) {
        console.error('Ошибка при сбросе кэша:', error);
        setHostsStatus('Не удалось сбросить кэш.', true);
      }
    });
  }

  if (exportCacheButton) {
    exportCacheButton.addEventListener('click', async () => {
      try {
        const storage = await chrome.storage.local.get(STORAGE_KEYS.cache);
        const cacheStore = storage[STORAGE_KEYS.cache] || {
          version: 2,
          watched: {},
          unwatched: {},
        };
        const payload = {
          exportedAt: new Date().toISOString(),
          source: 'kino-pub-improve',
          cache: cacheStore,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: 'application/json',
        });
        const objectUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement('a');
        downloadLink.href = objectUrl;
        downloadLink.download = `kino-pub-improve-cache-${Date.now()}.json`;
        downloadLink.click();
        URL.revokeObjectURL(objectUrl);

        // Popup перекрывает системную выпадашку загрузок Chrome.
        if (!document.documentElement.classList.contains('is-sidepanel')) {
          window.close();
          return;
        }

        setHostsStatus('Кэш экспортирован.');
      } catch (error) {
        console.error('Ошибка экспорта кэша:', error);
        setHostsStatus('Не удалось экспортировать кэш.', true);
      }
    });
  }

  if (importCacheButton && importCacheInput) {
    importCacheButton.addEventListener('click', () => {
      importCacheInput.click();
    });

    importCacheInput.addEventListener('change', async () => {
      const selectedFile = importCacheInput.files?.[0];
      importCacheInput.value = '';

      if (!selectedFile) {
        return;
      }

      try {
        const fileText = await selectedFile.text();
        const parsedPayload = JSON.parse(fileText);
        const cacheStore = parsedPayload?.cache || parsedPayload;

        if (!cacheStore || typeof cacheStore !== 'object') {
          throw new Error('Некорректный файл кэша.');
        }

        const confirmed = window.confirm(
          'Импорт заменит текущий кэш просмотренных. Продолжить?'
        );
        if (!confirmed) {
          return;
        }

        await chrome.storage.local.set({ [STORAGE_KEYS.cache]: cacheStore });
        const cacheStats = await getCacheStats();
        setHostsStatus(
          `Кэш импортирован (${cacheStats.watchedCount} просм., ${cacheStats.unwatchedCount} непросм.).`
        );
      } catch (error) {
        console.error('Ошибка импорта кэша:', error);
        setHostsStatus(error?.message || 'Не удалось импортировать кэш.', true);
      }
    });
  }

  function setMyshowsSyncStatus(message, isError = false) {
    if (!myshowsSyncStatus) {
      return;
    }

    myshowsSyncStatus.textContent = message || '';
    myshowsSyncStatus.classList.toggle('error', Boolean(isError && message));
  }

  function updateReportLink(report) {
    if (!myshowsReportLink) {
      return;
    }

    const reportUrl = chrome.runtime.getURL('report/report.html');
    myshowsReportLink.href = reportUrl;

    if (!report) {
      myshowsReportLink.setAttribute('aria-disabled', 'true');
      myshowsReportLink.textContent = 'Отчёт появится после запуска';
      return;
    }

    myshowsReportLink.removeAttribute('aria-disabled');
    if (report.status === 'running') {
      myshowsReportLink.textContent = 'Открыть отчёт (идёт синхронизация)';
    } else if (report.status === 'failed') {
      myshowsReportLink.textContent = 'Открыть отчёт (с ошибками)';
    } else if (report.status === 'cancelled') {
      myshowsReportLink.textContent = 'Открыть отчёт (остановлено)';
    } else {
      myshowsReportLink.textContent = 'Открыть отчёт';
    }
  }

  function setSyncButtonsState(isRunning) {
    isMyshowsSyncRunningUi = Boolean(isRunning);

    if (myshowsSyncButton) {
      const contentTypeReady = isSyncContentTypeReady();
      myshowsSyncButton.disabled = isMyshowsSyncRunningUi || !contentTypeReady;
    }

    if (myshowsCancelButton) {
      myshowsCancelButton.disabled = !isMyshowsSyncRunningUi;
    }
  }

  function getSelectedSyncContentType() {
    return myshowsSyncContentType?.value || 'movies';
  }

  function isSyncContentTypeReady(contentType = getSelectedSyncContentType()) {
    return READY_SYNC_CONTENT_TYPES.has(contentType);
  }

  function refreshMyshowsSyncControls() {
    const contentType = getSelectedSyncContentType();
    const isReady = isSyncContentTypeReady(contentType);

    if (myshowsSyncButton) {
      myshowsSyncButton.disabled = !isReady || isMyshowsSyncRunningUi;
    }

    if (myshowsCancelButton) {
      myshowsCancelButton.disabled = !isMyshowsSyncRunningUi;
    }

    if (!isReady) {
      setMyshowsSyncStatus('Этот вариант пока в разработке.');
      return;
    }

    if (myshowsSyncStatus?.textContent === 'Этот вариант пока в разработке.') {
      setMyshowsSyncStatus('');
    }
  }

  const isSidePanelUi = document.documentElement.classList.contains('is-sidepanel');

  function getLocalSectionEnabled(storageKey) {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch (error) {
      return false;
    }
  }

  function setLocalSectionEnabled(storageKey, isEnabled) {
    try {
      localStorage.setItem(storageKey, isEnabled ? 'true' : 'false');
    } catch (error) {
      // ignore
    }
  }

  function applyMyshowsSectionEnabled(isEnabled) {
    document.documentElement.classList.toggle('myshows-section-open', Boolean(isEnabled));

    if (myshowsSyncSectionToggle) {
      myshowsSyncSectionToggle.checked = Boolean(isEnabled);
    }
  }

  function applyHostsSectionEnabled(isEnabled) {
    document.documentElement.classList.toggle('hosts-section-open', Boolean(isEnabled));

    if (hostsSectionToggle) {
      hostsSectionToggle.checked = Boolean(isEnabled);
    }
  }

  async function persistCollapsibleSection(storageKey, isEnabled, applyEnabled) {
    setLocalSectionEnabled(storageKey, isEnabled);
    await chrome.storage.sync.set({
      [storageKey]: isEnabled,
    });

    if (isSidePanelUi) {
      applyEnabled(isEnabled);
      return;
    }

    // Пересчёт высоты popup только через reload.
    location.reload();
  }

  async function loadMyshowsSyncUi() {
    const storage = await chrome.storage.sync.get([
      SYNC_MODE_KEY,
      SYNC_CONTENT_TYPE_KEY,
      SYNC_SECTION_ENABLED_KEY,
      HOSTS_SECTION_ENABLED_KEY,
      SYNC_DRY_RUN_KEY,
    ]);
    const savedMode = storage[SYNC_MODE_KEY];
    const savedContentType = storage[SYNC_CONTENT_TYPE_KEY];
    const isMyshowsSectionEnabled = readBooleanStorageValue(
      storage[SYNC_SECTION_ENABLED_KEY],
      false
    );
    const isHostsSectionEnabled = readBooleanStorageValue(
      storage[HOSTS_SECTION_ENABLED_KEY],
      false
    );
    const localMyshowsSectionEnabled = getLocalSectionEnabled(SYNC_SECTION_ENABLED_KEY);
    const localHostsSectionEnabled = getLocalSectionEnabled(HOSTS_SECTION_ENABLED_KEY);

    // Только для popup: при расхождении перезагружаем, чтобы окно
    // пересчитало высоту с нуля (иначе пустота/скролл).
    if (
      !isSidePanelUi &&
      (isMyshowsSectionEnabled !== localMyshowsSectionEnabled ||
        isHostsSectionEnabled !== localHostsSectionEnabled)
    ) {
      setLocalSectionEnabled(SYNC_SECTION_ENABLED_KEY, isMyshowsSectionEnabled);
      setLocalSectionEnabled(HOSTS_SECTION_ENABLED_KEY, isHostsSectionEnabled);
      location.reload();
      return;
    }

    if (myshowsDryRunToggle) {
      myshowsDryRunToggle.checked = readBooleanStorageValue(
        storage[SYNC_DRY_RUN_KEY],
        false
      );
    }

    if (myshowsSyncMode && savedMode) {
      myshowsSyncMode.value = savedMode;
    }

    if (myshowsSyncContentType && savedContentType) {
      myshowsSyncContentType.value = savedContentType;
    }

    applyMyshowsSectionEnabled(isMyshowsSectionEnabled);
    applyHostsSectionEnabled(isHostsSectionEnabled);

    const reportStorage = await chrome.storage.local.get(SYNC_REPORT_KEY);
    const report = reportStorage[SYNC_REPORT_KEY] || null;
    updateReportLink(report);
    refreshMyshowsSyncControls();

    const isRunning = report?.status === 'running';
    setSyncButtonsState(isRunning);

    if (isMyshowsSectionEnabled && isRunning && isSyncContentTypeReady()) {
      setMyshowsSyncStatus('Синхронизация уже выполняется...');
    }
  }

  if (myshowsSyncSectionToggle) {
    if (!isSidePanelUi) {
      applyMyshowsSectionEnabled(getLocalSectionEnabled(SYNC_SECTION_ENABLED_KEY));
    }

    myshowsSyncSectionToggle.addEventListener('change', async () => {
      await persistCollapsibleSection(
        SYNC_SECTION_ENABLED_KEY,
        myshowsSyncSectionToggle.checked,
        applyMyshowsSectionEnabled
      );
    });
  }

  if (hostsSectionToggle) {
    if (!isSidePanelUi) {
      applyHostsSectionEnabled(getLocalSectionEnabled(HOSTS_SECTION_ENABLED_KEY));
    }

    hostsSectionToggle.addEventListener('change', async () => {
      await persistCollapsibleSection(
        HOSTS_SECTION_ENABLED_KEY,
        hostsSectionToggle.checked,
        applyHostsSectionEnabled
      );
    });
  }

  if (myshowsSyncContentType) {
    myshowsSyncContentType.addEventListener('change', async () => {
      const contentType = getSelectedSyncContentType();
      await chrome.storage.sync.set({ [SYNC_CONTENT_TYPE_KEY]: contentType });
      refreshMyshowsSyncControls();
    });
  }

  if (myshowsDryRunToggle) {
    myshowsDryRunToggle.addEventListener('change', async () => {
      await chrome.storage.sync.set({
        [SYNC_DRY_RUN_KEY]: Boolean(myshowsDryRunToggle.checked),
      });
    });
  }

  if (myshowsReportLink) {
    myshowsReportLink.addEventListener('click', (event) => {
      if (myshowsReportLink.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('report/report.html') });
    });
  }

  if (myshowsSyncButton) {
    myshowsSyncButton.addEventListener('click', async () => {
      const contentType = getSelectedSyncContentType();
      if (!isSyncContentTypeReady(contentType)) {
        refreshMyshowsSyncControls();
        return;
      }

      const mode = myshowsSyncMode?.value || 'cache';
      setMyshowsSyncStatus('Проверка доступа...');

      try {
        const hostSettings = await getHostSettings();
        const origins = [
          MYSHOWS_ORIGIN_PATTERN,
          hostToMatchPattern(hostSettings.mainHost),
        ];

        const permissionGranted = await chrome.permissions.request({
          origins,
          permissions: ['cookies'],
        });

        if (!permissionGranted) {
          setMyshowsSyncStatus('Нужен доступ к myshows.me и Kinopub.', true);
          return;
        }

        const dryRun = Boolean(myshowsDryRunToggle?.checked);
        await chrome.storage.sync.set({
          [SYNC_MODE_KEY]: mode,
          [SYNC_CONTENT_TYPE_KEY]: contentType,
          [SYNC_DRY_RUN_KEY]: dryRun,
        });
        setMyshowsSyncStatus('Запуск...');

        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });

        if (mode === 'currentPage') {
          if (!activeTab?.id || !activeTab.url) {
            setMyshowsSyncStatus('Открой вкладку Kinopub и запусти снова.', true);
            return;
          }

          if (!isUrlMatchingHosts(activeTab.url, hostSettings.allHosts)) {
            setMyshowsSyncStatus(
              `Для режима «текущая страница» открой ${hostSettings.mainHost} или зеркало.`,
              true
            );
            return;
          }
        }

        const response = await chrome.runtime.sendMessage({
          type: 'myshows-sync-start',
          mode,
          contentType,
          dryRun,
          tabId: activeTab?.id || null,
        });

        if (!response?.ok) {
          setMyshowsSyncStatus(response?.error || 'Не удалось запустить синхронизацию.', true);
          return;
        }

        updateReportLink({ status: 'running', mode, dryRun });
        setSyncButtonsState(true);
        setMyshowsSyncStatus(
          dryRun
            ? 'Dry-run запущен. В MyShows ничего не пишем.'
            : 'Синхронизация запущена. Смотри отчёт.'
        );
        chrome.tabs.create({ url: chrome.runtime.getURL('report/report.html') });
      } catch (error) {
        console.error('Ошибка запуска синхронизации MyShows:', error);
        setMyshowsSyncStatus(error?.message || 'Не удалось запустить синхронизацию.', true);
      }
    });
  }

  if (myshowsCancelButton) {
    myshowsCancelButton.addEventListener('click', async () => {
      setMyshowsSyncStatus('Остановка...');

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'myshows-sync-cancel',
        });

        if (!response?.ok) {
          setMyshowsSyncStatus(response?.error || 'Не удалось остановить.', true);
          return;
        }

        setMyshowsSyncStatus('Останавливаю после текущего фильма...');
      } catch (error) {
        console.error('Ошибка остановки синхронизации:', error);
        setMyshowsSyncStatus(error?.message || 'Не удалось остановить.', true);
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[SCAN_PROGRESS_KEY]) {
      const progress = changes[SCAN_PROGRESS_KEY].newValue;
      if (!progress) {
        return;
      }

      if (progress.status === 'running') {
        setHostsStatus(`Скан: ${progress.processed || 0}/${progress.total || 0}`);
      } else if (progress.status === 'done') {
        setHostsStatus(
          `Готово: ${progress.processed || 0}/${progress.total || 0}` +
            (progress.failed ? `, ошибок: ${progress.failed}` : '')
        );
      }
    }

    if (areaName === 'local' && changes[SYNC_REPORT_KEY]) {
      const report = changes[SYNC_REPORT_KEY].newValue || null;
      updateReportLink(report);
      setSyncButtonsState(report?.status === 'running');

      if (!report) {
        return;
      }

      if (report.status === 'running') {
        setMyshowsSyncStatus(
          `Синхронизация... ${report.totals?.synced || 0}/${report.totals?.candidates || 0}` +
            ` (пропущено: ${report.totals?.skipped || 0})`
        );
      } else if (report.status === 'failed') {
        setMyshowsSyncStatus('Синхронизация завершилась с ошибкой.', true);
      } else if (report.status === 'cancelled') {
        setMyshowsSyncStatus(
          `Остановлено: ${report.totals?.synced || 0} синхр., ${report.totals?.skipped || 0} пропущено.`
        );
      } else if (report.status === 'done') {
        setMyshowsSyncStatus(
          `Готово: ${report.totals?.synced || 0} синхр., ${report.totals?.skipped || 0} пропущено.`
        );
      }
    }
  });

  const openOptionsButton = document.getElementById('openOptionsButton');
  const openSidePanelButton = document.getElementById('openSidePanelButton');

  if (openOptionsButton) {
    openOptionsButton.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  if (openSidePanelButton) {
    openSidePanelButton.addEventListener('click', () => {
      if (!chrome.sidePanel?.open) {
        setHostsStatus('Side panel не поддерживается в этом Chrome.', true);
        return;
      }

      // Важно: open() синхронно в обработчике клика.
      // Любой await/sendMessage до open() убивает user gesture.
      chrome.sidePanel
        .open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
        .then(() => {
          window.close();
        })
        .catch((error) => {
          console.error('Ошибка открытия side panel:', error);
          setHostsStatus(error?.message || 'Не удалось открыть боковую панель.', true);
        });
    });
  }

  await hostsForm.loadHostSettingsIntoForm();
  await loadMyshowsSyncUi();
});
