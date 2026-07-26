/**
 * Чистые хелперы матчинга/парсинга Kinopub ↔ MyShows.
 * Работает и в service worker (importScripts), и в Node-тестах (module.exports).
 */

const MATCH_UTILS_MYSHOWS_ORIGIN = 'https://myshows.me';

function extractBalancedJson(sourceText, startIndex) {
  const openCharacter = sourceText[startIndex];
  const closeCharacter = openCharacter === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < sourceText.length; index += 1) {
    const character = sourceText[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === '\\') {
        isEscaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === openCharacter) {
      depth += 1;
    } else if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return sourceText.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseWindowJsonAssignment(htmlText, variableName) {
  const marker = `window.${variableName}`;
  const markerIndex = htmlText.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const equalsIndex = htmlText.indexOf('=', markerIndex + marker.length);
  if (equalsIndex === -1) {
    return null;
  }

  let valueStartIndex = equalsIndex + 1;
  while (valueStartIndex < htmlText.length && /\s/.test(htmlText[valueStartIndex])) {
    valueStartIndex += 1;
  }

  const openCharacter = htmlText[valueStartIndex];
  if (openCharacter !== '[' && openCharacter !== '{') {
    return null;
  }

  const jsonText = extractBalancedJson(htmlText, valueStartIndex);
  if (!jsonText) {
    return null;
  }

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    return null;
  }
}

function splitKinoTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return { titleRu: '', titleOriginal: '' };
  }

  const parts = rawTitle.split(' / ').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      titleRu: parts[0],
      titleOriginal: parts.slice(1).join(' / '),
    };
  }

  return {
    titleRu: rawTitle.trim(),
    titleOriginal: '',
  };
}

function extractYearFromHtml(htmlText, playlist) {
  const playlistYear = Number(playlist?.[0]?.yeaer || playlist?.[0]?.year);
  if (playlistYear) {
    return playlistYear;
  }

  const yearLinkMatch = htmlText.match(/\/(?:movie|serial)\?years=(\d{4})/);
  if (yearLinkMatch) {
    return Number(yearLinkMatch[1]);
  }

  const yearRowMatch = htmlText.match(/Год выхода[\s\S]*?>(\d{4})</i);
  if (yearRowMatch) {
    return Number(yearRowMatch[1]);
  }

  return null;
}

function isKinoMovie(htmlText, seasons) {
  if (/\/serial\?years=/i.test(htmlText)) {
    return false;
  }

  if (Array.isArray(seasons) && seasons.some((season) => Number(season.season) >= 1)) {
    return false;
  }

  if (/Всего\s*<\/strong>[\s\S]*?сезон/i.test(htmlText)) {
    return false;
  }

  if (/id="watchlist-subscription"/i.test(htmlText)) {
    return false;
  }

  if (/\/movie\?years=/i.test(htmlText)) {
    return true;
  }

  if (Array.isArray(seasons) && seasons.length === 1 && Number(seasons[0].season) === 0) {
    return true;
  }

  return true;
}

function isKinoItemWatched(playlist, seasons) {
  if (Array.isArray(playlist) && playlist.some((item) => Number(item.completed) === 1)) {
    return true;
  }

  if (
    Array.isArray(seasons) &&
    seasons.length > 0 &&
    seasons.every((season) => season.allWatched === true)
  ) {
    return true;
  }

  return false;
}

function normalizeImdbId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalizedValue = String(value).trim().toLowerCase();
  if (/^tt\d+$/.test(normalizedValue)) {
    return normalizedValue;
  }

  if (/^\d+$/.test(normalizedValue)) {
    return `tt${normalizedValue}`;
  }

  return null;
}

function normalizeKinopoiskId(value) {
  const numericId = Number(value);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return null;
  }

  return numericId;
}

function extractExternalIdsFromHtml(htmlText) {
  const kinopoiskMatch = String(htmlText || '').match(/kinopoisk\.ru\/film\/(\d+)/i);
  const imdbMatch = String(htmlText || '').match(/imdb\.com\/title\/(tt\d+)/i);

  return {
    kinopoiskId: kinopoiskMatch ? normalizeKinopoiskId(kinopoiskMatch[1]) : null,
    imdbId: imdbMatch ? normalizeImdbId(imdbMatch[1]) : null,
  };
}

