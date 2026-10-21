/*  MovieZone search-plus.js  v1
 *  ------------------------------------------------------------------------
 *  Loaded lazily the first time someone touches the search box, never on the
 *  page's critical path. moviezone.js works without it; with it, search gets:
 *
 *  1. SPELLING RECALL. TMDB's /search does no typo correction, so "housful"
 *     returned nothing and "golmal"/"dhamal" returned unrelated titles. The
 *     search-engine.js fuzzy ranker can only re-order what TMDB returns, so the
 *     words are corrected BEFORE asking TMDB, against search-vocab.json (every
 *     word in our own catalogue). Distance is phonetic-aware for how Indian
 *     titles are romanised: aa/a, ee/i, oo/u, ph/f, chh/ch, bh/b, doubled
 *     letters and a trailing y/i cost little; a changed first letter costs a lot.
 *
 *  2. EXACTLY WHAT WAS SEARCHED. The results page shows the searched title and
 *     its official franchise only (TMDB collections: "ek tha tiger" -> the three
 *     Tiger films), nothing that merely shares a word, and no fan films, clips
 *     or stubs that never released on TV or an OTT service (see vet()).
 */
(function () {
  'use strict';
  if (window.MZSearchPlus) return;

  var INDIAN = ['hi', 'te', 'ta', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu', 'or'];

  // Whole-query fixes for searches TMDB answers badly even with clean words.
  var FIX = {
    'golmal': 'golmaal', 'gol maal': 'golmaal', 'golmal returns': 'golmaal returns',
    'dhamal': 'dhamaal', 'total dhamal': 'total dhamaal',
    'hera feri': 'hera pheri', 'herapheri': 'hera pheri', 'hera fery': 'hera pheri', 'phir hera feri': 'phir hera pheri',
    'chota bheem': 'chhota bheem', 'chotabheem': 'chhota bheem', 'chota bhim': 'chhota bheem', 'chhota bhim': 'chhota bheem',
    'housful': 'housefull', 'houseful': 'housefull', 'house full': 'housefull',
    'jailor': 'jailer', 'jailor 2': 'jailer 2', 'kalky': 'kalki', 'salar': 'salaar', 'devra': 'devara',
    'doremon': 'doraemon', 'doraemon': 'doraemon', 'shinchan': 'shin chan', 'sinchan': 'shin chan', 'shin chen': 'shin chan',
    'oggy': 'oggy and the cockroaches', 'tom jerry': 'tom and jerry', 'tom n jerry': 'tom and jerry',
    'bhool bhulaiya': 'bhool bhulaiyaa', 'bhul bhulaiya': 'bhool bhulaiyaa', 'bhool bhulaiyaa': 'bhool bhulaiyaa',
    'krish': 'krrish', 'mirjapur': 'mirzapur', 'panchayt': 'panchayat', 'pokeman': 'pokemon',
    'ninja hatori': 'ninja hattori', 'motu patalu': 'motu patlu', 'spongbob': 'spongebob'
  };

  /* ------------------------------------------------------------ helpers */
  function norm(s) {
    return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // "ben10" -> "ben 10", "stree2" -> "stree 2"
  function splitDigits(s) { return s.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2'); }

  function phoneticKey(w) {
    return w.replace(/ph/g, 'f').replace(/([bcdgjkpst])h+/g, '$1')
      .replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/w/g, 'v').replace(/z/g, 'j')
      .replace(/q/g, 'k').replace(/c/g, 'k').replace(/y$/, 'i').replace(/(.)\1+/g, '$1').replace(/h$/, '');
  }

  var VOWEL = /[aeiou]/;
  // Weighted Damerau-Levenshtein. Vowel and 'h' edits and doubled letters are
  // cheap because that is how the same Hindi word gets spelt three ways.
  function distance(a, b, cap) {
    var n = a.length, m = b.length;
    if (Math.abs(n - m) > cap * 2 + 1) return cap + 1;
    var prev2 = null, prev = new Array(m + 1), cur;
    function indel(s, i) {
      var ch = s[i];
      if (VOWEL.test(ch) || ch === 'h') return 0.5;
      if (s[i - 1] === ch || s[i + 1] === ch) return 0.3;
      return 1;
    }
    prev[0] = 0;
    for (var j = 1; j <= m; j++) prev[j] = prev[j - 1] + indel(b, j - 1);
    for (var i = 1; i <= n; i++) {
      cur = new Array(m + 1);
      cur[0] = prev[0] + indel(a, i - 1);
      var rowMin = cur[0];
      for (j = 1; j <= m; j++) {
        var ca = a[i - 1], cb = b[j - 1];
        var sub = ca === cb ? 0 : (VOWEL.test(ca) && VOWEL.test(cb)) || (ca === 'y' && cb === 'i') || (ca === 'i' && cb === 'y') ? 0.5 : 1;
        var v = Math.min(prev[j] + indel(a, i - 1), cur[j - 1] + indel(b, j - 1), prev[j - 1] + sub);
        if (prev2 && i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb) v = Math.min(v, prev2[j - 2] + 0.6);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > cap) return cap + 1;
      prev2 = prev; prev = cur;
    }
    return prev[m];
  }

  /* ------------------------------------------------------- vocabulary */
  var vocab = null, vocabSet = null, vocabByFirst = null, vocabPromise = null;
  function loadVocab() {
    if (vocabPromise) return vocabPromise;
    vocabPromise = fetch('/search-vocab.json', { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.w) return null;
        vocab = d.w.split(' ');
        vocabSet = new Map();
        vocabByFirst = {};
        vocab.forEach(function (w, i) {
          vocabSet.set(w, i);
          var k = phoneticKey(w)[0] || w[0];
          (vocabByFirst[k] = vocabByFirst[k] || []).push(w);
        });
        return vocab;
      })
      .catch(function () { vocabPromise = null; return null; });
    return vocabPromise;
  }

  function correctToken(t) {
    if (t.length < 4 || /\d/.test(t) || vocabSet.has(t)) return t;
    var key = phoneticKey(t);
    var cap = t.length <= 5 ? 1 : t.length <= 8 ? 1.6 : 2.1;
    var pool = vocabByFirst[key[0]] || [];
    var best = null, bestCost = Infinity;
    for (var i = 0; i < pool.length; i++) {
      var w = pool[i];
      if (Math.abs(w.length - t.length) > 4) continue;
      var d = phoneticKey(w) === key ? 0.2 : distance(t, w, cap);
      if (d > cap) continue;
      // Ties go to the more common word (pool is in frequency order).
      var cost = d + vocabSet.get(w) / 200000;
      if (cost < bestCost) { bestCost = cost; best = w; }
    }
    return best || t;
  }

  /**
   * Returns the corrected query, or '' when the query already looks right.
   * Waits at most ~1.2s for the dictionary; search never blocks on it.
   */
  // TMDB files "Fast & Furious" and "Tom & Jerry" under "&": a typed "and"
  // finds only unrelated titles that literally say "and".
  function ampVariant(q) { return / and /.test(q) ? q.replace(/ and /g, ' & ') : ''; }
  function curated(query) { var q = splitDigits(norm(query)); return !!FIX[q] || !!ampVariant(q); }

  /**
   * Whether the corrected spelling should be used. A curated fix always is; a
   * dictionary guess only when what was typed found nothing exact, because the
   * dictionary holds titles, not people: "prabhas" is not a typo of "prabhat".
   */
  function useFix(query, rankedTyped, personFound) {
    if (curated(query)) return true;
    if (personFound) return false;
    var best = rankedTyped && rankedTyped[0];
    return !best || (best._searchScore || 0) < 1250;
  }

  function correct(query) {
    var q = splitDigits(norm(query));
    if (!q) return Promise.resolve('');
    if (FIX[q]) return Promise.resolve(FIX[q] !== q ? FIX[q] : '');
    if (ampVariant(q)) return Promise.resolve(ampVariant(q));
    var timeout = new Promise(function (r) { setTimeout(r, 1200); });
    return Promise.race([loadVocab(), timeout]).then(function () {
      if (!vocabSet) return '';
      var tokens = q.split(' ');
      var out = [];
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        // "house full" -> "housefull"
        if (tokens[i + 1] && t.length >= 3 && vocabSet.has(t + tokens[i + 1])) {
          out.push(t + tokens[i + 1]); i++; continue;
        }
        // "herapheri" -> "hera pheri"
        if (t.length >= 7 && !vocabSet.has(t)) {
          var split = '';
          for (var c = 3; c <= t.length - 3; c++) {
            if (vocabSet.has(t.slice(0, c)) && vocabSet.has(t.slice(c))) { split = t.slice(0, c) + ' ' + t.slice(c); break; }
          }
          if (split) { out.push(split); continue; }
        }
        out.push(correctToken(t));
      }
      var fixed = out.join(' ');
      if (FIX[fixed]) fixed = FIX[fixed];
      return fixed !== q ? fixed : '';
    });
  }

  /** Union of two ranked lists, keeping each title's better score. */
  function merge(a, b) {
    var map = new Map();
    a.concat(b).forEach(function (it) {
      var key = (it.media_type || 'movie') + ':' + it.id;
      var have = map.get(key);
      if (!have || (it._searchScore || 0) > (have._searchScore || 0)) map.set(key, it);
    });
    return Array.from(map.values()).sort(function (x, y) { return (y._searchScore || 0) - (x._searchScore || 0); });
  }

  /* ---------------------------------------------- franchise + related */
  var STRONG = { 'Exact match': 1, 'Starts with': 1, 'Title match': 1, 'Partial match': 1, 'Possible typo': 1, 'Close match': 1 };
  var TIER = { 'Exact match': 0, 'Starts with': 0, 'Title match': 0, 'Partial match': 0, 'Franchise': 0, 'Possible typo': 1, 'Close match': 1 };

  // How well known a title is. "golmaal" has five obscure films called exactly
  // "Golmaal"; an exact-title score put them above Golmaal Returns, 3 and Again,
  // which are the ones people mean. Within a match tier, fame decides.
  function fame(m) { return Math.log1p(m.vote_count || 0) + 1.2 * Math.log1p(m.popularity || 0); }

  /** Re-orders ranked results: match tier first, then fame. Actor searches keep their order. */
  // Upload-spam records on TMDB ("Jailer+(2023)+Telugu+HD+Movie") are not titles.
  var SPAM = /^untitled\b|\+.*\+|\b(full|hd|hdrip|dvdrip|download)\s+movie\b|\bwatch online\b|\bfree download\b/i;
  function order(list, query, personFound) {
    if (!list || !list.length) return list;
    list = list.filter(function (m) { return !SPAM.test(titleOf(m)); });
    // A real actor search keeps the ranker's order. Otherwise an obscure
    // namesake's films ("dhamal" -> Animal) must not outrank the title itself.
    if (!list.length || personFound) return list;
    // "golmaal 3" / "stree 2" name one film: its exact title leads.
    var qn = splitDigits(norm(query || ''));
    var q = /\d/.test(qn) ? qn : '';
    return list.map(function (m, i) {
      var t = m._matchedPerson ? 2 : TIER[m._matchQuality] != null ? TIER[m._matchQuality] : 2;
      var exactTitle = splitDigits(norm(titleOf(m))) === qn;
      // An exact, well-known title leads ("animal" -> Animal 2023 before Animal
      // Kingdom); obscure exact namesakes ("Golmaal" 1998) do not jump the queue.
      if (exactTitle && (q || (m.vote_count || 0) >= 50)) t = -1;
      return { m: m, i: i, t: t, f: fame(m) };
    })
      .sort(function (a, b) { return a.t - b.t || b.f - a.f || a.i - b.i; })
      .map(function (x) { return x.m; });
  }

  function titleOf(it) { return it.title || it.name || ''; }
  function typeOf(it) { return it.media_type === 'tv' || (!it.media_type && it.name && !it.title) ? 'tv' : 'movie'; }
  function keyOf(it) { return typeOf(it) + ':' + it.id; }

  // Every query word must appear (or nearly appear) in the title. This is what
  // stops "ben 10" pulling in "Power of 10" or "Benedetta".
  function coversQuery(title, qTokens) {
    var nt = splitDigits(norm(title));
    var tt = nt.split(' ');
    // "kgf" vs "K.G.F: Chapter 1", "ben10" vs "Ben 10": compare without spaces.
    var joined = qTokens.join('');
    if (joined.length >= 3 && qTokens.length === 1 && nt.replace(/ /g, '').indexOf(joined) === 0) return true;
    var tokenOk = function (t, q) {
      if (!t) return false;
      if (t === q) return true;
      if (/\d/.test(q) || /\d/.test(t)) return false;
      if (q.length >= 3 && t.indexOf(q) === 0) return true;
      return q.length >= 4 && phoneticKey(t) === phoneticKey(q);
    };
    // The words must appear together and in order: "breaking bad" matches
    // "El Camino: A Breaking Bad Movie", not "Bad News Bears in Breaking Training".
    for (var i = 0; i + qTokens.length <= tt.length; i++) {
      var ok = true;
      for (var j = 0; j < qTokens.length && ok; j++) ok = tokenOk(tt[i + j], qTokens[j]);
      if (ok) return true;
    }
    return false;
  }

  function collectionMatches(name, q) {
    var c = splitDigits(norm(String(name || '').replace(/\(.*?\)/g, '').replace(/collection/i, '')));
    if (!c || !q) return false;
    return c === q || c.indexOf(q + ' ') === 0 || q.indexOf(c + ' ') === 0 || phoneticKey(c.replace(/ /g, '')) === phoneticKey(q.replace(/ /g, ''));
  }

  // An actor search shows the actor's filmography, most known first.
  function filmography(person, movies, tmdb) {
    return tmdb('/person/' + person.id + '/combined_credits', { language: 'en-US' }).then(function (d) {
      var directing = person.known_for_department === 'Directing';
      var credits = (d && d.cast || []).concat(directing ? (d.crew || []).filter(function (c) { return c.job === 'Director'; }) : []);
      var seen = new Set();
      var list = credits.filter(function (c) {
        if (!c || !c.poster_path || !(c.release_date || c.first_air_date) || (c.vote_count || 0) < 5 || SPAM.test(titleOf(c))) return false;
        // Talk shows, news, reality, and TV guest spots (Indian Idol, KBC) are
        // appearances, not the actor's work.
        if ((c.genre_ids || []).some(function (g) { return g === 10767 || g === 10763 || g === 10764; })) return false;
        if (typeOf(c) === 'tv' && (c.episode_count || 0) < 4) return false;
        var k = keyOf(c); if (seen.has(k)) return false; seen.add(k); return true;
      }).map(function (c) { return Object.assign({}, c, { media_type: typeOf(c), _matchedPerson: person.name }); })
        // Cameos (deep in the cast list) and TV sit below lead roles.
        .sort(function (a, b) { return weight(b) - weight(a); }).slice(0, 60);
      function weight(c) { return fame(c) * (c.order > 8 ? 0.6 : 1) * (c.media_type === 'tv' ? 0.75 : 1); }
      return list.length >= 3 ? list : movies;
    }, function () { return movies; });
  }

  /**
   * Is the query this person ("akshay kumar", "prabhas", "srk")? A title that
   * merely shares a word with someone's name ("housful" vs "Tarang Housefull")
   * is not an actor search.
   */
  function isPerson(query, person, ranked) {
    if (!person || !person.name || (person._searchScore || 0) < 700) return false;
    var typed = splitDigits(norm(query)), pn = norm(person.name);
    if (!typed) return false;
    // "shinchan" and "doraemon" are also the names of little-known people on
    // TMDB. A well-known title that matches the query beats an obscure person.
    var tokens = typed.split(' ');
    var famousTitle = (ranked || []).some(function (m) {
      return !m._matchedPerson && (m.vote_count || 0) >= 50 && (coversQuery(titleOf(m), tokens) || STRONG[m._matchQuality]);
    });
    if (famousTitle && (person.popularity || 0) < 5) return false;
    return pn.indexOf(typed) === 0 || typed.length <= 4 ||
      phoneticKey(pn.replace(/ /g, '')).indexOf(phoneticKey(typed.replace(/ /g, ''))) === 0;
  }

  /* ------------------------------------------- official-release vetting */
  // "Ben 10: Break Room" (2 min), "Beast Boy vs Ben 10" (1 min fan clip), "Ben 10
  // Back Again" (fan film), "Panchayat Jetty" (unrelated film): TMDB lists them
  // because anyone can add a record. None ever ran on TV or an OTT service.
  // Well-voted titles and official collection parts pass straight through;
  // the rest must look like a real production (a studio or network, a real
  // runtime) and, when the search has a clear anchor, share a studio or network
  // with it, so a fan film that borrows the name does not pass.
  var today = function () { return new Date().toISOString().slice(0, 10); };
  function dateOf(m) { return m.release_date || m.first_air_date || ''; }
  function looksReal(m) {
    if (!m || !m.poster_path || !dateOf(m)) return false;
    return true;
  }
  function trusted(m) { return m._inCollection || (m.vote_count || 0) >= 10; }

  function studios(d) {
    var out = [];
    ((d && d.production_companies) || []).forEach(function (c) { if (c && c.name) out.push('c:' + norm(c.name)); });
    ((d && d.networks) || []).forEach(function (n) { if (n && n.name) out.push('n:' + norm(n.name)); });
    return out;
  }

  function vet(items, anchor, tmdb, q) {
    var details = function (m) {
      return tmdb('/' + typeOf(m) + '/' + m.id, { language: 'en-US' }).then(function (d) { return d || {}; }, function () { return {}; });
    };
    var anchorP = anchor ? details(anchor) : Promise.resolve(null);
    return anchorP.then(function (ad) {
      var anchorSet = new Set(studios(ad));
      var recent = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
      var anchorKey = anchor ? keyOf(anchor) : '';
      return Promise.all(items.map(function (m) {
        if (!looksReal(m)) return null;
        if (keyOf(m) === anchorKey || m._inCollection) return m;
        // A well-known title that STARTS with the query is the franchise
        // ("One Piece: Stampede"). One that only contains it ("Woochi: The Demon
        // Slayer") must prove it, by sharing a studio or network with the anchor.
        var starts = q && splitDigits(norm(titleOf(m))).replace(/^the /, '').indexOf(q.replace(/^the /, '')) === 0;
        // ...and "well-known" means a real audience: a 1916 silent film that
        // happens to be called "Avatar" has ten votes, not fifty.
        if ((starts && (m.vote_count || 0) >= 50) || (trusted(m) && !anchorSet.size)) return m;
        if (trusted(m)) {
          return details(m).then(function (d) {
            return studios(d).some(function (x) { return anchorSet.has(x); }) ? m : null;
          });
        }
        // Fresh releases have not collected votes yet; keep them if TMDB
        // shows any real interest.
        if (dateOf(m) >= recent && (m.popularity || 0) >= 1.5) return m;
        return details(m).then(function (d) {
          var st = studios(d);
          if (!st.length) return null;                                         // nobody made it
          var rt = d.runtime || ((d.episode_run_time || [])[0]) || 0;
          // A little-known "movie" under 40 minutes is a clip, promo or a TV
          // episode filed as a film (Ben 10 Break Room, Merry Christmas).
          if (typeOf(m) === 'movie' && rt < 40) return null;
          if (anchorSet.size && !st.some(function (x) { return anchorSet.has(x); })) return null; // fan film
          return m;
        });
      })).then(function (list) { return list.filter(Boolean); });
    });
  }

  /**
   * The full results page. Returns ONLY what was searched for and its official
   * franchise: the best-matching title first, then the rest of the franchise in
   * release order. No "related" filler. Never mutates the cached results.
   *
   *   "ek tha tiger" -> Ek Tha Tiger, Tiger Zinda Hai, Tiger 3
   *   "ben 10"       -> the Ben 10 series and official films, no fan clips
   *   "panchayat"    -> Panchayat (the series), not every film with the word
   */
  function franchise(query, fixed, movies, tmdb, person) {
    var q = splitDigits(norm(fixed || query));
    var qTokens = q.split(' ').filter(Boolean);
    if (person && person.id && isPerson(query, person, movies)) return filmography(person, movies, tmdb);
    if (!q || (movies[0] && movies[0]._matchedPerson)) return Promise.resolve(movies);

    // The original-language title counts only on whole-word equality: a
    // prefix match there let "shin chan" pull in "Shinjitsu ... Chanpuru".
    var strong = movies.filter(function (m) {
      if (coversQuery(titleOf(m), qTokens)) return true;
      var orig = splitDigits(norm(m.original_title || m.original_name || '')).split(' ');
      return orig.length > 1 && qTokens.every(function (t) { return orig.indexOf(t) !== -1; });
    }).map(function (m) { return Object.assign({}, m); });

    // Nothing is clearly about the query (a vague word like "love"): keep the
    // ranked list, but only titles with a real audience.
    if (!strong.length) {
      return Promise.resolve(movies.filter(function (m) { return m.poster_path && (m.vote_count || 0) >= 10; }).slice(0, 24));
    }

    // Compare without a leading article: "conjuring" is "The Conjuring".
    var core = function (t) { return splitDigits(norm(t)).replace(/^(the|a|an) /, ''); };
    var qc = core(q);
    var exact = strong.filter(function (m) { return core(titleOf(m)) === qc; });
    var pick = function (list) { return list.slice().sort(function (a, b) { return fame(b) - fame(a); })[0]; };
    var anchor = pick(exact.filter(trusted)) || pick(strong.filter(trusted)) || pick(exact) || pick(strong);
    // "kalki": the 2019 film is the exact title, but Kalki 2898-AD is the one
    // people mean. A far better-known title that starts with the query leads.
    var famous = pick(strong.filter(function (m) { return trusted(m) && core(titleOf(m)).indexOf(qc) === 0; }));
    if (famous && famous !== anchor && fame(famous) > fame(anchor) * 1.6) anchor = famous;
    var isExact = function (m) { return core(titleOf(m)) === qc; };
    // "spider man", "ben 10", "squid game": the query names a whole franchise
    // when several known titles are "<query>: something" or "<query> 2".
    var esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[^a-z0-9]*');
    var subtitled = new RegExp('^' + esc + '\\s*([:\\-\u2013\u2014]|\\d)', 'i');
    var franchiseName = strong.filter(function (m) { return trusted(m) && subtitled.test(norm(titleOf(m)).replace(/ (\d)/g, ' $1') ) || (trusted(m) && subtitled.test(titleOf(m).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/-/g, ' '))); }).length >= 2;

    // Collections: the anchor's own (Ek Tha Tiger -> Tiger Collection) plus any
    // collection named like the query (Housefull Collection).
    var cq = q.replace(/ (\d{1,2}|part \d+)$/, '');
    var ownColl = typeOf(anchor) === 'movie'
      ? tmdb('/movie/' + anchor.id, { language: 'en-US' }).then(function (d) { return d && d.belongs_to_collection ? [d.belongs_to_collection.id] : []; }, function () { return []; })
      : Promise.resolve([]);
    var named = function (term) {
      return tmdb('/search/collection', { query: term, language: 'en-US', page: '1' }).then(function (r) {
        return (r && r.results || []).filter(function (c) { return collectionMatches(c.name, q) || collectionMatches(c.name, term); }).map(function (c) { return c.id; });
      }, function () { return []; });
    };
    return ownColl.then(function (own) {
      // The anchor's own collection is authoritative ("tiger 3" -> Tiger
      // Collection, not Tiger Cage or Tiger & Bunny). Name search is only for
      // franchise-name queries whose top hit has none (a TV anchor like Ben 10).
      if (own.length) return [own, []];
      return named(q).then(function (ids) { return [[], ids]; });
    }).then(function (r) {
      var ids = Array.from(new Set(r[0].concat(r[1]))).slice(0, 4);
      return Promise.all(ids.map(function (id) {
        return tmdb('/collection/' + id, { language: 'en-US' }).then(function (d) { return (d && d.parts) || []; }, function () { return []; });
      }));
    }).then(function (partLists) {
      var parts = [].concat.apply([], partLists);
      var anchorIsExact = isExact(anchor) && trusted(anchor);
      // What stays next to the anchor:
      //  - the anchor's franchise exists (movie collection): the anchor and its
      //    parts only. "tiger 3" -> the Tiger films, not "Glass Tiger 3".
      //  - an exact film title with no franchise ("animal"): that film and
      //    other well-known films with exactly that title.
      //  - otherwise (a series, a franchise name like "ben 10"): every vetted
      //    title that is about the query.
      var keep = strong;
      if (!franchiseName && typeOf(anchor) === 'movie') {
        if (parts.length) keep = strong.filter(function (m) { return keyOf(m) === keyOf(anchor) || (isExact(m) && (m.vote_count || 0) >= 50 && !/\d/.test(q)); });
        else if (anchorIsExact) keep = strong.filter(function (m) { return isExact(m) && trusted(m); });
      }
      var byKey = new Map();
      keep.forEach(function (m) { byKey.set(keyOf(m), m); });
      parts.forEach(function (p) {
        if (!p || !p.id) return;
        var k = 'movie:' + p.id;
        var have = byKey.get(k);
        if (have) have._inCollection = true;
        else byKey.set(k, Object.assign({}, p, { media_type: 'movie', _inCollection: true, _matchQuality: 'Franchise' }));
      });
      var anchorKey = keyOf(anchor);
      if (byKey.has(anchorKey) && byKey.get(anchorKey)._inCollection) anchor._inCollection = true;
      return vet(Array.from(byKey.values()), anchor, tmdb, q);
    }).then(function (list) {
      // A barely-voted film with the same title as a series in the list is a
      // compilation of that series (Ben 10: Omniverse, 2012): show the series.
      var seriesTitles = new Set(list.filter(function (m) { return typeOf(m) === 'tv'; }).map(function (m) { return norm(titleOf(m)); }));
      var spam = list.filter(function (m) {
        if (SPAM.test(titleOf(m))) return false;
        return !(typeOf(m) === 'movie' && !m._inCollection && (m.vote_count || 0) < 10 && seriesTitles.has(norm(titleOf(m))));
      });
      var anchorKey = keyOf(anchor);
      var head = spam.filter(function (m) { return keyOf(m) === anchorKey; });
      var rest = spam.filter(function (m) { return keyOf(m) !== anchorKey; })
        .sort(function (a, b) { return String(dateOf(a) || '9999').localeCompare(String(dateOf(b) || '9999')); });
      var out = head.concat(rest).map(function (m) { return Object.assign({}, m, { media_type: typeOf(m) }); });
      return out.length ? out : movies.filter(function (m) { return keyOf(m) === anchorKey; });
    });
  }

  /**
   * Same rules for the live dropdown, without network calls: only titles that
   * are about the query, and none of the empty TMDB stubs (no poster, no date,
   * no votes). Falls back to the ranked list when nothing matches strictly.
   */
  function strict(list, query, fixed, personFound) {
    if (!list || !list.length || personFound) return list;
    var qTokens = splitDigits(norm(fixed || query)).split(' ').filter(Boolean);
    var typedTokens = splitDigits(norm(query)).split(' ').filter(Boolean);
    var about = list.filter(function (m) {
      var t = titleOf(m);
      return coversQuery(t, qTokens) || coversQuery(t, typedTokens);
    });
    if (!about.length) return list.filter(function (m) { return (m.vote_count || 0) >= 10 || m._matchedPerson; });
    return about.filter(function (m) {
      if (!m.poster_path || !dateOf(m)) return false;
      return (m.vote_count || 0) >= 3 || (m.popularity || 0) >= 1.5;
    });
  }

  loadVocab();
  /** "Did you mean" only for a real correction: "demon slayer" is not a typo
   *  of "Demon Slayer: Kimetsu no Yaiba", it is the start of it. */
  function correction(query, c) {
    if (!c) return c;
    var q = splitDigits(norm(query)).replace(/ /g, ''), t = splitDigits(norm(c)).replace(/ /g, '');
    return q && t.indexOf(q) === 0 ? null : c;
  }

  window.MZSearchPlus = { correction: correction, correct: correct, isPerson: isPerson, strict: strict, useFix: useFix, curated: curated, merge: merge, order: order, franchise: franchise, _distance: distance, _phoneticKey: phoneticKey, _norm: norm, version: 1 };
})();
