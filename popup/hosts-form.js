/**
 * Общая форма «Сайты» для popup / side panel / options.
 * Ожидает глобальные helpers из lib/hosts.js.
 */
function initHostsForm({
  mainHostInput,
  mirrorHostInput,
  addMirrorButton,
  mirrorsList,
  saveHostsButton,
  setStatus,
}) {
  let draftMirrorHosts = [];

  function renderMirrorsList() {
    if (!mirrorsList) {
      return;
    }

    mirrorsList.innerHTML = '';

    if (draftMirrorHosts.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-mirrors';
      emptyState.textContent = 'Зеркала не добавлены';
      mirrorsList.appendChild(emptyState);
      return;
    }

    for (const mirrorHost of draftMirrorHosts) {
      const mirrorItem = document.createElement('div');
      mirrorItem.className = 'mirror-item';

      const mirrorLabel = document.createElement('span');
      mirrorLabel.textContent = mirrorHost;
      mirrorLabel.title = mirrorHost;

      const removeButton = document.createElement('button');
      removeButton.className = 'danger';
      removeButton.type = 'button';
      removeButton.textContent = 'Удалить';
      removeButton.addEventListener('click', () => {
        draftMirrorHosts = draftMirrorHosts.filter((host) => host !== mirrorHost);
        renderMirrorsList();
        setStatus('');
      });

      mirrorItem.appendChild(mirrorLabel);
      mirrorItem.appendChild(removeButton);
      mirrorsList.appendChild(mirrorItem);
    }
  }

  async function loadHostSettingsIntoForm() {
    if (!mainHostInput) {
      return;
    }

    const hostSettings = await getHostSettings();
    mainHostInput.value = hostSettings.mainHost;
    draftMirrorHosts = [...hostSettings.mirrorHosts];
    renderMirrorsList();
  }

  if (addMirrorButton && mirrorHostInput && mainHostInput) {
    addMirrorButton.addEventListener('click', () => {
      const normalizedMirrorHost = normalizeHost(mirrorHostInput.value);
      if (!normalizedMirrorHost) {
        setStatus('Некорректный URL зеркала.', true);
        return;
      }

      const currentMainHost = normalizeHost(mainHostInput.value) || DEFAULT_MAIN_HOST;
      if (normalizedMirrorHost === currentMainHost) {
        setStatus('Зеркало совпадает с основным URL.', true);
        return;
      }

      if (draftMirrorHosts.includes(normalizedMirrorHost)) {
        setStatus('Такое зеркало уже добавлено.', true);
        return;
      }

      draftMirrorHosts.push(normalizedMirrorHost);
      mirrorHostInput.value = '';
      renderMirrorsList();
      setStatus('');
    });
  }

  if (saveHostsButton && mainHostInput) {
    saveHostsButton.addEventListener('click', async () => {
      const normalizedMainHost = normalizeHost(mainHostInput.value);
      if (!normalizedMainHost) {
        setStatus('Некорректный основной URL.', true);
        return;
      }

      const hostsToSave = [
        normalizedMainHost,
        ...draftMirrorHosts.filter((host) => host !== normalizedMainHost),
      ];
      const origins = hostsToSave.map(hostToMatchPattern);

      setStatus('Запрос доступа...');

      try {
        const permissionGranted = await chrome.permissions.request({ origins });
        if (!permissionGranted) {
          setStatus('Нужно разрешить доступ к указанным сайтам.', true);
          return;
        }

        setStatus('Сохранение...');

        const response = await chrome.runtime.sendMessage({
          type: 'sync-hosts',
          mainHost: normalizedMainHost,
          mirrorHosts: draftMirrorHosts,
        });

        if (!response?.ok) {
          setStatus(response?.error || 'Не удалось сохранить URL.', true);
          return;
        }

        mainHostInput.value = response.settings.mainHost;
        draftMirrorHosts = [...response.settings.mirrorHosts];
        renderMirrorsList();
        setStatus('URL сохранены. Перезагрузите вкладки сайта.');
      } catch (error) {
        console.error('Ошибка при сохранении URL:', error);
        setStatus(error?.message || 'Не удалось сохранить URL.', true);
      }
    });
  }

  return {
    loadHostSettingsIntoForm,
  };
}
