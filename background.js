importScripts('lib/hosts.js', 'lib/match-utils.js', 'lib/myshows-sync.js');

const SCAN_PROGRESS_KEY = 'kino-pub-improve-scan-progress';
const BADGE_COLOR_SCAN = '#449d44';
const BADGE_COLOR_SYNC = '#3a7bd5';

async function setActionBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text: text || '' });
  } catch (error) {
    // action API недоступен — игнорируем.
  }
}

async function updateActionBadgeFromScanProgress(progress) {
  if (!progress || progress.status !== 'running') {
    const syncReport = await chrome.storage.local.get(SYNC_REPORT_KEY);
    if (syncReport[SYNC_REPORT_KEY]?.status === 'running') {
      return;
    }

    await setActionBadge('', BADGE_COLOR_SCAN);
    return;
  }

  const processedCount = Math.min(Number(progress.processed) || 0, 999);
  await setActionBadge(String(processedCount), BADGE_COLOR_SCAN);
}

async function updateActionBadgeFromSyncReport(report) {
  if (report?.status === 'running') {
    const syncedCount = Math.min(Number(report.totals?.synced) || 0, 999);
    await setActionBadge(syncedCount > 0 ? String(syncedCount) : '.', BADGE_COLOR_SYNC);
    return;
  }

  const scanStorage = await chrome.storage.local.get(SCAN_PROGRESS_KEY);
  await updateActionBadgeFromScanProgress(scanStorage[SCAN_PROGRESS_KEY]);
}

