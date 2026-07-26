const SYNC_REPORT_KEY = 'kino-pub-improve-myshows-report';
const SKIP_FILTERS_STORAGE_KEY = 'kino-pub-improve-myshows-report-skip-filters';

const MODE_LABELS = {
  cache: 'Кэш расширения',
  currentPage: 'Текущая страница',
  history: 'История Kinopub',
};

const REASON_LABELS = {
  'not-movie': 'Не фильм (сериал и т.п.)',
  'not-watched-on-kino': 'Не отмечен просмотренным на Kinopub',
  'not-found': 'Не найден в MyShows',
  ambiguous: 'Несколько совпадений — нужен ручной разбор',
  'already-finished': 'Уже finished в MyShows',
};

const SKIP_FILTER_OPTIONS = [
  {
    reason: 'ambiguous',
    label: 'Несколько совпадений — нужен ручной разбор',
  },
  {
    reason: 'not-found',
    label: 'Не найден в MyShows',
  },
  {
    reason: 'not-movie',
    label: 'Не фильм (сериал и т.п.)',
  },
  {
    reason: 'already-finished',
    label: 'Уже finished в MyShows',
  },
  {
    reason: 'not-watched-on-kino',
    label: 'Не отмечен просмотренным на Kinopub',
  },
];

let currentReport = null;
let activeSkipFilters = loadSkipFilters();
let isMarkingCandidate = false;

function loadSkipFilters() {
  try {
    const rawValue = sessionStorage.getItem(SKIP_FILTERS_STORAGE_KEY);
    if (!rawValue) {
      return new Set();
    }

    const parsedValue = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) {
      return new Set();
    }

    return new Set(
      parsedValue.filter((reason) =>
        SKIP_FILTER_OPTIONS.some((option) => option.reason === reason)
      )
    );
  } catch (error) {
    return new Set();
  }
}

