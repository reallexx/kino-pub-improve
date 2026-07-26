document.addEventListener('DOMContentLoaded', async () => {
  const unwatchedTtlInput = document.getElementById('unwatchedTtlInput');
  const scanBatchSizeInput = document.getElementById('scanBatchSizeInput');
  const syncDelayInput = document.getElementById('syncDelayInput');
  const myshowsRpcDelayInput = document.getElementById('myshowsRpcDelayInput');
  const saveRuntimeSettingsButton = document.getElementById('saveRuntimeSettingsButton');
  const optionsStatus = document.getElementById('optionsStatus');
  const hostsStatus = document.getElementById('hostsStatus');

  function setStatus(message, isError = false) {
    if (!optionsStatus) {
      return;
    }

    optionsStatus.textContent = message || '';
    optionsStatus.classList.toggle('error', Boolean(isError && message));
  }

  function setHostsStatus(message, isError = false) {
    if (!hostsStatus) {
      return;
    }

    hostsStatus.textContent = message || '';
    hostsStatus.classList.toggle('error', Boolean(isError && message));
  }

  const hostsForm = initHostsForm({
    mainHostInput: document.getElementById('mainHostInput'),
    mirrorHostInput: document.getElementById('mirrorHostInput'),
    addMirrorButton: document.getElementById('addMirrorButton'),
    mirrorsList: document.getElementById('mirrorsList'),
    saveHostsButton: document.getElementById('saveHostsButton'),
    setStatus: setHostsStatus,
  });

  async function loadRuntimeSettingsIntoForm() {
    const runtimeSettings = await getRuntimeSettings();
    unwatchedTtlInput.value = String(runtimeSettings.unwatchedTtlHours);
    scanBatchSizeInput.value = String(runtimeSettings.scanBatchSize);
    syncDelayInput.value = String(runtimeSettings.syncDelayMs);
    myshowsRpcDelayInput.value = String(runtimeSettings.myshowsRpcDelayMs);
  }

  saveRuntimeSettingsButton.addEventListener('click', async () => {
    try {
      const savedSettings = await saveRuntimeSettings({
        unwatchedTtlHours: Number(unwatchedTtlInput.value),
        scanBatchSize: Number(scanBatchSizeInput.value),
        syncDelayMs: Number(syncDelayInput.value),
        myshowsRpcDelayMs: Number(myshowsRpcDelayInput.value),
      });
      await loadRuntimeSettingsIntoForm();
      setStatus(
        `Сохранено: батч ${savedSettings.scanBatchSize}, TTL ${savedSettings.unwatchedTtlHours}ч, sync ${savedSettings.syncDelayMs}мс.`
      );
    } catch (error) {
      console.error('Ошибка сохранения настроек:', error);
      setStatus(error?.message || 'Не удалось сохранить настройки.', true);
    }
  });

  await Promise.all([
    hostsForm.loadHostSettingsIntoForm(),
    loadRuntimeSettingsIntoForm(),
  ]);
});
