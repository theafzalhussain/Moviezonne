(function initMovieZoneSearch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MovieZoneSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSearchEngine() {
  'use strict';

  const TOKEN_ALIASES = {
    srk: 'shah rukh khan',
    shahruk: 'shah rukh khan',
    shahrukh: 'shah rukh khan',
    salmankhan: 'salman khan',
    amirkhan: 'aamir khan',
    amitabh: 'amitabh bachchan',
    avngr: 'avengers',
    avnger: 'avengers',
    avenjer: 'avengers',
    spidr: 'spider',
    spiderman: 'spider man',
    batman: 'batman',
    bahubali: 'baahubali',
    bahuballi: 'baahubali',
    pathan: 'pathaan',
    pushpaa: 'pushpa',
    kgf: 'k g f',
    got: 'game of thrones',
    hp: 'harry potter',
    'har pot': 'harry potter',
    'harry pot': 'harry potter',
    lotr: 'lord of the rings',
    'lord ring': 'lord of the rings',
    'game throne': 'game of thrones',
    'fast fur': 'fast and furious',
    fastandfurious: 'fast and furious'
  };

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

  function rankSearchCandidates(query, candidates, limit) {
    const unique = new Map();
    for (const candidate of candidates || []) {
      if (!candidate || !candidate.id) continue;
      const type = candidate.media_type || (candidate.name ? 'tv' : 'movie');
      const key = type + ':' + candidate.id;
      const existing = unique.get(key);
      if (!existing || (candidate.popularity || 0) > (existing.popularity || 0)) unique.set(key, candidate);
    }

    const normalizedQuery = applyAliases(query);
    const minimumScore = normalizedQuery.length <= 2 ? 680 : normalizedQuery.length <= 4 ? 480 : 410;
    return Array.from(unique.values())
      .map(candidate => {
        const match = scoreCandidate(query, candidate);
        return { ...candidate, _searchScore: match.score, _matchQuality: match.quality, _matchedTitle: match.matchedTitle };
      })
      .filter(candidate => candidate._searchScore >= minimumScore)
      .sort((a, b) => b._searchScore - a._searchScore || (b.popularity || 0) - (a.popularity || 0))
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
    return null;
  }

  return {
    normalizeSearchText,
    applyAliases,
    levenshteinDistance,
    stringSimilarity,
    scoreCandidate,
    rankSearchCandidates,
    getCorrection
  };
});