async function registerContentScriptsForHosts(hosts) {
  const matchPatterns = hosts.map(hostToMatchPattern);

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (error) {
    // Скрипт ещё не был зарегистрирован — это нормально при первом запуске.
  }

  if (matchPatterns.length === 0) {
    return;
  }

  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: ['lib/hosts.js', 'lib/match-utils.js', 'content-scripts/content.js'],
      css: ['content-scripts/styles.css'],
      matches: matchPatterns,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

async function syncContentScripts() {
  const hostSettings = await getHostSettings();
  await registerContentScriptsForHosts(hostSettings.allHosts);
  return hostSettings;
}

async function ensureDefaultHostSettings() {
  const storageItems = await chrome.storage.sync.get([
    STORAGE_KEYS.mainHost,
    STORAGE_KEYS.mirrorHosts,
  ]);

  const updates = {};

  if (!normalizeHost(storageItems[STORAGE_KEYS.mainHost])) {
    updates[STORAGE_KEYS.mainHost] = DEFAULT_MAIN_HOST;
  }

  if (!Array.isArray(storageItems[STORAGE_KEYS.mirrorHosts])) {
    updates[STORAGE_KEYS.mirrorHosts] = [];
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }
}

async function ensureSidePanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  // Клик по иконке открывает обычный popup; side panel — по кнопке из UI.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}

ensureDefaultHostSettings()
  .then(syncContentScripts)
  .then(() => ensureSidePanelBehavior())
  .then(() => maybeResumeInterruptedSync())
  .catch((error) => {
    console.error('Не удалось инициализировать content scripts:', error);
  });

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultHostSettings();
  await syncContentScripts();
  await ensureSidePanelBehavior();
  await maybeResumeInterruptedSync();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaultHostSettings();
  await syncContentScripts();
  await ensureSidePanelBehavior();
  await maybeResumeInterruptedSync();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local') {
    if (changes[SCAN_PROGRESS_KEY]) {
      await updateActionBadgeFromScanProgress(changes[SCAN_PROGRESS_KEY].newValue);
    }

    if (changes[SYNC_REPORT_KEY]) {
      await updateActionBadgeFromSyncReport(changes[SYNC_REPORT_KEY].newValue);
    }

    return;
  }

  if (areaName !== 'sync') {
    return;
  }

  if (changes[STORAGE_KEYS.mainHost] || changes[STORAGE_KEYS.mirrorHosts]) {
    await syncContentScripts();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'sync-hosts') {
    (async () => {
      try {
        const mainHostInput = message.mainHost;
        const mirrorHostsInput = message.mirrorHosts || [];
        const normalizedSettings = await saveHostSettings(mainHostInput, mirrorHostsInput);
        await syncContentScripts();
        sendResponse({
          ok: true,
          settings: normalizedSettings,
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || 'Не удалось сохранить URL.',
        });
      }
    })();

    return true;
  }

  if (message?.type === 'myshows-sync-start') {
    (async () => {
      try {
        if (isSyncRunning()) {
          sendResponse({
            ok: false,
            error: 'Синхронизация уже выполняется.',
          });
          return;
        }

        const contentType = message.contentType || 'movies';
        if (contentType !== 'movies') {
          sendResponse({
            ok: false,
            error: 'Этот вариант синхронизации пока в разработке.',
          });
          return;
        }

        const mode = message.mode || SYNC_MODES.cache;
        const tabId = message.tabId || null;
        const dryRun = Boolean(message.dryRun);
        await chrome.storage.sync.set({
          [SYNC_MODE_KEY]: mode,
          [SYNC_CONTENT_TYPE_KEY]: contentType,
        });

        const syncPromise = syncWatchedMoviesToMyShows(mode, { tabId, dryRun });
        syncPromise.catch((error) => {
          console.error('MyShows sync failed:', error);
        });

        // Ждём появления report в storage (или быстрый fail до/после создания).
        const waitStartedAt = Date.now();
        while (Date.now() - waitStartedAt < 4000) {
          const reportStorage = await chrome.storage.local.get(SYNC_REPORT_KEY);
          const report = reportStorage[SYNC_REPORT_KEY];

          if (report?.status === 'failed' && !isSyncRunning()) {
            sendResponse({
              ok: false,
              error:
                report.errors?.[report.errors.length - 1]?.message ||
                'Не удалось запустить синхронизацию.',
            });
            return;
          }

          if (
            report?.status === 'running' ||
            report?.status === 'done' ||
            report?.status === 'cancelled'
          ) {
            sendResponse({
              ok: true,
              started: true,
            });
            return;
          }

          await new Promise((resolve) => setTimeout(resolve, 40));
        }

        sendResponse({
          ok: true,
          started: true,
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || 'Не удалось запустить синхронизацию.',
        });
      }
    })();

    return true;
  }

  if (message?.type === 'myshows-sync-cancel') {
    (async () => {
      if (isSyncRunning()) {
        requestSyncCancel();
        sendResponse({
          ok: true,
          cancelling: true,
        });
        return;
      }

      // Залипший running после убийства service worker — снимаем блокировку UI.
      try {
        const reportStorage = await chrome.storage.local.get(SYNC_REPORT_KEY);
        const report = reportStorage[SYNC_REPORT_KEY];
        const existingState = await loadSyncState();

        if (report?.status === 'running') {
          const finalizedStuck = await finalizeStuckRunningSync(report, existingState);
          if (finalizedStuck) {
            sendResponse({
              ok: true,
              finalized: true,
            });
            return;
          }

          report.status = 'cancelled';
          report.finishedAt = new Date().toISOString();
          pushError(report, {
            message: 'Синхронизация остановлена после прерывания.',
          });
          await saveSyncReport(report);
          await clearSyncState();
          sendResponse({
            ok: true,
            cancelled: true,
          });
          return;
        }
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || 'Не удалось остановить синхронизацию.',
        });
        return;
      }

      sendResponse({
        ok: false,
        error: 'Сейчас нет активной синхронизации.',
      });
    })();

    return true;
  }

  if (message?.type === 'myshows-sync-get-report') {
    (async () => {
      const storage = await chrome.storage.local.get(SYNC_REPORT_KEY);
      sendResponse({
        ok: true,
        report: storage[SYNC_REPORT_KEY] || null,
        running: isSyncRunning(),
      });
    })();

    return true;
  }

  if (message?.type === 'myshows-mark-ambiguous') {
    (async () => {
      try {
        const report = await markAmbiguousCandidateAsFinished({
          movieId: message.movieId,
          itemId: message.itemId,
          candidateTitle: message.candidateTitle,
        });
        sendResponse({
          ok: true,
          report,
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || 'Не удалось отметить фильм в MyShows.',
        });
      }
    })();

    return true;
  }

  return false;
});
