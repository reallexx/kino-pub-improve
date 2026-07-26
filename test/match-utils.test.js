const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MatchUtils = require('../lib/match-utils.js');
const {
  extractExternalIdsFromHtml,
  normalizeImdbId,
  normalizeKinopoiskId,
  replaceRomanNumeralsWithArabic,
  buildSearchQueries,
  pickMyShowsMovieMatch,
  movieMatchesExternalIds,
  htmlIndicatesWatched,
  hasPositiveWatchedStringMarker,
  shouldStopWatchedHtmlProbe,
  isKinoMovie,
  isKinoItemWatched,
  parseWindowJsonAssignment,
  extractYearFromHtml,
  splitKinoTitle,
} = MatchUtils;

const fixtureHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'mortal-kombat-snippet.html'),
  'utf8'
);

describe('normalizeImdbId / normalizeKinopoiskId', () => {
  it('нормализует IMDb id', () => {
    assert.equal(normalizeImdbId('tt0113855'), 'tt0113855');
    assert.equal(normalizeImdbId('TT0113855'), 'tt0113855');
    assert.equal(normalizeImdbId('113855'), 'tt113855');
    assert.equal(normalizeImdbId(''), null);
  });

  it('нормализует Kinopoisk id', () => {
    assert.equal(normalizeKinopoiskId('22355'), 22355);
    assert.equal(normalizeKinopoiskId(0), null);
    assert.equal(normalizeKinopoiskId('abc'), null);
  });
});

describe('extractExternalIdsFromHtml', () => {
  it('достаёт КП и IMDb со страницы Kinopub', () => {
    const ids = extractExternalIdsFromHtml(fixtureHtml);
    assert.equal(ids.kinopoiskId, 22355);
    assert.equal(ids.imdbId, 'tt0113855');
  });
});

describe('replaceRomanNumeralsWithArabic', () => {
  it('конвертирует римские цифры в конце названия', () => {
    assert.equal(replaceRomanNumeralsWithArabic('Mortal Kombat II'), 'Mortal Kombat 2');
    assert.equal(replaceRomanNumeralsWithArabic('Scary Movie V'), 'Scary Movie 5');
  });

  it('не ломает I Am Legend', () => {
    assert.equal(replaceRomanNumeralsWithArabic('I Am Legend'), 'I Am Legend');
  });
});

describe('buildSearchQueries', () => {
  it('ставит original title раньше русского', () => {
    const queries = buildSearchQueries({
      titleRu: 'Смертельная битва',
      titleOriginal: 'Mortal Kombat',
      year: 1995,
    });

    assert.equal(queries[0], 'Mortal Kombat 1995');
    assert.ok(queries.includes('Смертельная битва'));
  });
});

describe('pickMyShowsMovieMatch', () => {
  const catalog = [
    { movie: { id: 82, title: 'Мортал Комбат', titleOriginal: 'Mortal Kombat', year: 2021 } },
    { movie: { id: 4763, title: 'Смертельная битва', titleOriginal: 'Mortal Kombat', year: 1995 } },
    { movie: { id: 68272, title: 'Смертельная битва 2', titleOriginal: 'Mortal Kombat: Annihilation', year: 1997 } },
  ];

  it('выбирает фильм по году', () => {
    const result = pickMyShowsMovieMatch(catalog, {
      titleRu: 'Смертельная битва',
      titleOriginal: 'Mortal Kombat',
      year: 1995,
    });

    assert.equal(result.status, 'matched');
    assert.equal(result.movie.id, 4763);
  });

  it('возвращает not-found при отсутствии года в каталоге', () => {
    const result = pickMyShowsMovieMatch(catalog, {
      titleOriginal: 'Mortal Kombat',
      year: 1980,
    });

    assert.equal(result.status, 'not-found');
  });
});

describe('movieMatchesExternalIds', () => {
  it('матчит по kinopoiskId и imdbId', () => {
    assert.equal(
      movieMatchesExternalIds(
        { kinopoiskId: 22355, imdbId: 'tt0113855' },
        { kinopoiskId: 22355, imdbId: 'tt0113855' }
      ),
      'kinopoisk'
    );

    assert.equal(
      movieMatchesExternalIds(
        { kinopoiskId: 1, imdbId: 'tt0113855' },
        { kinopoiskId: 22355, imdbId: 'tt0113855' }
      ),
      'imdb'
    );

    assert.equal(
      movieMatchesExternalIds(
        { kinopoiskId: 1, imdbId: 'tt0000001' },
        { kinopoiskId: 22355, imdbId: 'tt0113855' }
      ),
      null
    );
  });
});

describe('Kinopub playlist / watched / movie detection', () => {
  it('парсит PLAYER_PLAYLIST и год yeaer', () => {
    const playlist = parseWindowJsonAssignment(fixtureHtml, 'PLAYER_PLAYLIST');
    const seasons = parseWindowJsonAssignment(fixtureHtml, 'PLAYER_SEASONS');

    assert.equal(playlist[0].completed, 1);
    assert.equal(extractYearFromHtml(fixtureHtml, playlist), 1995);
    assert.equal(isKinoItemWatched(playlist, seasons), true);
    assert.equal(isKinoMovie(fixtureHtml, seasons), true);
    assert.equal(htmlIndicatesWatched(fixtureHtml), true);
    assert.equal(hasPositiveWatchedStringMarker(fixtureHtml), true);
    assert.equal(shouldStopWatchedHtmlProbe(fixtureHtml), true);
  });

  it('рано останавливает probe на completed:1 без полного HTML', () => {
    const partialHtml = '<html><script>window.PLAYER_PLAYLIST = [{"completed":1}];</script>';
    assert.equal(shouldStopWatchedHtmlProbe(partialHtml), true);
    assert.equal(htmlIndicatesWatched(partialHtml), true);
  });

  it('не останавливает probe на недочитанном PLAYER_PLAYLIST', () => {
    const incompleteHtml = '<script>window.PLAYER_PLAYLIST = [{"completed":';
    assert.equal(shouldStopWatchedHtmlProbe(incompleteHtml), false);
  });

  it('делит title на ru/original', () => {
    assert.deepEqual(splitKinoTitle('Смертельная битва / Mortal Kombat'), {
      titleRu: 'Смертельная битва',
      titleOriginal: 'Mortal Kombat',
    });
  });

  it('считает сериал не фильмом', () => {
    assert.equal(
      isKinoMovie('<a href="/serial?years=2020">2020</a>', [{ season: 1 }]),
      false
    );
  });
});
