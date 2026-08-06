/* ============================================================================
 * MovieZone Search Engine  v2.0
 * ----------------------------------------------------------------------------
 * What is new in v2.0
 *   1. debounce()          -> reusable trailing-edge debounce (used by the
 *                             search box at 350ms, inside the 300-400ms window)
 *   2. MiniFuse            -> a self-contained, Fuse.js-compatible fuzzy
 *                             matcher (Bitap / bitwise approximate matching).
 *                             Same algorithm + same scoring model as Fuse.js,
 *                             but ~3KB inline instead of a 25KB CDN request.
 *                             If the real Fuse.js is ever loaded on the page
 *                             (window.Fuse), it is used automatically instead.
 *   3. Typo rescue         -> rankSearchCandidates() now blends the fuzzy score
 *                             into the final ranking AND rescues strong fuzzy
 *                             matches that the strict scorer would have cut,
 *                             so "avengrs endgam", "spidrman", "pushpaa 2"
 *                             still return the right movie.
 *   4. Backwards compatible: every export from v1.1 is still exported with the
 *      same name and signature, so moviezone.js keeps working.
 * ==========================================================================*/
(function initMovieZoneSearch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MovieZoneSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSearchEngine() {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. Aliases / spelling shortcuts users actually type
   * ------------------------------------------------------------------ */
  const TOKEN_ALIASES = {
    srk: 'shah rukh khan',
    shahruk: 'shah rukh khan',
    shahrukh: 'shah rukh khan',
    salmankhan: 'salman khan',
    amirkhan: 'aamir khan',
    amitabh: 'amitabh bachchan',
    avngr: 'avengers',
    avnger: 'avengers',
    avengrs: 'avengers',
    avenjer: 'avengers',
    endgam: 'endgame',
    infinty: 'infinity',
    spidr: 'spider',
    spidrman: 'spider man',
    spiderman: 'spider man',
    batman: 'batman',
    bahubali: 'baahubali',
    bahuballi: 'baahubali',
    pathan: 'pathaan',
    pushpaa: 'pushpa',
    jawaan: 'jawan',
    kgf: 'k g f',
    got: 'game of thrones',
    hp: 'harry potter',
    'har pot': 'harry potter',
    'harry pot': 'harry potter',
    lotr: 'lord of the rings',
    'lord ring': 'lord of the rings',
    'game throne': 'game of thrones',
    'fast fur': 'fast and furious',
    fastandfurious: 'fast and furious',
    stranger: 'stranger things',
    'money hiest': 'money heist',
    'money heist': 'money heist',
    onepiece: 'one piece',
    naruto: 'naruto',
    demonslayer: 'demon slayer',
    aot: 'attack on titan',
    'atack on titan': 'attack on titan'
  };

  /* ------------------------------------------------------------------ *
   * 1. Generic helpers
   * ------------------------------------------------------------------ */

  /**
   * Trailing-edge debounce. The wrapped function only runs once the user
   * has stopped typing for `wait` ms — this is what stops one API request
   * per keystroke.
   *
   *   const run = MovieZoneSearch.debounce(fetchSuggestions, 350);
   *   input.addEventListener('input', e => run(e.target.value));
   *   run.cancel();   // drop a pending call (e.g. input cleared)
   *   run.flush();    // run immediately (e.g. user pressed Enter)
   */
  function debounce(fn, wait, options) {
    const delay = typeof wait === 'number' ? wait : 350;
    const leading = !!(options && options.leading);
    let timer = null;
    let lastArgs = null;
    let lastThis = null;

    function invoke() {
      timer = null;
      const args = lastArgs;
      const context = lastThis;
      lastArgs = null;
      lastThis = null;
      if (args) fn.apply(context, args);
    }

    function debounced() {
      lastArgs = arguments;
      lastThis = this;
      const callNow = leading && timer === null;
      if (timer) clearTimeout(timer);
      timer = setTimeout(invoke, delay);
      if (callNow) invoke();
    }

    debounced.cancel = function cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      lastArgs = null;
      lastThis = null;
    };

    debounced.flush = function flush() {
      if (timer) {
        clearTimeout(timer);
        invoke();
      }
    };

    debounced.pending = function pending() { return timer !== null; };

    return debounced;
  }

  function normalizeSearchText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/['’`]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function applyAliases(value) {
    const normalized = normalizeSearchText(value);
    if (!normalized) return '';
    if (TOKEN_ALIASES[normalized]) return TOKEN_ALIASES[normalized];
    return normalized
      .split(' ')
      .map(token => TOKEN_ALIASES[token] || token)
      .join(' ');
  }

  function levenshteinDistance(a, b) {
    const left = normalizeSearchText(a);
    const right = normalizeSearchText(b);
    if (left === right) return 0;
    if (!left.length) return right.length;
    if (!right.length) return left.length;

    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    const current = new Array(right.length + 1);
    for (let i = 1; i <= left.length; i++) {
      current[0] = i;
      for (let j = 1; j <= right.length; j++) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + cost
        );
      }
      for (let j = 0; j <= right.length; j++) previous[j] = current[j];
    }
    return previous[right.length];
  }

  function stringSimilarity(a, b) {
    const left = normalizeSearchText(a);
    const right = normalizeSearchText(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    const longest = Math.max(left.length, right.length);
    return Math.max(0, 1 - levenshteinDistance(left, right) / longest);
  }

  /* ==================================================================== *
   * 2. MiniFuse — Fuse.js compatible fuzzy search (Bitap algorithm)
   * --------------------------------------------------------------------
   * Drop-in subset of the Fuse.js API:
   *
   *   const fuse = new MiniFuse(list, {
   *     keys: ['title', { name: 'original_title', weight: 0.6 }],
   *     threshold: 0.42,      // 0 = exact, 1 = match anything
   *     distance: 120,
   *     ignoreLocation: true,
   *     includeScore: true,
   *     minMatchCharLength: 2
   *   });
   *   fuse.search('avengrs endgam');   // -> [{ item, refIndex, score }]
   *
   * Lower score = better match (identical to Fuse.js semantics).
   * ==================================================================== */
  const BITAP_MAX_PATTERN = 32; // JS bitwise ops are 32-bit

  function createPatternAlphabet(pattern) {
    const mask = Object.create(null);
    for (let i = 0; i < pattern.length; i += 1) {
      const char = pattern.charAt(i);
      mask[char] = (mask[char] || 0) | (1 << (pattern.length - i - 1));
    }
    return mask;
  }

  function bitapScore(patternLength, errors, currentLocation, expectedLocation, distance, ignoreLocation) {
    const accuracy = errors / patternLength;
    if (ignoreLocation) return accuracy;
    const proximity = Math.abs(expectedLocation - currentLocation);
    if (!distance) return proximity ? 1 : accuracy;
    return accuracy + proximity / distance;
  }

  function bitapChunkSearch(text, pattern, alphabet, config) {
    const patternLength = pattern.length;
    const textLength = text.length;
    const location = config.location || 0;
    const distance = typeof config.distance === 'number' ? config.distance : 100;
    const ignoreLocation = !!config.ignoreLocation;
    const expectedLocation = Math.max(0, Math.min(location, textLength));

    let currentThreshold = config.threshold;
    let bestLocation = text.indexOf(pattern, expectedLocation);

    if (bestLocation > -1) {
      currentThreshold = Math.min(
        bitapScore(patternLength, 0, bestLocation, expectedLocation, distance, ignoreLocation),
        currentThreshold
      );
      const lastMatch = text.lastIndexOf(pattern, expectedLocation + patternLength);
      if (lastMatch > -1) {
        currentThreshold = Math.min(
          bitapScore(patternLength, 0, lastMatch, expectedLocation, distance, ignoreLocation),
          currentThreshold
        );
      }
    }

    bestLocation = -1;
    const mask = 1 << (patternLength - 1);
    let lastBitArr = [];
    let finalScore = 1;
    let binMax = patternLength + textLength;

    for (let i = 0; i < patternLength; i += 1) {
      // Binary-search the furthest location still inside currentThreshold.
      let binMin = 0;
      let binMid = binMax;
      while (binMin < binMid) {
        const score = bitapScore(patternLength, i, expectedLocation + binMid, expectedLocation, distance, ignoreLocation);
        if (score <= currentThreshold) binMin = binMid;
        else binMax = binMid;
        binMid = Math.floor((binMax - binMin) / 2 + binMin);
      }
      binMax = binMid;

      let start = Math.max(1, expectedLocation - binMid + 1);
      const finish = Math.min(expectedLocation + binMid, textLength) + patternLength;
      const bitArr = new Array(finish + 2).fill(0);
      bitArr[finish + 1] = (1 << i) - 1;

      for (let j = finish; j >= start; j -= 1) {
        const currentLocation = j - 1;
        const charMatch = alphabet[text.charAt(currentLocation)] || 0;

        if (i === 0) {
          bitArr[j] = ((bitArr[j + 1] << 1) | 1) & charMatch;
        } else {
          bitArr[j] = (((bitArr[j + 1] << 1) | 1) & charMatch) |
            (((lastBitArr[j + 1] | lastBitArr[j]) << 1) | 1) |
            lastBitArr[j + 1];
        }

        if (bitArr[j] & mask) {
          finalScore = bitapScore(patternLength, i, currentLocation, expectedLocation, distance, ignoreLocation);
          if (finalScore <= currentThreshold) {
            currentThreshold = finalScore;
            bestLocation = currentLocation;
            if (bestLocation <= expectedLocation) break;
            start = Math.max(1, 2 * expectedLocation - bestLocation);
          }
        }
      }

      // No point going deeper: one more error already busts the threshold.
      const nextScore = bitapScore(patternLength, i + 1, expectedLocation, expectedLocation, distance, ignoreLocation);
      if (nextScore > currentThreshold) break;
      lastBitArr = bitArr;
    }

    return {
      isMatch: bestLocation >= 0,
      score: Math.max(0.0001, finalScore),
      index: bestLocation
    };
  }

  /**
   * Fuzzy-match one pattern against one string.
   * Long patterns are split into <=32 char chunks (same trick Fuse.js uses).
   * @returns {{isMatch:boolean, score:number, index:number}} score: 0 best, 1 worst
   */
  function fuzzyMatch(text, pattern, config) {
    const options = Object.assign({
      threshold: 0.4,
      distance: 100,
      location: 0,
      ignoreLocation: true,
      minMatchCharLength: 1,
      isCaseSensitive: false
    }, config || {});

    let haystack = String(text == null ? '' : text);
    let needle = String(pattern == null ? '' : pattern);
    if (!options.isCaseSensitive) {
      haystack = haystack.toLowerCase();
      needle = needle.toLowerCase();
    }
    if (!needle || needle.length < options.minMatchCharLength) {
      return { isMatch: false, score: 1, index: -1 };
    }
    if (!haystack) return { isMatch: false, score: 1, index: -1 };

    // Exact substring: fast path, best possible score.
    const exactIndex = haystack.indexOf(needle);
    if (exactIndex > -1) {
      const positionPenalty = options.ignoreLocation ? 0 : Math.min(0.15, exactIndex / Math.max(1, haystack.length) * 0.15);
      return { isMatch: true, score: Math.max(0.0001, positionPenalty), index: exactIndex };
    }

    if (needle.length <= BITAP_MAX_PATTERN) {
      return bitapChunkSearch(haystack, needle, createPatternAlphabet(needle), options);
    }

    // Chunked search for very long queries.
    let best = { isMatch: false, score: 1, index: -1 };
    for (let offset = 0; offset < needle.length; offset += BITAP_MAX_PATTERN) {
      const chunk = needle.slice(offset, offset + BITAP_MAX_PATTERN);
      const result = bitapChunkSearch(haystack, chunk, createPatternAlphabet(chunk), options);
      if (result.score < best.score) best = result;
    }
    return best;
  }

  function normalizeKeys(keys) {
    return (keys && keys.length ? keys : ['title'])
      .map(key => (typeof key === 'string'
        ? { name: key, weight: 1 }
        : { name: key.name, weight: typeof key.weight === 'number' ? key.weight : 1 }))
      .filter(key => !!key.name);
  }

  function readPath(item, path) {
    if (!item) return '';
    if (path.indexOf('.') === -1) return item[path];
    return path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), item);
  }

  /** Lightweight Fuse.js-compatible index. */
  class MiniFuse {
    constructor(list, options) {
      this.options = Object.assign({
        keys: ['title'],
        threshold: 0.42,
        distance: 120,
        location: 0,
        ignoreLocation: true,
        minMatchCharLength: 2,
        includeScore: true,
        shouldSort: true,
        isCaseSensitive: false
      }, options || {});
      this.options.keys = normalizeKeys(this.options.keys);
      this.setCollection(list);
    }

    setCollection(list) {
      this.list = Array.isArray(list) ? list : [];
      return this;
    }

    search(query, searchOptions) {
      const limit = (searchOptions && searchOptions.limit) || 0;
      const pattern = String(query == null ? '' : query).trim();
      if (!pattern) return [];

      const keys = this.options.keys;
      const results = [];

      for (let index = 0; index < this.list.length; index += 1) {
        const item = this.list[index];
        if (!item) continue;

        let bestScore = 1;
        let matched = false;

        for (let k = 0; k < keys.length; k += 1) {
          const raw = readPath(item, keys[k].name);
          if (raw == null || raw === '') continue;
          const values = Array.isArray(raw) ? raw : [raw];
          for (let v = 0; v < values.length; v += 1) {
            const match = fuzzyMatch(values[v], pattern, this.options);
            if (!match.isMatch) continue;
            // Fuse-style weighting: a lighter key can never beat a heavy key.
            const weighted = Math.min(1, match.score / Math.max(0.0001, keys[k].weight));
            if (weighted < bestScore) {
              bestScore = weighted;
              matched = true;
            }
          }
        }

        if (matched && bestScore <= this.options.threshold + 0.0001) {
          results.push({ item, refIndex: index, score: bestScore });
        }
      }

      if (this.options.shouldSort) results.sort((a, b) => a.score - b.score);
      return limit > 0 ? results.slice(0, limit) : results;
    }
  }

  /**
   * Returns a fuzzy index. Uses the REAL Fuse.js when it is present on the
   * page (window.Fuse), otherwise the built-in MiniFuse — identical API, so
   * calling code never has to care which one it got.
   */
  function createFuzzyIndex(list, options) {
    const config = Object.assign({
      keys: ['title', 'name', 'original_title', 'original_name'],
      threshold: 0.42,
      distance: 120,
      ignoreLocation: true,
      includeScore: true,
      minMatchCharLength: 2
    }, options || {});

    const Fuse = (typeof window !== 'undefined' && window.Fuse) ||
      (typeof globalThis !== 'undefined' && globalThis.Fuse);

    if (typeof Fuse === 'function') {
      try { return new Fuse(list || [], config); } catch (error) { /* fall through */ }
    }
    return new MiniFuse(list || [], config);
  }

  /** Convenience: fuzzy search a list, returns [{ item, score }] (0 = best). */
  function fuzzySearch(query, list, options) {
    if (!query || !list || !list.length) return [];
    const index = createFuzzyIndex(list, options);
    return index.search(query, { limit: (options && options.limit) || 0 });
  }

  /* ------------------------------------------------------------------ *
   * 3. Deterministic scoring (v1 logic, kept intact)
   * ------------------------------------------------------------------ */
  function tokenSimilarity(queryToken, titleToken) {
    if (queryToken === titleToken) return 1;
    const shorter = Math.min(queryToken.length, titleToken.length);
    if (shorter >= 2 && (titleToken.startsWith(queryToken) || queryToken.startsWith(titleToken))) {
      const lengthPenalty = Math.abs(queryToken.length - titleToken.length) / Math.max(queryToken.length, titleToken.length);
      return Math.max(0.78, 0.96 - lengthPenalty * 0.25);
    }
    if (queryToken.length >= 3 && titleToken.includes(queryToken)) return 0.84;
    if (titleToken.length >= 3 && queryToken.includes(titleToken)) return 0.8;
    if (shorter <= 2) return 0;
    return stringSimilarity(queryToken, titleToken);
  }

  function candidateTitles(candidate) {
    return [candidate.title, candidate.name, candidate.original_title, candidate.original_name, candidate._matchedPerson]
      .map(normalizeSearchText)
      .filter(Boolean)
      .filter((title, index, list) => list.indexOf(title) === index);
  }

  function scoreTitle(query, title) {
    if (!query || !title) return { score: 0, quality: 'Related' };
    if (title === query) return { score: 1400, quality: 'Exact match' };
    if (title.startsWith(query)) return { score: 1120 - Math.min(120, title.length - query.length), quality: 'Starts with' };
    if (title.includes(' ' + query) || title.includes(query + ' ')) return { score: 920, quality: 'Title match' };
    if (title.includes(query)) return { score: 850, quality: 'Partial match' };

    const queryTokens = query.split(' ').filter(Boolean);
    const titleTokens = title.split(' ').filter(Boolean);
    const tokenScores = queryTokens.map(queryToken =>
      titleTokens.reduce((best, titleToken) => Math.max(best, tokenSimilarity(queryToken, titleToken)), 0)
    );
    const coverage = tokenScores.reduce((sum, score) => sum + score, 0) / Math.max(1, tokenScores.length);
    const allTokensClose = tokenScores.every(score => score >= 0.61);
    const phraseSimilarity = stringSimilarity(query, title);
    const firstTokenBonus = tokenSimilarity(queryTokens[0] || '', titleTokens[0] || '') * 100;

    let score = coverage * 620 + phraseSimilarity * 310 + firstTokenBonus;
    if (allTokensClose) score += 170;
    if (tokenScores.some(tokenScore => tokenScore >= 0.9)) score += 80;

    let quality = 'Related';
    if (allTokensClose && coverage >= 0.84) quality = 'Possible typo';
    else if (coverage >= 0.72) quality = 'Close match';
    else if (coverage >= 0.58) quality = 'Related';
    return { score, quality };
  }

  function scoreCandidate(rawQuery, candidate) {
    const query = applyAliases(rawQuery);
    if (!query || !candidate) return { score: 0, quality: 'Related', matchedTitle: '' };

    let best = { score: 0, quality: 'Related', matchedTitle: '' };
    for (const title of candidateTitles(candidate)) {
      const scored = scoreTitle(query, title);
      if (scored.score > best.score) best = { ...scored, matchedTitle: title };
    }

    const popularity = Math.min(95, Math.log1p(Math.max(0, candidate.popularity || 0)) * 13);
    const votes = Math.min(45, Math.log1p(Math.max(0, candidate.vote_count || 0)) * 4.5);
    const rating = Math.max(0, candidate.vote_average || 0) * 2;
    return { ...best, score: best.score + popularity + votes + rating };
  }

  /* ------------------------------------------------------------------ *
   * 4. Ranking = deterministic score  +  Fuse fuzzy score
   * ------------------------------------------------------------------ */
  const FUZZY_KEYS = [
    { name: '_fuzzyTitle', weight: 1 },
    { name: '_fuzzyAlt', weight: 0.72 },
    { name: '_fuzzyPerson', weight: 0.55 }
  ];

  function buildFuzzyRecords(candidates) {
    return candidates.map((candidate, index) => ({
      index,
      _fuzzyTitle: normalizeSearchText(candidate.title || candidate.name || ''),
      _fuzzyAlt: normalizeSearchText(candidate.original_title || candidate.original_name || ''),
      _fuzzyPerson: normalizeSearchText(candidate._matchedPerson || '')
    }));
  }

  /**
   * Ranks TMDb candidates for a (possibly misspelled) query.
   * Adds to every returned item:
   *   _searchScore   number  (higher = better)
   *   _fuzzyScore    number  (0 = perfect fuzzy match, 1 = none)
   *   _matchQuality  string  (UI label)
   *   _matchedTitle  string
   */
  function rankSearchCandidates(query, candidates, limit) {
    const unique = new Map();
    for (const candidate of candidates || []) {
      if (!candidate || !candidate.id) continue;
      const type = candidate.media_type || (candidate.name ? 'tv' : 'movie');
      const key = type + ':' + candidate.id;
      const existing = unique.get(key);
      if (!existing || (candidate.popularity || 0) > (existing.popularity || 0)) unique.set(key, candidate);
    }

    const pool = Array.from(unique.values());
    if (!pool.length) return [];

    const normalizedQuery = applyAliases(query);
    const minimumScore = normalizedQuery.length <= 2 ? 680 : normalizedQuery.length <= 4 ? 480 : 410;

    // ---- Fuzzy pass (Fuse.js / MiniFuse) -----------------------------
    const fuzzyScores = new Array(pool.length).fill(1);
    if (normalizedQuery.length >= 2) {
      try {
        const fuse = createFuzzyIndex(buildFuzzyRecords(pool), {
          keys: FUZZY_KEYS,
          threshold: normalizedQuery.length <= 4 ? 0.34 : 0.45,
          distance: 140,
          ignoreLocation: true,
          minMatchCharLength: 2
        });
        fuse.search(normalizedQuery).forEach(hit => {
          const record = hit.item || {};
          if (typeof record.index === 'number') {
            fuzzyScores[record.index] = Math.min(fuzzyScores[record.index], typeof hit.score === 'number' ? hit.score : 1);
          }
        });
      } catch (error) {
        // Fuzzy layer is a bonus, never a hard dependency.
      }
    }

    const scored = pool.map((candidate, index) => {
      const match = scoreCandidate(query, candidate);
      const fuzzyScore = fuzzyScores[index];
      // Fuse score is 0..1 (0 = best) -> convert to a 0..300 bonus.
      const fuzzyBonus = fuzzyScore < 1 ? Math.round((1 - fuzzyScore) * 300) : 0;
      let quality = match.quality;
      if (fuzzyScore <= 0.2 && quality === 'Related') quality = 'Close match';
      else if (fuzzyScore > 0.2 && fuzzyScore <= 0.45 && (quality === 'Related' || quality === 'Close match')) quality = 'Possible typo';

      return {
        ...candidate,
        _searchScore: match.score + fuzzyBonus,
        _fuzzyScore: fuzzyScore,
        _matchQuality: quality,
        _matchedTitle: match.matchedTitle
      };
    });

    return scored
      // Typo rescue: a strong fuzzy hit survives even if the strict scorer
      // would have dropped it (this is what fixes misspelled searches).
      .filter(candidate => candidate._searchScore >= minimumScore ||
        (candidate._fuzzyScore <= 0.32 && candidate._searchScore >= minimumScore * 0.55))
      .sort((a, b) => b._searchScore - a._searchScore ||
        a._fuzzyScore - b._fuzzyScore ||
        (b.popularity || 0) - (a.popularity || 0))
      .slice(0, limit || 20);
  }

  function getCorrection(query, rankedCandidates) {
    const normalizedQuery = applyAliases(query);
    const best = (rankedCandidates || [])[0];
    if (!best || best._searchScore < 650) return null;
    const displayTitle = best.title || best.name || best.original_title || best.original_name || '';
    const normalizedTitle = normalizeSearchText(displayTitle);
    if (!normalizedTitle || normalizedTitle === normalizeSearchText(query)) return null;
    if (normalizedTitle.startsWith(normalizedQuery) && normalizedQuery.length >= 3) return displayTitle;
    if (best._matchQuality === 'Possible typo' || best._searchScore >= 850) return displayTitle;
    if (typeof best._fuzzyScore === 'number' && best._fuzzyScore <= 0.34) return displayTitle;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 5. Public API
   * ------------------------------------------------------------------ */
  return {
    // v1.1 API (unchanged)
    normalizeSearchText,
    applyAliases,
    levenshteinDistance,
    stringSimilarity,
    scoreCandidate,
    rankSearchCandidates,
    getCorrection,
    // v2.0 additions
    debounce,
    fuzzyMatch,
    fuzzySearch,
    createFuzzyIndex,
    MiniFuse,
    usesExternalFuse: () => typeof (typeof window !== 'undefined' && window.Fuse) === 'function',
    version: '2.0'
  };
});