function hasExternalIds(movieDetails) {
  return Boolean(movieDetails?.kinopoiskId || movieDetails?.imdbId);
}

function normalizeTitleForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isMostlyLatinTitle(value) {
  const letters = String(value || '').match(/\p{L}/gu) || [];
  if (letters.length === 0) {
    return false;
  }

  const latinLetters = letters.filter((letter) => /[a-z]/i.test(letter));
  return latinLetters.length / letters.length >= 0.6;
}

/**
 * Mortal Kombat II -> Mortal Kombat 2.
 * Одиночную I меняем только не в начале строки, чтобы не ломать "I Am Legend".
 */
function replaceRomanNumeralsWithArabic(title) {
  if (!title) {
    return title;
  }

  const romanTokens = [
    ['XXXVIII', '38'],
    ['XXXVII', '37'],
    ['XXXVI', '36'],
    ['XXXV', '35'],
    ['XXXIV', '34'],
    ['XXXIII', '33'],
    ['XXXII', '32'],
    ['XXXI', '31'],
    ['XXX', '30'],
    ['XXVIII', '28'],
    ['XXVII', '27'],
    ['XXVI', '26'],
    ['XXV', '25'],
    ['XXIV', '24'],
    ['XXIII', '23'],
    ['XXII', '22'],
    ['XXI', '21'],
    ['XX', '20'],
    ['XVIII', '18'],
    ['XVII', '17'],
    ['XVI', '16'],
    ['XV', '15'],
    ['XIV', '14'],
    ['XIII', '13'],
    ['XII', '12'],
    ['XI', '11'],
    ['VIII', '8'],
    ['VII', '7'],
    ['VI', '6'],
    ['IV', '4'],
    ['IX', '9'],
    ['III', '3'],
    ['II', '2'],
    ['X', '10'],
    ['V', '5'],
  ];

  let convertedTitle = String(title);

  for (const [romanToken, arabicValue] of romanTokens) {
    const romanPattern = new RegExp(`\\b${romanToken}\\b`, 'gi');
    convertedTitle = convertedTitle.replace(romanPattern, arabicValue);
  }

  convertedTitle = convertedTitle.replace(/(?<=\S\s)I\b/g, '1');

  return convertedTitle.replace(/\s+/g, ' ').trim();
}

function expandTitleQueryVariants(title) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) {
    return [];
  }

  const variants = [normalizedTitle];
  const arabicVariant = replaceRomanNumeralsWithArabic(normalizedTitle);

  if (arabicVariant && arabicVariant !== normalizedTitle) {
    variants.push(arabicVariant);
  }

  return variants;
}

function appendTitleQueries(queries, title, yearSuffix) {
  for (const titleVariant of expandTitleQueryVariants(title)) {
    if (yearSuffix) {
      queries.push(`${titleVariant}${yearSuffix}`.trim());
    }
    queries.push(titleVariant);
  }
}

function buildSearchQueries(movieDetails) {
  const queries = [];
  const yearSuffix = movieDetails.year ? ` ${movieDetails.year}` : '';
  const originalTitle = (movieDetails.titleOriginal || '').trim();
  const russianTitle = (movieDetails.titleRu || '').trim();
  const hasDistinctOriginal =
    Boolean(originalTitle) &&
    normalizeTitleForMatch(originalTitle) !== normalizeTitleForMatch(russianTitle);

  if (hasDistinctOriginal) {
    appendTitleQueries(queries, originalTitle, yearSuffix);
  }

  if (russianTitle) {
    appendTitleQueries(queries, russianTitle, yearSuffix);
  }

  if (!hasDistinctOriginal && isMostlyLatinTitle(russianTitle) && yearSuffix) {
    queries.unshift(`${russianTitle}${yearSuffix}`.trim());
  }

  return [...new Set(queries.filter(Boolean))];
}

function titlesMatchLoosely(leftTitle, rightTitle) {
  const leftNormalized = normalizeTitleForMatch(replaceRomanNumeralsWithArabic(leftTitle));
  const rightNormalized = normalizeTitleForMatch(replaceRomanNumeralsWithArabic(rightTitle));
  return Boolean(leftNormalized) && leftNormalized === rightNormalized;
}