function saveSkipFilters() {
  try {
    sessionStorage.setItem(
      SKIP_FILTERS_STORAGE_KEY,
      JSON.stringify([...activeSkipFilters])
    );
  } catch (error) {
    // sessionStorage может быть недоступен.
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDate(value) {
  if (!value) {
    return '—';
  }

  try {
    return new Date(value).toLocaleString('ru-RU');
  } catch (error) {
    return value;
  }
}

function renderLink(url, label) {
  if (!url) {
    return escapeHtml(label || '—');
  }

  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
    label || url
  )}</a>`;
}

function renderCandidates(candidates, skippedItem) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return '';
  }

  const itemId = skippedItem?.itemId || '';
  const items = candidates
    .map((candidate) => {
      const title = [candidate.title, candidate.titleOriginal, candidate.year]
        .filter(Boolean)
        .join(' / ');
      const label = title || `movie ${candidate.id}`;
      const markButton =
        skippedItem?.reason === 'ambiguous' && candidate.id
          ? `<button
              type="button"
              class="mark-candidate"
              data-item-id="${escapeHtml(itemId)}"
              data-movie-id="${escapeHtml(candidate.id)}"
              data-candidate-title="${escapeHtml(label)}"
            >Отметить</button>`
          : '';

      return `<li>
        ${renderLink(candidate.url, label)}
        ${markButton}
      </li>`;
    })
    .join('');

  return `<ul class="candidates">${items}</ul>`;
}

function countSkippedByReason(skippedItems, reason) {
  return skippedItems.filter((item) => item.reason === reason).length;
}

function getFilteredSkippedItems(skippedItems) {
  if (activeSkipFilters.size === 0) {
    return skippedItems;
  }

  return skippedItems.filter((item) => activeSkipFilters.has(item.reason));
}

function renderSkipFilters(skippedItems) {
  const filtersElement = document.getElementById('skippedFilters');
  const filterCountElement = document.getElementById('skippedFilterCount');

  if (!filtersElement || !filterCountElement) {
    return;
  }

  filtersElement.innerHTML = SKIP_FILTER_OPTIONS.map((option) => {
    const isActive = activeSkipFilters.has(option.reason);
    const reasonCount = countSkippedByReason(skippedItems, option.reason);

    return `
      <label class="filter-toggle ${isActive ? 'is-active' : ''}">
        <input
          type="checkbox"
          data-skip-filter="${escapeHtml(option.reason)}"
          ${isActive ? 'checked' : ''}
        />
        <span>${escapeHtml(option.label)}</span>
        <span class="muted">${reasonCount}</span>
      </label>
    `;
  }).join('');

  filtersElement.querySelectorAll('input[data-skip-filter]').forEach((inputElement) => {
    inputElement.addEventListener('change', () => {
      const reason = inputElement.getAttribute('data-skip-filter');
      if (!reason) {
        return;
      }

      if (inputElement.checked) {
        activeSkipFilters.add(reason);
      } else {
        activeSkipFilters.delete(reason);
      }

      saveSkipFilters();
      renderReport(currentReport);
    });
  });

  const filteredItems = getFilteredSkippedItems(skippedItems);
  if (activeSkipFilters.size === 0) {
    filterCountElement.textContent = `Показаны все пропуски: ${skippedItems.length}`;
  } else {
    filterCountElement.textContent = `Показано: ${filteredItems.length} из ${skippedItems.length}`;
  }
}

function renderSkippedTable(skippedItems) {
  if (!skippedItems.length) {
    return '<div class="empty">По выбранным фильтрам ничего нет.</div>';
  }

  const rows = skippedItems
    .map((item) => {
      const reason = REASON_LABELS[item.reason] || item.reason || '—';
      const title = item.title || item.itemId || '—';
      const details = [];

      if (item.year) {
        details.push(`год: ${escapeHtml(item.year)}`);
      }
      if (item.titleOriginal) {
        details.push(`original: ${escapeHtml(item.titleOriginal)}`);
      }
      if (item.kinopoiskId) {
        details.push(`КП: ${escapeHtml(item.kinopoiskId)}`);
      }
      if (item.imdbId) {
        details.push(`IMDb: ${escapeHtml(item.imdbId)}`);
      }
      if (item.matchMethod) {
        details.push(`матч: ${escapeHtml(item.matchMethod)}`);
      }
      if (item.query) {
        details.push(`запрос: ${escapeHtml(item.query)}`);
      }
      if (Array.isArray(item.queries) && item.queries.length) {
        details.push(`запросы: ${escapeHtml(item.queries.join(' | '))}`);
      }

      return `
        <tr>
          <td class="reason">${escapeHtml(reason)}</td>
          <td>
            ${renderLink(item.url, title)}
            ${item.myshowsUrl ? `<div>${renderLink(item.myshowsUrl, 'MyShows')}</div>` : ''}
            ${details.length ? `<div class="muted">${details.join(' · ')}</div>` : ''}
            ${renderCandidates(item.candidates, item)}
          </td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Причина</th>
          <th>Ссылки</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderErrorsTable(errorItems) {
  if (!errorItems.length) {
    return '<div class="empty">Ошибок нет.</div>';
  }

  const rows = errorItems
    .map((item) => {
      const title = item.itemId || 'Общая ошибка';
      return `
        <tr>
          <td>${renderLink(item.url, title)}</td>
          <td>${escapeHtml(item.message || '—')}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Элемент</th>
          <th>Сообщение</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSyncedTable(syncedItems) {
  if (!syncedItems.length) {
    return '<div class="empty">Пока ничего не отмечено.</div>';
  }

  const rows = syncedItems
    .map((item) => {
      const title = item.title || item.itemId || '—';
      const matchDetails = [];

      if (item.matchMethod) {
        matchDetails.push(item.matchMethod);
      }
      if (item.kinopoiskId) {
        matchDetails.push(`КП ${item.kinopoiskId}`);
      }
      if (item.imdbId) {
        matchDetails.push(item.imdbId);
      }

      const queryLabel = item.query || '—';
      const queryCell = matchDetails.length
        ? `${escapeHtml(queryLabel)}<div class="muted">${escapeHtml(matchDetails.join(' · '))}</div>`
        : escapeHtml(queryLabel);

      return `
        <tr>
          <td>${renderLink(item.url, title)}</td>
          <td>${renderLink(item.myshowsUrl, item.myshowsId ? `movie ${item.myshowsId}` : 'MyShows')}</td>
          <td class="muted">${queryCell}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Kinopub</th>
          <th>MyShows</th>
          <th>Запрос</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function getStatusClass(status) {
  if (status === 'running') {
    return 'status-running';
  }

  if (status === 'failed' || status === 'cancelled') {
    return 'status-failed';
  }

  return 'status-done';
}

function renderReport(report) {
  currentReport = report;

  const metaElement = document.getElementById('meta');
  const summaryElement = document.getElementById('summary');
  const skippedElement = document.getElementById('skipped');
  const errorsElement = document.getElementById('errors');
  const syncedElement = document.getElementById('synced');

  if (!report) {
    metaElement.textContent = 'Отчёт ещё не создан. Запусти синхронизацию из popup расширения.';
    summaryElement.innerHTML = '';
    renderSkipFilters([]);
    skippedElement.innerHTML = '<div class="empty">Нет данных.</div>';
    errorsElement.innerHTML = '<div class="empty">Нет данных.</div>';
    syncedElement.innerHTML = '<div class="empty">Нет данных.</div>';
    return;
  }

  const statusClass = getStatusClass(report.status);

  metaElement.innerHTML = `
    Режим: <strong>${escapeHtml(MODE_LABELS[report.mode] || report.mode)}</strong> ·
    Статус: <strong class="${statusClass}">${escapeHtml(report.status)}</strong>
    ${report.dryRun ? ' · <strong class="status-running">dry-run</strong>' : ''}
    ${report.kinoOrigin ? `<br>Kinopub: ${escapeHtml(report.kinoOrigin)}` : ''}<br>
    Старт: ${escapeHtml(formatDate(report.startedAt))} ·
    Финиш: ${escapeHtml(formatDate(report.finishedAt))}
  `;

  const totals = report.totals || {};
  const syncedLabel = report.dryRun ? 'Будет отмечено' : 'Синхронизировано';
  summaryElement.innerHTML = `
    <div class="chip">Кандидаты<strong>${totals.candidates || 0}</strong></div>
    <div class="chip">Фильмы<strong>${totals.movies || 0}</strong></div>
    <div class="chip">${syncedLabel}<strong>${totals.synced || 0}</strong></div>
    <div class="chip">Пропущено<strong>${totals.skipped || 0}</strong></div>
    <div class="chip">Ошибки<strong>${totals.errors || 0}</strong></div>
  `;

  const syncedHeadingElement = document.getElementById('syncedHeading');
  if (syncedHeadingElement) {
    syncedHeadingElement.textContent = report.dryRun
      ? 'Будет отмечено (dry-run, в MyShows не писали)'
      : 'Успешно отмечено';
  }

  const skippedItems = report.skipped || [];
  renderSkipFilters(skippedItems);
  skippedElement.innerHTML = renderSkippedTable(getFilteredSkippedItems(skippedItems));
  errorsElement.innerHTML = renderErrorsTable(report.errors || []);
  syncedElement.innerHTML = renderSyncedTable(report.synced || []);
}

async function markCandidateFromButton(buttonElement) {
  if (isMarkingCandidate) {
    return;
  }

  const movieId = buttonElement.getAttribute('data-movie-id');
  const itemId = buttonElement.getAttribute('data-item-id');
  const candidateTitle = buttonElement.getAttribute('data-candidate-title') || '';

  if (!movieId || !itemId) {
    return;
  }

  const confirmed = window.confirm(
    `Отметить в MyShows как finished?\n\n${candidateTitle || `movie ${movieId}`}`
  );
  if (!confirmed) {
    return;
  }

  isMarkingCandidate = true;
  buttonElement.disabled = true;
  buttonElement.textContent = '...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'myshows-mark-ambiguous',
      movieId,
      itemId,
      candidateTitle,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Не удалось отметить фильм.');
    }

    renderReport(response.report || currentReport);
  } catch (error) {
    buttonElement.disabled = false;
    buttonElement.textContent = 'Отметить';
    window.alert(error?.message || 'Не удалось отметить фильм.');
  } finally {
    isMarkingCandidate = false;
  }
}

document.addEventListener('click', (event) => {
  const buttonElement = event.target.closest?.('.mark-candidate');
  if (!buttonElement) {
    return;
  }

  event.preventDefault();
  markCandidateFromButton(buttonElement);
});

async function loadReport() {
  const storage = await chrome.storage.local.get(SYNC_REPORT_KEY);
  renderReport(storage[SYNC_REPORT_KEY] || null);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[SYNC_REPORT_KEY]) {
    renderReport(changes[SYNC_REPORT_KEY].newValue || null);
  }
});

loadReport();