function pickExactTitleMatches(movies, movieDetails) {
  if (movieDetails.titleOriginal) {
    const exactOriginalMatches = movies.filter((movie) => {
      return (
        titlesMatchLoosely(movie.titleOriginal, movieDetails.titleOriginal) ||
        titlesMatchLoosely(movie.title, movieDetails.titleOriginal)
      );
    });

    if (exactOriginalMatches.length > 0) {
      return exactOriginalMatches;
    }
  }

  if (movieDetails.titleRu) {
    const exactRussianMatches = movies.filter((movie) => {
      return (
        titlesMatchLoosely(movie.title, movieDetails.titleRu) ||
        titlesMatchLoosely(movie.titleOriginal, movieDetails.titleRu)
      );
    });

    if (exactRussianMatches.length > 0) {
      return exactRussianMatches;
    }
  }

  return [];
}

function extractMoviesFromCatalog(catalogResult) {
  const catalogItems = Array.isArray(catalogResult)
    ? catalogResult
    : catalogResult?.items || catalogResult?.movies || [];

  return catalogItems
    .map((entry) => entry.movie || entry)
    .filter((movie) => movie?.id);
}

function mapCandidatesForReport(movies, myshowsOrigin = MATCH_UTILS_MYSHOWS_ORIGIN) {
  return movies.slice(0, 8).map((movie) => ({
    id: movie.id,
    title: movie.title,
    titleOriginal: movie.titleOriginal,
    year: movie.year,
    url: `${myshowsOrigin}/movie/${movie.id}/`,
  }));
}

function pickMyShowsMovieMatch(
  catalogResult,
  movieDetails,
  myshowsOrigin = MATCH_UTILS_MYSHOWS_ORIGIN
) {
  const movies = extractMoviesFromCatalog(catalogResult);

  if (movies.length === 0) {
    return { status: 'not-found' };
  }

  let candidatePool = movies;

  if (movieDetails.year) {
    const yearMatched = movies.filter(
      (movie) => Number(movie.year) === Number(movieDetails.year)
    );

    if (yearMatched.length === 0) {
      return { status: 'not-found' };
    }

    candidatePool = yearMatched;
  }

  if (candidatePool.length > 1) {
    const exactMatches = pickExactTitleMatches(candidatePool, movieDetails);
    if (exactMatches.length > 0) {
      candidatePool = exactMatches;
    }
  }

  if (candidatePool.length !== 1) {
    return {
      status: 'ambiguous',
      candidates: mapCandidatesForReport(candidatePool, myshowsOrigin),
    };
  }

  return {
    status: 'matched',
    movie: candidatePool[0],
  };
}

function movieMatchesExternalIds(myShowsMovie, movieDetails) {
  const myShowsKinopoiskId = normalizeKinopoiskId(myShowsMovie?.kinopoiskId);
  if (
    movieDetails.kinopoiskId &&
    myShowsKinopoiskId &&
    myShowsKinopoiskId === movieDetails.kinopoiskId
  ) {
    return 'kinopoisk';
  }

  const myShowsImdbId = normalizeImdbId(myShowsMovie?.imdbId);
  if (movieDetails.imdbId && myShowsImdbId && myShowsImdbId === movieDetails.imdbId) {
    return 'imdb';
  }

  return null;
}

function myShowsMovieHasExternalIds(myShowsMovie) {
  return Boolean(
    normalizeKinopoiskId(myShowsMovie?.kinopoiskId) || normalizeImdbId(myShowsMovie?.imdbId)
  );
}

const WATCHED_HTML_PROBE_MAX_CHARS = 1_500_000;

function hasPositiveWatchedStringMarker(htmlText) {
  if (typeof htmlText !== 'string' || !htmlText) {
    return false;
  }

  return (
    htmlText.includes('fa fa-eye-slash') ||
    htmlText.includes('fa-eye-slash') ||
    htmlText.includes('"completed":1') ||
    htmlText.includes('"completed": 1') ||
    htmlText.includes('"allWatched":true') ||
    htmlText.includes('"allWatched": true') ||
    htmlText.includes('is-completed') ||
    htmlText.includes('>Просмотрено<')
  );
}

/**
 * Можно ли оборвать чтение HTML раньше конца документа.
 * True для явного «просмотрено» или когда PLAYER_* уже полностью распарсен и даёт watched.
 */
function shouldStopWatchedHtmlProbe(htmlText) {
  if (typeof htmlText !== 'string' || !htmlText) {
    return false;
  }

  if (hasPositiveWatchedStringMarker(htmlText)) {
    return true;
  }

  const hasPlaylistMarker = htmlText.includes('window.PLAYER_PLAYLIST');
  const hasSeasonsMarker = htmlText.includes('window.PLAYER_SEASONS');

  if (hasPlaylistMarker || hasSeasonsMarker) {
    const playlist = hasPlaylistMarker
      ? parseWindowJsonAssignment(htmlText, 'PLAYER_PLAYLIST')
      : [];
    const seasons = hasSeasonsMarker
      ? parseWindowJsonAssignment(htmlText, 'PLAYER_SEASONS')
      : [];

    // null = JSON ещё не дочитан — продолжаем стрим.
    if (hasPlaylistMarker && playlist === null) {
      return false;
    }

    if (hasSeasonsMarker && seasons === null) {
      return false;
    }

    if (isKinoItemWatched(playlist || [], seasons || [])) {
      return true;
    }
  }

  if (/<\/(?:body|html)>/i.test(htmlText)) {
    return true;
  }

  return htmlText.length >= WATCHED_HTML_PROBE_MAX_CHARS;
}

/**
 * Читает тело ответа кусками и обрывает поток, когда для проверки watched
 * уже достаточно данных (экономия на просмотренных карточках).
 */
async function readResponseTextForWatchedProbe(response) {
  if (!response?.body?.getReader) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let htmlText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        htmlText += decoder.decode();
        break;
      }

      htmlText += decoder.decode(value, { stream: true });

      if (shouldStopWatchedHtmlProbe(htmlText)) {
        try {
          await reader.cancel();
        } catch (cancelError) {
          // ignore
        }
        break;
      }
    }
  } catch (error) {
    if (!htmlText) {
      throw error;
    }
  }

  return htmlText;
}

function htmlIndicatesWatched(htmlText) {
  if (typeof htmlText !== 'string' || !htmlText) {
    return false;
  }

  if (hasPositiveWatchedStringMarker(htmlText)) {
    return true;
  }

  const playlist = parseWindowJsonAssignment(htmlText, 'PLAYER_PLAYLIST');
  const seasons = parseWindowJsonAssignment(htmlText, 'PLAYER_SEASONS');
  if (isKinoItemWatched(playlist || [], seasons || [])) {
    return true;
  }

  if (typeof DOMParser === 'undefined') {
    return false;
  }

  try {
    const parsedDocument = new DOMParser().parseFromString(htmlText, 'text/html');

    if (
      parsedDocument.querySelector(
        '.fa-eye-slash, i.fa-eye-slash, [class*="fa-eye-slash"], .playlist-item.is-completed, .playlist-badge'
      )
    ) {
      const playlistBadge = parsedDocument.querySelector('.playlist-badge');
      if (playlistBadge && /просмотрено/i.test(playlistBadge.textContent || '')) {
        return true;
      }

      if (parsedDocument.querySelector('.fa-eye-slash, .playlist-item.is-completed')) {
        return true;
      }
    }
  } catch (error) {
    return false;
  }

  return false;
}

const MatchUtils = {
  extractBalancedJson,
  parseWindowJsonAssignment,
  splitKinoTitle,
  extractYearFromHtml,
  isKinoMovie,
  isKinoItemWatched,
  normalizeImdbId,
  normalizeKinopoiskId,
  extractExternalIdsFromHtml,
  hasExternalIds,
  normalizeTitleForMatch,
  isMostlyLatinTitle,
  replaceRomanNumeralsWithArabic,
  expandTitleQueryVariants,
  buildSearchQueries,
  titlesMatchLoosely,
  pickExactTitleMatches,
  extractMoviesFromCatalog,
  mapCandidatesForReport,
  pickMyShowsMovieMatch,
  movieMatchesExternalIds,
  myShowsMovieHasExternalIds,
  hasPositiveWatchedStringMarker,
  shouldStopWatchedHtmlProbe,
  readResponseTextForWatchedProbe,
  htmlIndicatesWatched,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MatchUtils;
}
