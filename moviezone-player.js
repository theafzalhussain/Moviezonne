async function openModal(id, type = 'movie', activationEvent) {
  if (!claimExplicitDetailActivation(activationEvent)) return;
  // Add hash to URL to behave like a separate page
  window.history.pushState({ watchPage: true }, '', '#watch-' + type + '-' + id);
  if (isMzTV()) lastFocusedElement = document.activeElement;
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
 
  // 1. INSTANT UI OPEN (Bina backend wait kiye instantly page open karo)
  /*  INP — the scroll reset comes BEFORE the class flip on purpose. The overlay
   *  is display:none until .open lands, so writing scrollTop here is free;
   *  writing it afterwards forced a full synchronous layout of the entire modal
   *  subtree inside the click handler, which was the most expensive single thing
   *  the interaction did. primePlayerSurface() repeats it after the paint for
   *  engines that restore a remembered offset. */
  overlay.scrollTop = 0;
  overlay.classList.add('open');
  if (!isMzTV()) {
    document.body.style.overflow = 'hidden';
  }
 
  const titleEl = document.getElementById('modalTitle');
  const descEl = document.getElementById('modalDesc');
  const bgEl = document.getElementById('modalBg');
  const metaEl = document.getElementById('modalMeta');
  const embedEl = document.getElementById('videoEmbed');
  
  const seeded = findSeededTitleData(id);
  if (titleEl) titleEl.textContent = (seeded && (seeded.title || seeded.name)) || 'Loading...';
  if (descEl) descEl.textContent = (seeded && seeded.overview) || 'Fetching high-speed servers...';
  if (metaEl) metaEl.innerHTML = modalMetaSkeleton();
  if (bgEl) {
    bgEl.src = '';
    bgEl.classList.remove('blur-in');
    bgEl.style.opacity = ''; // Reset opacity so CSS can take over
  }
  if (embedEl) embedEl.innerHTML =
    '<div class="video-placeholder">' +
      '<div class="player-spinner" style="width:55px; height:55px; border-color:rgba(255,255,255,0.1); border-left-color:var(--gold);"></div>' +
      '<p style="color:var(--gold); margin-top:15px; font-weight:600;">Establishing secure connection...</p>' +
    '</div>';
 
  // Saare servers aur buttons instantly show karo taaki user immediately click kar sake
  //
  // Deliberately synchronous: #externalSources is 450-700px of the modal on a
  // phone, so deferring it past the opening frame would trade INP for a shift
  // of the same block. It renders from a static list — the cost is the
  // innerHTML write, not a fetch.
  try { renderExternalSources(id, getSelectedSourceIdx(), getSelectedLang()); } catch(e){}

  // CLS: the related row is display:none until the detail fetch resolves, then
  // adds ~350px inside .modal-bottom. Reserving it here means the modal reaches
  // its full height in the frame it opens instead of growing under the user.
  try { primeRelatedSection(); } catch (e) {}

  // INP: the frame above is what the tap is waiting on. Everything below is
  // preparation for a click that has not happened yet, so hand the frame back
  // before starting it. Ordering is unchanged, only the paint boundary moved.
  await mzYieldToPaint();

  // ⚡ SPEED: provider handshake details aane se pehle shuru kar do.
  //
  // Order matters here. warmPlayerConnection() warms the host this user is
  // ACTUALLY going to stream from (their saved server, anime-corrected), so it
  // goes first and gets the idle connection. preconnectPlayerHosts used to run
  // ahead of it with a limit of 6, meaning six speculative DNS+TCP+TLS
  // handshakes were opened before the one host that mattered — competing with
  // the TMDB detail fetch, the backdrop image and the prewarm iframe for the
  // same connection budget on a phone.
  //
  // Two fallbacks are kept warm because the realistic failure mode is the user
  // clicking one alternate server, not six — and they are the servers the retry
  // chain would genuinely reach, not a fixed slice of an unrelated list.
  try {
    resetTriedSources();   // fresh title, fresh retry chain
    warmPlayerConnection(id, type);
    warmRankedFallbacks(id, type, getSelectedLang(), 2);
  } catch(e){}
 
  try {
    /*  tmdb() is only async after its cache lookups: it does a synchronous
     *  localStorage.getItem plus a JSON.parse of a 20-50 KB payload before it
     *  ever awaits, and for this endpoint (append_to_response=videos,credits)
     *  that is ~70ms. It is already off the interaction because the
     *  mzYieldToPaint() above committed the frame first — worth knowing before
     *  anything is moved back above that boundary. */
    const details = await tmdb('/'+type+'/'+id, detailParams('videos,credits'));

    /*  TMDB has no record for this id — confirmed 404, already logged silently by
     *  tmdb(). Every field below would be undefined, which left the modal sitting
     *  on "Loading..." and a spinner forever: the user gets no content and no
     *  explanation, and the only way out is the close button.
     *
     *  "Silently skip" cannot mean nothing here, because the user deliberately
     *  tapped this card. So: close the modal, say one calm sentence, and drop the
     *  dead entry from Continue Watching / Watchlist so it stops coming back.
     */
    if (details && details._mzMissing) {
      try { closeModal(); } catch (e) {}
      _mzForgetDeadTitle(id, type);
      if (typeof showToast === 'function') showToast('This title is no longer available.');
      return;
    }

    details.media_type = type;
    currentModalMovie = details;
    const bgEl = document.getElementById('modalBg');
    const imgPath = details.backdrop_path || details.poster_path;

    if (bgEl) {
      if (imgPath) {
        bgEl.onload = () => { 
          bgEl.classList.add('blur-in');
          bgEl.style.opacity = '1'; 
        };
        bgEl.src = details.backdrop_path ? getResponsiveBackdrop(details.backdrop_path) : IMG + imgPath;
      } else {
        bgEl.style.opacity = '1';
      }
    }
 
    // --- HOVER TRAILER LOGIC (Smart Auto-Fallback) ---
    let bestVids = [];
    if (details.videos && details.videos.results) {
      const ytVids = details.videos.results.filter(v => v.site === 'YouTube');
      const trailers = ytVids.filter(v => v.type === 'Trailer');
      const teasers = ytVids.filter(v => v.type === 'Teaser');
      // Queue banate hain: Unofficial pehle, fir official. Taki block hone par fallback kiya ja sake.
      bestVids = [
        ...trailers.filter(v => !v.official),
        ...teasers.filter(v => !v.official),
        ...trailers.filter(v => v.official),
        ...teasers.filter(v => v.official)
      ];
      if (bestVids.length === 0 && ytVids.length > 0) bestVids = ytVids;
    }
    const imageWrapper = document.querySelector('.modal-image-wrapper');
    const eventContainer = document.querySelector('.modal-top');
    if (eventContainer && imageWrapper) {
      let tc = document.getElementById('trailerContainer');
      if (tc) tc.remove();

      /*  The trailer indicator is conditional, and that is half the bug report.
       *  It used to be appended unconditionally, so titles TMDB has no video for
       *  still advertised a play icon — you hover, nothing happens, and the
       *  feature looks broken rather than absent. Measured on a 54-title sample,
       *  12 titles genuinely have no video at all even with every video language
       *  requested, so this case is common and has to be handled honestly.
       *  It is also removed on TV, where hover trailers never run. */
      const canPlayTrailer = bestVids.length > 0 && !isMzTV();
      let trailerIndicator = imageWrapper.querySelector('.modal-trailer-indicator');
      if (canPlayTrailer && !trailerIndicator) {
        trailerIndicator = document.createElement('div');
        trailerIndicator.className = 'modal-trailer-indicator';
        // Just the icon, as requested
        trailerIndicator.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
        imageWrapper.appendChild(trailerIndicator);
      } else if (!canPlayTrailer && trailerIndicator) {
        trailerIndicator.remove();
      }

      // Clear any previous listeners to prevent memory leaks
      eventContainer.onclick = null;
      eventContainer.onmouseenter = null;
      eventContainer.onmouseleave = null;

      if (canPlayTrailer) {
        let currentVidIdx = 0;
        let trailerKey = bestVids[currentVidIdx].key;
 
        tc = document.createElement('div');
        tc.id = 'trailerContainer';
        tc.style.cssText = 'position:absolute; inset:0; z-index:10; display:none; background:#000; transition:opacity 0.4s ease; opacity:0; overflow:hidden; border-radius:12px;';
        imageWrapper.appendChild(tc);
 
        let trailerTimeout;
        let ytErrHandler = null;

        const playTrailer = () => {
            if (!tc) return;
            tc.style.display = 'block';
            setTimeout(() => { tc.style.opacity = '1'; }, 50);
            // Hide the play button while the trailer is actually playing
            if (trailerIndicator) trailerIndicator.classList.add('is-hidden');
            // Hide only the meta section (cast, genres, crew, production) when trailer plays
            const modalMeta = document.getElementById('modalMeta');
            if (modalMeta) modalMeta.classList.add('meta-hidden');
            const modalGrad = document.querySelector('.modal-gradient');
            if (modalGrad) modalGrad.style.opacity = '0.3';
 
            const getYTUrl = (key) => `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&loop=1&playlist=${key}&enablejsapi=1&iv_load_policy=3&origin=${encodeURIComponent(window.location.origin)}`;
 
            tc.innerHTML = `
              <div id="trailerLoader" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; z-index:5; background:rgba(0,0,0,0.6); transition:opacity 0.4s ease; backdrop-filter:blur(4px);">
                <div class="player-spinner" style="width:36px; height:36px; border-width:3px;"></div>
              </div>
              <iframe id="ytHoverPlayer" src="${getYTUrl(trailerKey)}" style="width:100%; height:100%; border:none; transform:scale(1.3); pointer-events:none; opacity:0; transition:opacity 0.5s ease;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
              <button id="trailerMuteBtn" style="position:absolute; top:20px; right:20px; z-index:10; background:rgba(0,0,0,0.6); color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:50%; width:44px; height:44px; cursor:pointer; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px); transition:all 0.3s ease; box-shadow: 0 4px 12px rgba(0,0,0,0.4);">
                <svg id="iconMuted" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                <svg id="iconUnmuted" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" style="display:none;"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
              </button>
            `;
 
            const ytFrame = tc.querySelector('#ytHoverPlayer');
            const ytLoader = tc.querySelector('#trailerLoader');
 
            if (ytFrame) {
              ytFrame.onload = () => {
                setTimeout(() => {
                  if (ytLoader) { ytLoader.style.opacity = '0'; setTimeout(() => { if (ytLoader.parentNode) ytLoader.remove(); }, 400); }
                  if (ytFrame) ytFrame.style.opacity = '1';
                }, 800);
              };
            }
 
            ytErrHandler = (e) => {
              try {
                if (e.origin && !e.origin.includes('youtube')) return;
                let d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
                if (!d) return;
 
                if ((d.event === 'onStateChange' && d.info === 1) || (d.event === 'infoDelivery' && d.info && d.info.playerState === 1)) {
                  if (ytLoader) { ytLoader.style.opacity = '0'; setTimeout(() => { if (ytLoader.parentNode) ytLoader.remove(); }, 400); }
                  if (ytFrame) ytFrame.style.opacity = '1';
                  // Playing → hide the play button
                  if (trailerIndicator) trailerIndicator.classList.add('is-hidden');
                }

                // Paused (2) or ended (0) → bring the play button back
                const _ps = (d.event === 'onStateChange') ? d.info : (d.info && d.info.playerState);
                if (_ps === 2 || _ps === 0) {
                  if (trailerIndicator) trailerIndicator.classList.remove('is-hidden');
                }
 
                if (d.event === 'onError' || d.event === 'error' || d.info === 150 || d.info === 153 || d.info === 101 || (d.info && d.info.playerState === -1 && d.info.videoData && d.info.videoData.errorCode)) {
                  currentVidIdx++;
                  if (currentVidIdx < bestVids.length) {
                    trailerKey = bestVids[currentVidIdx].key;
                    if (ytFrame) {
                      ytFrame.style.opacity = '0';
                      ytFrame.src = getYTUrl(trailerKey);
                    }
                  } else {
                    tc.style.opacity = '0';
                    setTimeout(() => { if (tc && tc.parentNode) tc.remove(); }, 400);
                  }
                }
              } catch(err) {}
            };
            window.addEventListener('message', ytErrHandler);
 
            const muteBtn = tc.querySelector('#trailerMuteBtn');
            let isMuted = true;
            
            muteBtn.onmouseenter = () => { muteBtn.style.background = 'rgba(245,197,24,0.9)'; muteBtn.style.color = '#000'; muteBtn.style.transform = 'scale(1.1)'; };
            muteBtn.onmouseleave = () => { muteBtn.style.background = 'rgba(0,0,0,0.6)'; muteBtn.style.color = '#fff'; muteBtn.style.transform = 'scale(1)'; };
            
            muteBtn.onclick = (e) => {
              e.stopPropagation();
              const frame = tc.querySelector('#ytHoverPlayer');
              if (frame && frame.contentWindow) {
                if (isMuted) {
                  frame.contentWindow.postMessage('{"event":"command","func":"unMute","args":""}', '*');
                  tc.querySelector('#iconMuted').style.display = 'none';
                  tc.querySelector('#iconUnmuted').style.display = 'block';
                } else {
                  frame.contentWindow.postMessage('{"event":"command","func":"mute","args":""}', '*');
                  tc.querySelector('#iconUnmuted').style.display = 'none';
                  tc.querySelector('#iconMuted').style.display = 'block';
                }
                isMuted = !isMuted;
              }
            };
        };

        const stopTrailer = () => {
            clearTimeout(trailerTimeout);
            // Bring the play button back when the trailer stops/pauses
            if (trailerIndicator) trailerIndicator.classList.remove('is-hidden');
            if (ytErrHandler) {
                window.removeEventListener('message', ytErrHandler);
                ytErrHandler = null;
            }
            if (tc) {
                tc.style.opacity = '0';
                setTimeout(() => { if(tc) { tc.style.display = 'none'; tc.innerHTML = ''; } }, 400);
            }
            // Show meta section back when trailer stops
            const modalMeta = document.getElementById('modalMeta');
            if (modalMeta) modalMeta.classList.remove('meta-hidden');
            const modalGrad = document.querySelector('.modal-gradient');
            if (modalGrad) modalGrad.style.opacity = '1';
        };
        activeTrailerStopper = stopTrailer; // Register the stopper

        // Device-aware interaction: Click for mobile, Hover for desktop
        if (isMobile || isTouchOnly) {
            let trailerIsPlaying = false;
            eventContainer.onclick = (e) => {
                // Stop if the click was on any interactive element (buttons, links, selects, etc.)
                if (e.target.closest('button, a, select, input')) return;
                
                if (!trailerIsPlaying) {
                    playTrailer();
                    trailerIsPlaying = true;
                } else {
                    stopTrailer();
                    trailerIsPlaying = false;
                }
            };
        } else { // Desktop: click-to-play only (hover-play disabled as requested)
            let trailerIsPlaying = false; // Keep track of state

            // Hover no longer auto-plays the trailer. The thumbnail stays put and
            // only the play indicator gently reacts, so nothing starts until the
            // user actually clicks.

            // Click to toggle play/stop
            eventContainer.onclick = (e) => {
                // Ignore clicks on buttons inside the container
                if (e.target.closest('button, a, select, input')) return;

                if (!trailerIsPlaying) {
                    playTrailer();
                    trailerIsPlaying = true;
                } else {
                    stopTrailer();
                    trailerIsPlaying = false;
                }
            };
        }
      }
    }
    const titleEl = document.getElementById('modalTitle');
    if (titleEl) titleEl.textContent = details.title || details.name || '';
    const descEl = document.getElementById('modalDesc');
    if (descEl) descEl.textContent = details.overview || '';
    const runtime = details.runtime ? (Math.floor(details.runtime/60)+'h '+(details.runtime%60)+'m') : 'N/A';
    const genres  = (details.genres||[]).slice(0,3).map(g => '<span class="genre-tag">'+escapeHTML(g.name)+'</span>').join('');
    
    // --- Audio Information Badge ---
    const tmdbLangs = (details.spoken_languages || []).map(l => l.iso_639_1);
    const hasDubbed = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'].some(lang => tmdbLangs.includes(lang));
    const audioBadge = hasDubbed 
      ? '<div class="modal-badge" style="background: linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05)); border-color: rgba(16,185,129,0.3); color: #10b981;" title="Available in Hindi/Regional Languages"> DUBBED AVAILABLE</div>'
      : '<div class="modal-badge" style="background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02)); border-color: rgba(255,255,255,0.15); color: #bbb;" title="Only Original Audio Available"> ORIGINAL AUDIO</div>';

    const metaEl  = document.getElementById('modalMeta');
    if (metaEl) {
      // -- PREMIUM META BADGES --
      let metaHTML = '<div class="modal-meta-badges">';
      metaHTML += '<div class="modal-badge modal-badge-rating"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg> '+((details.vote_average||0).toFixed(1))+' <span class="modal-badge-sub">('+((details.vote_count||0).toLocaleString())+' votes)</span></div>';
      metaHTML += '<div class="modal-badge"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z"/></svg> '+((details.release_date||details.first_air_date||'').slice(0,4))+'</div>';
      metaHTML += '<div class="modal-badge"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z"/></svg> '+runtime+'</div>';
      if (details.original_language) metaHTML += '<div class="modal-badge">🌐 '+(details.original_language).toUpperCase()+'</div>';
      if (details.budget > 0) metaHTML += '<div class="modal-badge">💰 $'+(details.budget/1000000).toFixed(0)+'M</div>';
      if (details.revenue > 0) metaHTML += '<div class="modal-badge modal-badge-revenue">📈 $'+(details.revenue/1000000).toFixed(0)+'M</div>';
      metaHTML += audioBadge;
      metaHTML += '</div>';
      
      // -- GENRES --
      metaHTML += '<div class="modal-genres-row">'+genres+'</div>';
      
      // -- TAGLINE --
      if (details.tagline) {
        metaHTML += '<div class="modal-tagline">"'+escapeHTML(details.tagline)+'"</div>';
      }
      
      // -- DIRECTOR & WRITER --
      if (details.credits && details.credits.crew) {
        const directors = details.credits.crew.filter(c => c.job === 'Director').slice(0, 2);
        const writers = details.credits.crew.filter(c => c.job === 'Screenplay' || c.job === 'Writer').slice(0, 2);
        if (directors.length > 0 || writers.length > 0) {
          metaHTML += '<div class="modal-crew-row">';
          if (directors.length > 0) metaHTML += '<span class="modal-crew-item"><span class="modal-crew-label">Director</span> '+directors.map(d => escapeHTML(d.name)).join(', ')+'</span>';
          if (writers.length > 0) metaHTML += '<span class="modal-crew-item"><span class="modal-crew-label">Writer</span> '+writers.map(w => escapeHTML(w.name)).join(', ')+'</span>';
          metaHTML += '</div>';
        }
      }
      
      // -- CAST (Top 8 with photos) --
      if (details.credits && details.credits.cast && details.credits.cast.length > 0) {
        const topCast = details.credits.cast.slice(0, 8);
        metaHTML += '<div class="modal-cast-section"><div class="modal-cast-label">Cast</div><div class="modal-cast-row">';
        topCast.forEach(person => {
          const imgSrc = person.profile_path 
            ? 'https://image.tmdb.org/t/p/w185'+person.profile_path 
            : 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22><rect width=%2248%22 height=%2248%22 rx=%2224%22 fill=%22%23222%22/><text x=%2224%22 y=%2230%22 fill=%22%23555%22 text-anchor=%22middle%22 font-size=%2216%22>👤</text></svg>';
          metaHTML += '<div class="modal-cast-chip" title="'+escapeHTML(person.name)+' as '+escapeHTML(person.character||'')+'">' +
            '<img src="'+imgSrc+'" alt="'+escapeHTML(person.name)+'" width="48" height="48" loading="lazy" decoding="async">' +
            '<div class="modal-cast-info"><span class="modal-cast-name">'+escapeHTML(person.name)+'</span><span class="modal-cast-char">'+escapeHTML(person.character||'')+'</span></div>' +
          '</div>';
        });
        metaHTML += '</div></div>';
      }
      
      // -- PRODUCTION COMPANIES --
      if (details.production_companies && details.production_companies.length > 0) {
        metaHTML += '<div class="modal-production-row">';
        details.production_companies.slice(0, 4).forEach(company => {
          if (company.logo_path) {
            metaHTML += '<div class="modal-prod-chip"><img src="https://image.tmdb.org/t/p/w92'+company.logo_path+'" alt="'+escapeHTML(company.name)+'" title="'+escapeHTML(company.name)+'" width="92" height="61" loading="lazy" decoding="async"></div>';
          } else {
            metaHTML += '<div class="modal-prod-chip modal-prod-text">'+escapeHTML(company.name)+'</div>';
          }
        });
        metaHTML += '</div>';
      }
      
      metaEl.innerHTML = metaHTML;
    }
    const embedEl = document.getElementById('videoEmbed');
    // Poster frame: the backdrop the header just loaded (same URL, cache hit).
    const posterSrc = bgEl && imgPath ? escapeHTML(bgEl.getAttribute('src') || '') : '';
    if (embedEl) embedEl.innerHTML =
      '<div class="video-placeholder' + (posterSrc ? ' has-poster" style="background-image:url(&quot;' + posterSrc + '&quot;)' : '') + '">' +
        '<button class="play-big" id="playBigBtn" aria-label="Play" title="Play">' +
          '<svg viewBox="0 0 24 24" width="44" height="44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<path d="M5 3v18l15-9L5 3z" fill="white" />' +
          '</svg>' +
        '</button>' +
        '<p>Press play to start watching</p>' +
      '</div>';
    const pb = document.getElementById('playBigBtn');
    if (pb) pb.addEventListener('click', playMovie);

    /*  Resume path: a Continue Watching card sets _mzAutoPlayOnOpen, and this is the
     *  first point at which playback can actually start — the details are loaded, so
     *  the runtime and (for a series) the saved season/episode are known, which is
     *  exactly what the watch session and the resume offset need. One-shot: cleared
     *  immediately so a later modal opened normally does not auto-play. */
    if (window._mzAutoPlayOnOpen) {
      window._mzAutoPlayOnOpen = false;
      setTimeout(() => { try { playMovie(); } catch (e) {} }, 0);
    }

    // ⚡ INSTANT PLAY: stream ko background me abhi resolve karna shuru kar do
    // (anime ke liye pehle AniList id, taaki double-load na ho)
    try {
      if (isAnimeContent(details)) {
        const sel0 = currentEpisodeSelection();
        const known = getAnilistIdSync(details, sel0.s);
        if (known === null) {
          resolveAnilistId(details, sel0.s)
            .then(() => { if (currentModalMovie && currentModalMovie.id === details.id) prewarmPlayer(details.id, type); })
            .catch(() => prewarmPlayer(details.id, type));
        } else {
          schedulePlayerPrewarm(details.id, type, 120);
        }
      } else {
        schedulePlayerPrewarm(details.id, type, 120);
      }
    } catch(e){}

    // Play button par hover/focus/touch hote hi prewarm pakka kar do
    try {
      if (pb) {
        ['mouseenter', 'focus', 'touchstart'].forEach(evt => {
          pb.addEventListener(evt, () => prewarmPlayer(details.id, type), { passive: true });
        });
      }
      if (!window._mzPlayHoverBound) {
        window._mzPlayHoverBound = true;
        const mainPlayBtn = document.querySelector('.modal-actions .btn-play');
        if (mainPlayBtn) {
          ['mouseenter', 'focus', 'touchstart'].forEach(evt => {
            mainPlayBtn.addEventListener(evt, () => {
              // Handler ek hi baar bind hota hai, isliye current movie hi use karo
              if (currentModalMovie) prewarmPlayer(currentModalMovie.id, currentModalMovie.media_type || 'movie');
            }, { passive: true });
          });
        }
      }
    } catch(e){}
    try { setSelectedLang(getSelectedLang()); } catch(e) {}
    try { setSelectedQuality(getSelectedQuality()); } catch(e) {}
    
    const ls = document.getElementById('langSelect');
    if (ls) ls.onchange = () => { if(embedEl.querySelector('iframe')) playMovie(); };
    
    const qs = document.getElementById('qualitySelect');
    if (qs) qs.onchange = () => { if(embedEl.querySelector('iframe')) playMovie(); };
    
    const tvGroup = document.getElementById('tvSelectGroup');
    if (tvGroup) {
      tvGroup.style.display = type === 'tv' ? 'block' : 'none';
      if (type === 'tv') {
        /*  Season / episode picker: two glass fields with the label inside the
         *  box, then a Netflix-style rail with one thumbnail tile per episode of
         *  the season (still, number, runtime, rating or air date, two lines of
         *  synopsis, and the viewer's own progress). Tapping a tile plays it.
         *  The two <select>s stay the source of truth: playNextEpisode() and
         *  currentEpisodeSelection() read them, so their ids must not change, and
         *  the rail only ever writes to them and mirrors them back. */
        const railArrow = (dir, pts) => '<button type="button" class="ep-rail-arrow" data-ep-scroll="' + dir +
          '" aria-label="' + (dir < 0 ? 'Previous' : 'Next') + ' episodes" disabled><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="' + pts + '"/></svg></button>';
        tvGroup.innerHTML =
          '<div class="ep-fields">' +
            '<label class="ep-field"><span class="ep-label">Season</span>' +
              '<select id="seasonInput" class="ep-select"></select></label>' +
            '<label class="ep-field ep-field--wide"><span class="ep-label">Episode<i id="episodeCount"></i></span>' +
              '<select id="episodeInput" class="ep-select"></select></label>' +
          '</div>' +
          '<div class="ep-rail-head"><span class="ep-rail-title" id="episodeRailTitle">Episodes</span>' +
            '<span class="ep-rail-nav" hidden>' + railArrow(-1, '15 18 9 12 15 6') + railArrow(1, '9 18 15 12 9 6') + '</span></div>' +
          '<div class="ep-rail" id="episodeRail" role="group" aria-labelledby="episodeRailTitle"></div>';
        const sInput = document.getElementById('seasonInput');
        const eInput = document.getElementById('episodeInput');
        const seasons = (details.seasons || []).filter(s => s.season_number > 0);
        
        if (seasons.length > 0) {
          // -- CONTINUE WATCHING LOGIC --
          let lastS = seasons[0].season_number;
          let lastE = 1;
          try {
            const progress = JSON.parse(localStorage.getItem('mz_progress_' + id));
            if (progress && progress.season && seasons.find(sz => sz.season_number == progress.season)) {
              lastS = progress.season;
              lastE = progress.episode || 1;
            }
          } catch(e) {}
 
          // The season's episode count lives in the Episode label ("10 episodes"),
          // so this option stays short enough for a phone-width field.
          sInput.innerHTML = seasons.map(s => `<option value="${s.season_number}" ${s.season_number == lastS ? 'selected' : ''}>${escapeHTML(s.name || ('Season ' + s.season_number))}</option>`).join('');
          const rail = document.getElementById('episodeRail');
          const railNav = tvGroup.querySelector('.ep-rail-nav');
          const countEl = document.getElementById('episodeCount');
          const railTitle = document.getElementById('episodeRailTitle');
          const smooth = () => (isMzTVMode() ? 'auto' : 'smooth');
          let episodes = [];

          /*  Arrows and the trailing fade follow the rail's real overflow, the same
           *  contract as the provider and universe rails. Reads first, writes after. */
          const syncRailEdges = () => {
            if (!rail || !railNav) return;
            const max = rail.scrollWidth - rail.clientWidth;
            const x = rail.scrollLeft;
            const over = max > 2;
            railNav.hidden = !over;
            railNav.firstChild.disabled = x <= 2;
            railNav.lastChild.disabled = x >= max - 2;
            rail.dataset.edge = !over ? 'none' : x <= 2 ? 'end' : x >= max - 2 ? 'start' : 'both';
          };
          const syncRailEdgesSoon = mzRafThrottle(syncRailEdges);

          // Mirrors the Episode <select> onto the tiles and keeps the pick in view.
          const syncRail = (behavior) => {
            if (!rail) return;
            let active = null;
            rail.querySelectorAll('.ep-tile').forEach((t) => {
              const on = t.dataset.ep === String(eInput.value);
              t.classList.toggle('is-active', on);
              if (on) { t.setAttribute('aria-current', 'true'); active = t; } else t.removeAttribute('aria-current');
            });
            requestAnimationFrame(() => {
              if (active) {
                const left = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
                // Direct assignment where smooth scrolling is not wanted (and on
                // TV engines that predate Element.scrollTo options).
                if (behavior === 'auto' || smooth() === 'auto' || !rail.scrollTo) rail.scrollLeft = left;
                else rail.scrollTo({ left: left, behavior: 'smooth' });
              }
              syncRailEdges();
            });
          };

          const fmtDate = (d) => {
            try { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
          };

          const renderRail = (seasonNum) => {
            if (!rail) return;
            /*  The viewer's own history, per episode: the Continue Watching rows are
             *  keyed id:season:episode, and finished rows live in mz_watched_done. */
            let cw = [], done = [];
            try { cw = JSON.parse(localStorage.getItem('mz_continue_watching')) || []; } catch (e) {}
            try { done = JSON.parse(localStorage.getItem('mz_watched_done')) || []; } catch (e) {}
            const today = new Date();
            const fallback = details.backdrop_path ? 'https://image.tmdb.org/t/p/w300' + details.backdrop_path : '';
            rail.innerHTML = episodes.map((ep) => {
              const n = ep.episode_number;
              const key = Number(id) + ':' + seasonNum + ':' + n;
              const row = cw.find((r) => r && String(r.key) === key);
              const watched = done.indexOf(key) !== -1;
              const pct = watched ? 100 : (row && row.progress > 0 ? Math.min(100, row.progress) : 0);
              const aired = ep.air_date ? new Date(ep.air_date + 'T00:00:00') : null;
              const soon = !!(aired && !isNaN(aired) && aired > today);
              const mins = ep.runtime || 0;
              const time = mins ? (mins >= 60 ? Math.floor(mins / 60) + 'h' + (mins % 60 ? ' ' + (mins % 60) + 'm' : '') : mins + 'm') : '';
              const title = ep.name || ('Episode ' + n);
              const img = ep.still_path ? 'https://image.tmdb.org/t/p/w300' + ep.still_path : fallback;
              const meta = soon
                ? '<b>Airs ' + fmtDate(aired) + '</b>'
                : (ep.vote_average > 0 ? '<b>&#9733; ' + (+ep.vote_average).toFixed(1) + '</b>' : '') +
                  (aired && !isNaN(aired) ? '<span>' + fmtDate(aired) + '</span>' : '');
              return '<button type="button" class="ep-tile' + (soon ? ' is-soon' : '') + (watched ? ' is-done' : '') + '" data-ep="' + n + '"' +
                ' aria-label="' + escapeHTML('Episode ' + n + ': ' + title + (time ? ', ' + time : '') + (soon ? ', not aired yet' : '') + (watched ? ', watched' : '')) + '">' +
                '<span class="ep-tile-still">' +
                  (img ? '<img src="' + img + '" alt="" width="300" height="169" loading="lazy" decoding="async">' : '') +
                  '<span class="ep-tile-num">E' + n + '</span>' +
                  (watched ? '<span class="ep-tile-time">&#10003; Watched</span>' : (time ? '<span class="ep-tile-time">' + time + '</span>' : '')) +
                  '<span class="ep-tile-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>' +
                  (pct ? '<span class="ep-tile-bar"><i style="width:' + pct + '%"></i></span>' : '') +
                '</span>' +
                '<span class="ep-tile-body">' +
                  '<span class="ep-tile-title">' + n + '. ' + escapeHTML(title) + '</span>' +
                  (meta ? '<span class="ep-tile-meta">' + meta + '</span>' : '') +
                  '<span class="ep-tile-desc">' + escapeHTML(ep.overview || 'No description available yet.') + '</span>' +
                '</span>' +
              '</button>';
            }).join('');
            rail.scrollLeft = 0;
            syncRail('auto');
          };

          if (rail) {
            /*  A tile is a play button: it moves the Episode <select> (whose own
             *  change handler resets the retry chain and reloads a running player)
             *  and starts playback if nothing is playing yet — playMovie() scrolls
             *  the player into view. */
            rail.addEventListener('click', (ev) => {
              const tile = ev.target.closest('.ep-tile');
              if (!tile || tile.classList.contains('ep-tile--skel')) return;
              if (String(eInput.value) !== tile.dataset.ep) {
                eInput.value = tile.dataset.ep;
                eInput.dispatchEvent(new Event('change'));
              }
              if (!embedEl.querySelector('iframe')) playMovie();
            });
            // Roving arrow keys along the row. tv-mode.js moves focus itself and
            // marks the event handled, so a remote never steps twice.
            rail.addEventListener('keydown', (ev) => {
              if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
              if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
              const tiles = Array.from(rail.querySelectorAll('.ep-tile'));
              const at = tiles.indexOf(ev.target.closest('.ep-tile'));
              const next = tiles[at + (ev.key === 'ArrowRight' ? 1 : -1)];
              if (at < 0 || !next) return;
              ev.preventDefault();
              next.focus({ preventScroll: true });
              next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth() });
            });
            rail.addEventListener('scroll', syncRailEdgesSoon, { passive: true });
            if (typeof ResizeObserver === 'function') new ResizeObserver(syncRailEdgesSoon).observe(rail);
          }
          if (railNav) railNav.addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-ep-scroll]');
            if (b && !b.disabled) rail.scrollBy({ left: Number(b.dataset.epScroll) * rail.clientWidth * 0.85, behavior: smooth() });
          });
          
          const fetchEpisodes = async (seasonNum, targetEp) => {
            eInput.innerHTML = '<option>Loading episodes…</option>';
            if (rail) rail.innerHTML = '<span class="ep-tile ep-tile--skel"></span>'.repeat(4);
            try {
              const sData = await tmdb('/tv/'+id+'/season/'+seasonNum, { language: 'en-US' });
              episodes = sData.episodes || [];
              eInput.innerHTML = episodes.map(ep => `<option value="${ep.episode_number}">Ep ${ep.episode_number} · ${escapeHTML(ep.name || '')}</option>`).join('');
              if (countEl) countEl.textContent = episodes.length ? episodes.length + (episodes.length === 1 ? ' episode' : ' episodes') : '';
              const sMeta = seasons.find(sz => sz.season_number == seasonNum);
              if (railTitle) railTitle.textContent = (sMeta && sMeta.name) || ('Season ' + seasonNum);
              
              if (targetEp && episodes.find(e => e.episode_number == targetEp)) {
                eInput.value = targetEp;
              }
 
              eInput.onchange = () => { 
                syncRail();
                /*  Naya episode = naya retry chain.
                 *  _mzTriedSources sirf naye title par reset hota tha, episode
                 *  badalne par nahi. Binge karte waqt set har episode ka failure
                 *  jodta rehta tha, to 3-4 episode baad eligible pool khali ho
                 *  jaata aur fallback "wide" branch par gir jaata — jo dub/anime
                 *  eligibility ignore karke server uthata hai. Har episode ko
                 *  poora fallback chain milna chahiye. */
                resetTriedSources();
                if(embedEl.querySelector('iframe')) playMovie(); 
              };
              renderRail(seasonNum);
 
              if(embedEl.querySelector('iframe')) playMovie(); 
            } catch(err) {
              eInput.innerHTML = '<option value="1">Episode 1</option>';
              if (rail) rail.innerHTML = '';
              syncRailEdges();
            }
          };
          
          sInput.onchange = (e) => { resetTriedSources(); fetchEpisodes(e.target.value, 1); }; // Season change   Episode 1
          
          fetchEpisodes(lastS, lastE); // Load last saved or first episode
        }
      }
    }
    
    updateModalWatchlistBtn(id);
 
    // Page khulte hi chupke se background me related movies nikal lo
    loadRelatedMovies(id, type);
 
    // TV ke liye Auto-Focus on Play button
    if (isMzTV()) {
      setTimeout(() => {
        const playBtn = document.querySelector('.play-big') || document.querySelector('.premium-play-btn');
        if (playBtn) playBtn.focus();
      }, 300);
    }
  } catch(e) { console.warn('Modal error', e); }
}
 
// Flag to prevent double-close when history.back() triggers popstate
let _mzModalClosing = false;

function closeModal(fromPopstate) {
  // Prevent double-close
  if (_mzModalClosing) return;
  _mzModalClosing = true;
  setTimeout(() => { _mzModalClosing = false; }, 500);
  
  const overlay = document.getElementById('modal-overlay');
  if (!overlay || !overlay.classList.contains('open')) {
    _mzModalClosing = false;
    return;
  }
  
  // Stop any active trailer
  if (activeTrailerStopper) {
    try { activeTrailerStopper(); } catch(e) {}
  }
  
  // Close the modal UI
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  // Persist and end the accurate watch session started by playMovie(). This is
  // what records the final % and drops the title from Continue Watching if it
  // crossed the completion threshold.
  if (typeof _mzStopWatchSession === 'function') { try { _mzStopWatchSession(); } catch (e) {} }
  const embedEl = document.getElementById('videoEmbed');
  if (embedEl) {
    destroyPrewarm();
    clearSignalWatch();
    embedEl.innerHTML = '';
    embedEl.classList.remove('fullscreen-mode');
  }
  isPlayerFullscreen = false;
  currentModalMovie = null;
  activeTrailerStopper = null;
  const relSec = document.getElementById('relatedMoviesSection');
  if (relSec) relSec.style.display = 'none';
  
  // Cancel any running auto-retry timer
  if (window._mzRetryTimer) { clearTimeout(window._mzRetryTimer); window._mzRetryTimer = null; }
  
  // Clean up URL hash
  if (window.location.hash.startsWith('#watch-')) {
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch(e) {}
  }
  
  // Always go back to home page (fixes the main TV issue where user gets stuck after search)
  if (isSearchResultsMode) {
    isSearchResultsMode = false;
    goHome();
  }
  
  // Restore focus on TV
  if (isMzTV() && lastFocusedElement) {
    setTimeout(() => {
      try { lastFocusedElement.focus(); } catch(e) {}
    }, 150);
  }
}
 
// TV / Phone Back Button Navigation for Watch Page
window.addEventListener('popstate', (e) => {
  // If closeModal is already running, don't trigger again
  if (_mzModalClosing) return;
  
  const overlay = document.getElementById('modal-overlay');
  if (overlay && overlay.classList.contains('open')) {
    // Modal is open — close it on back navigation
    closeModal();
  } else if (window.location.hash.startsWith('#watch-')) {
    // Hash present but modal not open — clean up stale hash
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
});

// Backup: hashchange event (some TV browsers fire this instead of/alongside popstate)
window.addEventListener('hashchange', () => {
  if (_mzModalClosing) return;
  const overlay = document.getElementById('modal-overlay');
  if (!window.location.hash.startsWith('#watch-') && overlay && overlay.classList.contains('open')) {
    closeModal();
  }
});

// Global Back/Escape handler (works even when TV is not detected via UA)
// This catches: Escape, BrowserBack (keyCode 4), Tizen back (10009), WebOS back (461)
document.addEventListener('keydown', (e) => {
  const key = e.key;
  const keyCode = e.keyCode || e.which;
  const isBackKey = key === 'Escape' || key === 'BrowserBack' || key === 'GoBack' ||
    keyCode === 4 || keyCode === 27 || keyCode === 10009 || keyCode === 461 ||
    key === 'XF86Back';
  
  if (!isBackKey) return;
  
  // Don't handle if TV navigation mode is active (it has its own handler)
  if (isMzTV()) return;
  
  const overlay = document.getElementById('modal-overlay');
  const upcomingOverlay = document.getElementById('upcoming-detail-overlay');
  const collectionsOverlay = document.getElementById('collections-hub-overlay');
  
  if (overlay && overlay.classList.contains('open')) {
    closeModal();
    e.preventDefault();
  } else if (upcomingOverlay && upcomingOverlay.classList.contains('open')) {
    if (typeof closeUpcomingDetail === 'function') closeUpcomingDetail();
    e.preventDefault();
  } else if (collectionsOverlay && collectionsOverlay.classList.contains('open')) {
    if (typeof handleCollectionsBack === 'function') handleCollectionsBack();
    e.preventDefault();
  } else if (isSearchResultsMode) {
    // If showing search results, go back to home
    if (typeof goHome === 'function') goHome();
    const si = document.getElementById('searchInput');
    if (si) si.value = '';
    e.preventDefault();
  }
}, true);
 
// -- RELATED MOVIES LOGIC (Advanced Recommendation Engine) --
/*  A placeholder built from the real card's own elements.
 *
 *  The previous skeleton was a flat 170x255 box, but a populated
 *  .related-slider .movie-card measures 307-443px depending on breakpoint —
 *  poster plus title and the meta line. Filling the row therefore
 *  grew it by 75-210px every time. Reusing the card's markup means the box is
 *  correct at every width by construction, with no numbers to keep in sync.
 */
const RELATED_SKELETON = Array(6).fill(
  '<div class="movie-card mz-related-skel" aria-hidden="true">' +
    '<div class="card-poster"><span class="skeleton mz-skel-poster"></span></div>' +
    '<div class="card-info">' +
      '<div class="card-title skeleton mz-skel-text">Placeholder<br>title</div>' +
      '<div class="card-sub skeleton mz-skel-text">0.0 0000</div>' +
      '<div class="card-gen skeleton mz-skel-text">Genre</div>' +
    '</div>' +
  '</div>'
).join('');

/*  Puts the related row into the layout before the detail fetch starts.
 *
 *  loadRelatedMovies() used to be the first thing to reveal this section, which
 *  meant ~350px appeared inside .modal-bottom a full round-trip after the modal
 *  had painted — measured as the largest single shift on the page. Showing the
 *  correctly-sized skeleton up front makes the later fill a pure content swap.
 *  The section still hides itself if the fetch comes back empty.
 */
function primeRelatedSection() {
  const section = document.getElementById('relatedMoviesSection');
  const grid = document.getElementById('relatedMoviesGrid');
  if (!section || !grid) return;
  section.style.display = 'block';
  if (!grid.childElementCount) grid.innerHTML = RELATED_SKELETON;
}

async function loadRelatedMovies(id, type) {
  const section = document.getElementById('relatedMoviesSection');
  const grid = document.getElementById('relatedMoviesGrid');
  if (!section || !grid) return;

  primeRelatedSection();
 
  try {
    const combinedResults = [];
    const seenIds = new Set([id]);

    // Get current movie's data for matching
    const currentGenres = (currentModalMovie && currentModalMovie.genres) ? currentModalMovie.genres.map(g => g.id) : [];
    const currentLang = currentModalMovie ? currentModalMovie.original_language : '';
    const currentDirectors = (currentModalMovie && currentModalMovie.credits && currentModalMovie.credits.crew) 
      ? currentModalMovie.credits.crew.filter(c => c.job === 'Director').map(d => d.id) : [];
    const currentCast = (currentModalMovie && currentModalMovie.credits && currentModalMovie.credits.cast)
      ? currentModalMovie.credits.cast.slice(0, 5).map(c => c.id) : [];

    // PRIORITY 1: Same collection/franchise
    if (type === 'movie' && currentModalMovie && currentModalMovie.belongs_to_collection) {
      const collectionId = currentModalMovie.belongs_to_collection.id;
      const collectionData = await tmdb(`/collection/${collectionId}`, { language: 'en-US' });
      if (collectionData && collectionData.parts) {
        collectionData.parts.sort((a, b) => (a.release_date || '0').localeCompare(b.release_date || '0'));
        collectionData.parts.forEach(movie => {
          if (movie && movie.id && !seenIds.has(movie.id)) {
            movie._isCollection = true;
            combinedResults.push(movie);
            seenIds.add(movie.id);
          }
        });
      }
    }

    // PRIORITY 2: Fetch recommendations, similar, and keyword-based discover
    const fetchPromises = [
      tmdb('/' + type + '/' + id + '/recommendations', { language: 'en-US', page: '1' }),
      tmdb('/' + type + '/' + id + '/similar', { language: 'en-US', page: '1' }),
      tmdb('/' + type + '/' + id + '/recommendations', { language: 'en-US', page: '2' })
    ];

    // PRIORITY 3: Genre-based discover (same genres + same language = highly relevant)
    if (currentGenres.length > 0) {
      const genreStr = currentGenres.slice(0, 3).join(',');
      fetchPromises.push(
        tmdb('/discover/' + type, { 
          language: 'en-US', 
          with_genres: genreStr, 
          sort_by: 'vote_count.desc',
          'vote_average.gte': '6',
          'vote_count.gte': '100',
          with_original_language: currentLang || 'en',
          page: '1'
        })
      );
    }

    // PRIORITY 4: Director's other movies (if available)
    if (currentDirectors.length > 0) {
      fetchPromises.push(
        tmdb('/discover/' + type, {
          language: 'en-US',
          with_crew: currentDirectors[0].toString(),
          sort_by: 'vote_count.desc',
          page: '1'
        })
      );
    }

    const results = await Promise.allSettled(fetchPromises);

    results.forEach((res) => {
      if (res.status === 'fulfilled' && res.value && res.value.results) {
        res.value.results.forEach(movie => {
          if (movie && movie.id && !seenIds.has(movie.id)) {
            combinedResults.push(movie);
            seenIds.add(movie.id);
          }
        });
      }
    });
 
    const realToday = new Date().toISOString().split('T')[0];
    
    // Filter and score each movie
    const scoredMovies = combinedResults.filter(m => {
      if (!m.poster_path) return false;
      const rDate = m.release_date || m.first_air_date;
      if (rDate && rDate > realToday) return false;
      return true;
    }).map(m => {
      let score = 0;

      // Collection/franchise bonus (highest priority)
      if (m._isCollection) score += 100;

      // Genre match scoring (0-40 points)
      const movieGenres = m.genre_ids || [];
      const genreMatches = movieGenres.filter(g => currentGenres.includes(g)).length;
      score += genreMatches * 15; // Each matching genre = 15 points

      // Same language bonus (important for Bollywood/regional)
      if (m.original_language === currentLang) score += 20;

      // Same director bonus
      // (we can't check this without full credits, so skip for discovered items)

      // Cast overlap bonus (from discover results won't have this, but TMDB recs/similar will be relevant)
      
      // Quality score (higher rated = more relevant)
      if (m.vote_average >= 7) score += 10;
      else if (m.vote_average >= 6) score += 5;

      // Popularity bonus (well-known movies are better suggestions)
      if (m.vote_count > 1000) score += 8;
      else if (m.vote_count > 500) score += 4;

      // Penalize very old movies unless collection
      if (!m._isCollection) {
        const year = parseInt((m.release_date || m.first_air_date || '2000').slice(0, 4));
        const currentYear = new Date().getFullYear();
        if (currentYear - year <= 5) score += 5; // Recent bonus
      }

      m._relevanceScore = score;
      return m;
    });

    // Sort by relevance score (highest first)
    scoredMovies.sort((a, b) => b._relevanceScore - a._relevanceScore);

    const finalMovies = scoredMovies.slice(0, 20);
 
    if (finalMovies.length > 0) {
      grid.innerHTML = '';
      const fragment = document.createDocumentFragment();
      finalMovies.forEach((m, i) => {
        const rType = m.media_type || type;
        const rating = m.vote_average ? m.vote_average.toFixed(1) : 'N/A';
        const year = (m.release_date || m.first_air_date || '').slice(0, 4);
        const isHot = m.popularity > 100;
        const genres = (m.genre_ids||[]).slice(0,2).map(gId => GENRE_MAP[gId]).filter(Boolean);
        let qual = 'HD';
        if (m.vote_average >= 7.5) qual = '4K';
        else if (m.vote_average >= 6.5) qual = 'FHD';
 
        const card = document.createElement('div');
        card.className = 'movie-card reveal-up';
        card.tabIndex = 0;
        card.style.animationDelay = ((i % 12) * 0.04) + 's';
        // Same tile as the home grid (cardInfoHTML); FRANCHISE replaces HINDI.
        card.innerHTML =
          '<div class="card-poster">' +
            '<img src="'+IMG+m.poster_path+'"' +
              // The grid is minmax(185px, 1fr) on desktop and 2 columns on
              // phones, so a card is roughly 185-260 CSS px wide. A single w342
              // src made a 1x desktop download ~2.6x the pixels it displays and
              // left a 3x phone slightly soft. Letting the browser choose fixes
              // both directions from one markup change.
              ' srcset="' + mzPosterSrcset(m.poster_path) + '"' +
              ' sizes="(max-width: 600px) 45vw, (max-width: 1200px) 200px, 230px"' +
              ' alt="'+escapeHTML(m.title||m.name||'')+'" width="170" height="255"' +
              ' loading="lazy" decoding="async">' +
            '<div class="card-quality qual-' + qual.toLowerCase() + '">'+qual+'</div>' +
            (isHot ? '<div class="card-hot">HOT</div>' : '') +
            (m._isCollection ? '<div class="card-dubbed rel-fr">FRANCHISE</div>' : '') +
            '<div class="card-overlay"><button class="card-play-btn" aria-label="Play">&#9654;</button></div>' +
          '</div>' +
          cardInfoHTML(m.title || m.name, m.vote_average, year, m.original_language, genres);
        card.addEventListener('click', (event) => { openModal(m.id, rType, event); });
        fragment.appendChild(card);
        // PERF (TV): reveal observer skip — TV CSS me .reveal-up ka opacity force hai.
      if (!isMzTV()) scrollObserver.observe(card);
      });
      grid.appendChild(fragment);

      // Setup navigation arrows
      const prevBtn = document.getElementById('relatedPrev');
      const nextBtn = document.getElementById('relatedNext');
      const scrollAmount = 380;

      /*  Reads batched ahead of writes, and one run per frame. Previously
       *  `prevBtn.disabled = ...` sat between two reads of grid.scrollLeft /
       *  scrollWidth / clientWidth, so the second read flushed the layout the
       *  first write had invalidated — on every scroll event, not every frame. */
      const updateArrowState = () => {
        const scrollLeft = grid.scrollLeft;
        const maxScroll = grid.scrollWidth - grid.clientWidth;
        if (prevBtn) prevBtn.disabled = scrollLeft <= 10;
        if (nextBtn) nextBtn.disabled = scrollLeft >= (maxScroll - 10);
      };

      if (prevBtn) prevBtn.onclick = () => { grid.scrollBy({ left: -scrollAmount, behavior: isMzTVMode() ? 'auto' : 'smooth' }); };
      if (nextBtn) nextBtn.onclick = () => { grid.scrollBy({ left: scrollAmount, behavior: isMzTVMode() ? 'auto' : 'smooth' }); };

      /*  onscroll, not addEventListener: this runs on every modal open against the
       *  same #relatedMoviesGrid, and each open used to stack one more listener
       *  (after N opens, N measurements per scroll frame, each reading straight
       *  after the previous one's writes). Assigning replaces it. The first
       *  measurement also moves to the next frame, so the 20 cards appended above
       *  are laid out once, by the browser, instead of inside this task. */
      const syncArrows = mzRafThrottle(updateArrowState);
      grid.onscroll = syncArrows;
      syncArrows();

    } else {
      section.style.display = 'none';
    }
  } catch(e) { 
    console.warn("Could not load related movies:", e);
    section.style.display = 'none'; 
  }
}
 
/* ══════════════════════════════════════════════════════════════
   ANIME PLAYBACK BRIDGE
   Anime/Cartoon servers AniList ID maangte hain (TMDB ID nahi),
   isliye TMDB title → AniList ID mapping (cached in localStorage).
   ══════════════════════════════════════════════════════════════ */
const anilistIdCache = new Map();
let anilistLookupInFlight = false;

function normalizeTitleForMatch(t) {
  return String(t || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(season|part|cour|the animation|tv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Anime/animation content detect karta hai (anime + Japanese/Chinese/Korean cartoons) */
function isAnimeContent(m) {
  if (!m) return false;
  const ids = (m.genre_ids || (Array.isArray(m.genres) ? m.genres.map(g => g.id) : []) || []);
  const lang = m.original_language;
  const isAnimated = ids.includes(16) || ids.includes(10762);
  return isAnimated && (lang === 'ja' || lang === 'zh' || lang === 'ko');
}

/** Kisi bhi animated content (Doraemon/Ben10/Tom&Jerry bhi) ke liye true */
function isCartoonContent(m) {
  if (!m) return false;
  const ids = (m.genre_ids || (Array.isArray(m.genres) ? m.genres.map(g => g.id) : []) || []);
  return ids.includes(16) || ids.includes(10762);
}

function animeAudioTrack(lang) {
  if (lang === 'hi') return 'hindi';   // VidNest officially Hindi dub support karta hai
  if (lang === 'en') return 'dub';
  return 'sub';
}

function anilistCacheKey(m, season) {
  const type = (m && m.media_type) || 'tv';
  return type + '-' + (m ? m.id : '0') + '-s' + (season || 1);
}

function getAnilistIdSync(m, season) {
  if (!m) return null;
  const key = anilistCacheKey(m, season);
  if (anilistIdCache.has(key)) return anilistIdCache.get(key);
  try {
    const ls = localStorage.getItem('mz_anilist_' + key);
    if (ls !== null) {
      const val = (ls === 'null' || ls === '') ? null : parseInt(ls, 10);
      const safe = isNaN(val) ? null : val;
      anilistIdCache.set(key, safe);
      return safe;
    }
  } catch (e) {}
  return null;
}

function setAnilistId(m, season, id) {
  const key = anilistCacheKey(m, season);
  anilistIdCache.set(key, id);
  try { localStorage.setItem('mz_anilist_' + key, id === null ? 'null' : String(id)); } catch (e) {}
}

/** AniList GraphQL se best matching anime entry dhundhta hai */
async function resolveAnilistId(m, season) {
  if (!m) return null;
  const cached = getAnilistIdSync(m, season);
  if (cached !== null) return cached;

  const s = parseInt(season || 1, 10) || 1;
  const engTitle  = m.name || m.title || '';
  const origTitle = m.original_name || m.original_title || '';
  const year = parseInt(String(m.first_air_date || m.release_date || '').slice(0, 4), 10) || null;
  const wantMovie = (m.media_type === 'movie');

  const searches = [];
  if (engTitle)  searches.push(s > 1 ? engTitle + ' season ' + s : engTitle);
  if (origTitle && origTitle !== engTitle) searches.push(s > 1 ? origTitle + ' season ' + s : origTitle);
  if (s > 1 && engTitle) searches.push(engTitle); // fallback: base entry

  const query = 'query($s:String){Page(perPage:8){media(search:$s,type:ANIME,sort:SEARCH_MATCH){id title{romaji english} format startDate{year} episodes popularity}}}';

  for (const term of searches) {
    let list = [];
    try {
      const r = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables: { s: term } })
      });
      if (!r.ok) continue;
      const j = await r.json();
      list = (j && j.data && j.data.Page && j.data.Page.media) || [];
    } catch (e) { continue; }
    if (!list.length) continue;

    const target = normalizeTitleForMatch(engTitle || origTitle);
    let best = null, bestScore = -Infinity;
    list.forEach(a => {
      let score = 0;
      const rom = normalizeTitleForMatch(a.title && a.title.romaji);
      const eng = normalizeTitleForMatch(a.title && a.title.english);
      if (rom === target || eng === target) score += 6;
      else if ((rom && target && (rom.indexOf(target) === 0 || target.indexOf(rom) === 0)) ||
               (eng && target && (eng.indexOf(target) === 0 || target.indexOf(eng) === 0))) score += 3;
      else if ((rom && target && rom.indexOf(target) !== -1) || (eng && target && eng.indexOf(target) !== -1)) score += 1;

      const ay = a.startDate && a.startDate.year;
      if (year && ay) {
        const diff = Math.abs(ay - year);
        if (diff === 0) score += 4; else if (diff === 1) score += 2; else if (diff <= 3) score += 0.5; else score -= 1;
      }
      if (wantMovie) { if (a.format === 'MOVIE') score += 3; else score -= 2; }
      else { if (a.format === 'MOVIE') score -= 2; else score += 1.5; }
      score += Math.min((a.popularity || 0) / 100000, 0.9);

      if (score > bestScore) { bestScore = score; best = a; }
    });

    if (best && bestScore >= 2) {
      setAnilistId(m, s, best.id);
      return best.id;
    }
  }
  setAnilistId(m, s, null); // negative cache — dubara useless lookups na ho
  return null;
}

/**
 * Anime server select hone par AniList id background me resolve karta hai
 * aur milte hi player ko sahi anime stream par reload kar deta hai.
 */
function ensureAnilistThenReload(m, season, srcIdx, lang, quality, type) {
  if (!m || anilistLookupInFlight) return;
  const s = parseInt(season || 1, 10) || 1;
  const key = anilistCacheKey(m, s);
  if (anilistIdCache.has(key) || getAnilistIdSync(m, s) !== null) return;
  anilistLookupInFlight = true;
  resolveAnilistId(m, s).then(anilistId => {
    anilistLookupInFlight = false;
    if (!anilistId) return;
    // Sirf tab reload karo jab user usi title par aur usi anime server par hai
    if (!currentModalMovie || currentModalMovie.id !== m.id) return;
    if (currentSourceIdx !== srcIdx) return;
    loadPlayer(m.id, srcIdx, lang, quality, type);
  }).catch(() => { anilistLookupInFlight = false; });
}

// -- PLAYER SOURCES (Oct 2026) --
// Every entry was re-measured in real Chrome inside a real iframe (this app's
// own frame attributes: no sandbox, referrerpolicy=no-referrer — origin for
// OmniPlay/VidRift only, see frameReferrerPolicy()).

/*  ── TOON HINDI: the app's side of the server ──────────────────────────────
 *  The server itself is the last entry in playerSources; toon-resolver.js has
 *  the full story. Its frame loads our own /api/toon/embed: the Toon Hindi
 *  player, a source bar (Hindi libraries first, then backups) over the actual
 *  player. The URL is the same string whether or not the title was ever looked
 *  up, so prewarm matching (takePrewarmedFrame compares URLs as strings) keeps
 *  working, and the warm-up copy (autoplay=0) only looks the title up.
 *
 *  NOTHING HERE MOVES THE VIEWER TO ANOTHER SERVER. That was the reported bug:
 *  tap Toon Hindi on a cartoon AnimeSalt lacked, get "Toon Hindi doesn't have
 *  this title. Playing it on Nexus 4K…", and land on that server's Cloudflare
 *  error page. A title the Hindi libraries do not carry now plays a backup
 *  inside Toon Hindi, and the player page says so (mz-toon:playing below).
 *
 *  The one exception is a request the server refuses outright (a malformed
 *  id: mz-toon:unavailable). A hand pick stays on screen with a toast; only a
 *  server the app chose by itself moves on, keepPick, so the next title still
 *  opens on the viewer's saved server. */
const TOON_API = BASE.replace(/\/tmdb$/, '/toon');
const _mzToonMissing = new Set();
/*  True while the live player is Toon Hindi AND the viewer picked it by tapping
 *  its card. Set by loadPlayer on every load. */
let _mzToonUserPick = false;
function toonMissingKeys(m) {
  const type = m.media_type === 'tv' ? 'tv' : 'movie';
  const sel = currentEpisodeSelection();
  return [type + ':' + m.id, type + ':' + m.id + (type === 'tv' ? ':' + sel.s + ':' + sel.e : '')];
}
function toonKnownMissing(m) {
  if (!m) return false;
  const keys = toonMissingKeys(m);
  return _mzToonMissing.has(keys[0]) || _mzToonMissing.has(keys[1]);
}
/** The Toon Hindi frame a message came from: 'live', 'warm' or null. */
function toonFrameOf(event) {
  const live = document.getElementById('playerFrame');
  if (live && event.source === live.contentWindow) return 'live';
  const warm = document.getElementById('mzPrewarmFrame');
  if (warm && event.source === warm.contentWindow) return 'warm';
  return null;
}
let _mzToonBackupToast = '';
window.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || typeof d !== 'object' || (d.type !== 'mz-toon:unavailable' && d.type !== 'mz-toon:playing')) return;
  const from = toonFrameOf(event);
  if (!from) return;
  const m = currentModalMovie;
  const idx = playerSources.findIndex((s) => s.toon);
  if (!m || idx === -1) return;
  const onScreen = from === 'live' && currentSourceIdx === idx;

  if (d.type === 'mz-toon:playing') {
    /*  A backup the viewer did not pick inside the player: say why once per
     *  title/episode, so a different-sounding stream is not a surprise. */
    if (!onScreen || d.library || d.byHand) return;
    const key = toonMissingKeys(m)[1];
    if (_mzToonBackupToast === key) return;
    _mzToonBackupToast = key;
    showToast('Toon Hindi: not in the Hindi library yet, playing a backup stream. Switch sources at the top of the player.');
    return;
  }

  _mzToonMissing.add(toonMissingKeys(m)[0]);
  if (!onScreen) return;
  if (window._mzRetryTimer) { clearTimeout(window._mzRetryTimer); window._mzRetryTimer = null; }
  if (_mzToonUserPick) {
    showToast('Toon Hindi cannot open this title. Pick another server below the player.');
    return;
  }
  autoRetryNextServer(m.id, idx, getSelectedLang(), getSelectedQuality(), m.media_type, { keepPick: true, reason: 'unavailable' });
});
const playerSources = [
  /*  #0 OmniPlay 4K — same chip, same slot, same badges; the engine changed.
   *
   *  OmniPlay ran on Videasy, and Videasy's backend is down for everyone, not just
   *  one network: api.speedracelight.com (its source API) answers Cloudflare 502
   *  to every seed/sources call, and www/backend/users.videasy.to are NXDOMAIN on
   *  public DoH. The player shell still loads — which is why the iframe looked
   *  fine — then searches its providers and paints "We couldn't find that" for
   *  every title. No URL parameter can fix that, so the engine moved to VidRift.
   *
   *  Measured playing (real decoded frames):
   *    Avengers: Endgame 2579x1080 · 3 Idiots 1080p · RRR 1080p
   *    Game of Thrones S1E1 720p, audio tracks: Hindi, Telugu, English, Tamil, Kannada
   *    Jujutsu Kaisen S1E1 1080p (anime plays on the plain TMDB route)
   *
   *  TMDB routes only, anime included: VidRift serves anime as TV, so no AniList
   *  lookup (and no reload when it resolves) is needed. `autoplay=1` is ignored by
   *  the player (its default is muted autoplay) and exists so warmUrlVariant can
   *  flip it to `autoplay=0` for a hidden warm-up frame.
   *
   *  `signal`: a working VidRift player posts vidrift:* messages within ~1s of
   *  booting; a title it cannot serve (e.g. HTTP 451 "This title is not
   *  available.") posts nothing. armSignalWatch() uses that to fail over on its own
   *  instead of leaving the viewer on an error card. */
  { name: 'OmniPlay 4K', dubbed: true, is4K: true, anime: true,
    signal: { origin: 'https://embed.vidrift.net', prefix: 'vidrift:' },
    // Continue Watching resume, sent once the frame has loaded (see loadPlayer).
    resume: (at) => ({ type: 'vidrift:resume', currentTime: at }),
    url: (id, lang, type, s, e) => {
      const opts = 'autoplay=1&brandColor=ffc107';
      return type === 'tv'
        ? `https://embed.vidrift.net/embed/tv/${id}/${s}/${e}?${opts}`
        : `https://embed.vidrift.net/embed/movie/${id}?${opts}`;
    }},

 /*  #8: Flicky — multi-server, multi-audio, 4K. Same player as always; only the
   *  address it lives at changed.
   *
   *  flicky.host now answers every request with a 301 to player.vidzee.wtf, and
   *  in the same move the embed API stopped accepting the id as a query string:
   *
   *    /embed/movie/?id=550        -> 404   (what we were sending)
   *    /embed/movie/550            -> 200   (the route is /embed/movie/$tmdb)
   *    /embed/tv/?id=1399&s=1&e=1  -> 404
   *    /embed/tv/1399/1/1          -> 200
   *
   *  That 404 is the white "Page not found" screen, and it was never a change on
   *  our side — the URL builder below is byte-for-byte what it was when this
   *  server last worked, which is why nothing in the recent commits explains it.
   *
   *  We target player.vidzee.wtf directly rather than riding the redirect. It is
   *  the origin the iframe ends up on either way, so this drops a full redirect
   *  round-trip before the first frame AND lets playerHostOrigins() preconnect
   *  the host that actually serves the video instead of the one that only
   *  bounces us. The chip keeps the name 'Flicky Stream' on purpose: the health
   *  ranking stores per-server history under that name, so renaming it would
   *  throw away everything this user's browser has learned about it. */
  { name: 'Flicky Stream', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    return type === 'tv'
      ? `https://player.vidzee.wtf/embed/tv/${id}/${s}/${e}`
      : `https://player.vidzee.wtf/embed/movie/${id}`;
  }},

  { name: '4K Ultra HD', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    // #1: Viduki.net API 2 — 4K AI Upscaling + Multi-Language + 5.1 Surround
    return type === 'tv'
      ? `https://www.viduki.net/2/tv/${id}/${s}/${e}`
      : `https://www.viduki.net/2/movie/${id}`;
  }},

  // S15 — moviesnexus.fun, Olly's "Nexus" on its vidara source: 1920x1080 on every
  // title measured, and the fastest of the three to a first frame (~8-20s).
  { name: 'Nexus 4K', dubbed: true, is4K: true, anime: true, url: (id, lang, type, s, e) => {
    return type === 'tv'
      ? `https://www.moviesnexus.fun/tv/${id}/${s}/${e}?sv=vidara`
      : `https://www.moviesnexus.fun/movie/${id}?sv=vidara`;
  }},

  /*  Hindi Dub HD — replaces VidSrc HD (vidsrc.su), removed by request: it was the
   *  weakest chip in the list for this audience (no Hindi, and it refused to run
   *  inside Android in-app browsers).
   *
   *  Built for one job — Hindi audio on every kind of title — and routed by type,
   *  like MultiLang HD, because no single provider was best at all three:
   *
   *    films & series  ollyembed.pages.dev ?server=Hindi — its dedicated Dual Audio
   *                    / Hindi server. Measured: Endgame (variants to 1012p),
   *                    Inception (to 800p), 3 Idiots, Game of Thrones S1E1 720p.
   *    anime           vidnest.fun /anime/{anilist}/{ep}/hindi — VidNest's own Hindi
   *                    dub route. Measured: One Piece ep1 (to 1080p), Jujutsu Kaisen
   *                    ep1 720p, Attack on Titan ep1 720p.
   *
   *  Until an anime's AniList id is known the episode plays on VidNest's TMDB route,
   *  and `anilist: true` lets ensureAnilistThenReload() upgrade it to the Hindi
   *  route once the id resolves (openModal pre-resolves it, so usually it already is).
   *  No 4K badge: nothing here was measured above 1080p. */
  { name: 'Hindi Dub HD', dubbed: true, anime: true, anilist: true,
    url: (id, lang, type, s, e) => {
      const m = currentModalMovie;
      if (isAnimeContent(m)) {
        const anilistId = getAnilistIdSync(m, s);
        if (anilistId) {
          return `https://vidnest.fun/anime/${anilistId}/${parseInt(e, 10) || 1}/hindi`;
        }
        return type === 'tv'
          ? `https://vidnest.fun/tv/${id}/${s}/${e}`
          : `https://vidnest.fun/movie/${id}`;
      }
      return type === 'tv'
        ? `https://ollyembed.pages.dev/tv/${id}/${s}/${e}?server=Hindi`
        : `https://ollyembed.pages.dev/movie/${id}?server=Hindi`;
    }},

  // S2 — nxsha.space, Olly's "Hindi v2": a Nitro multi-audio source with a Hindi
  // track, plus its own Audio / Subtitles / Quality menus. `lang=hi` is the
  // parameter Olly ships it with.
  { name: 'Nitro Hindi', dubbed: true, is4K: true, anime: true, url: (id, lang, type, s, e) => {
    return type === 'tv'
      ? `https://nxsha.space/embed/tv/${id}/${s}/${e}?lang=hi`
      : `https://nxsha.space/embed/movie/${id}?lang=hi`;
  }},
  // S12 — nxsha.screenscape.me, Olly's "Phantom": one embed resolving across ~18
  // upstreams (Sealx, Nitro, HINDI, Tamil, 4KELITE ...). Olly keys it on IMDb; the
  // provider documents `tmdb=` as well, which is the id this app always has.
  { name: 'Phantom Multi', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    return type === 'tv'
      ? `https://nxsha.screenscape.me/embed?tmdb=${id}&type=tv&s=${s}&e=${e}`
      : `https://nxsha.screenscape.me/embed?tmdb=${id}&type=movie`;
  }},

  // 🌸 ANIME SPECIALIST: AnimePahe mirror — purane/long-running anime & cartoons ke liye best
  //    `anilist: true` = its anime URL is keyed on an AniList id, so loadPlayer may
  //    reload it once that id resolves (ensureAnilistThenReload). TMDB-only servers
  //    do not set it, so they are never reloaded for nothing.
  { name: 'AnimePahe HD', dubbed: true, is4K: true, anime: true, anilist: true, url: (id, lang, type, s, e) => {
    const m = currentModalMovie;
    const track = animeAudioTrack(lang) === 'hindi' ? 'dub' : animeAudioTrack(lang); // animepahe: sub/dub
    if (isAnimeContent(m)) {
      const anilistId = getAnilistIdSync(m, s);
      if (anilistId) {
        const ep = String(parseInt(e, 10) || 1);
        return `https://vidnest.fun/animepahe/${anilistId}/${ep}/${track}`;
      }
    }
    // Cartoon/movie fallback: VidNest ke alfa/gama server force karke high-quality stream
    return type === 'tv'
      ? `https://vidnest.fun/tv/${id}/${s}/${e}?server=alfa`
      : `https://vidnest.fun/movie/${id}?server=gama`;
  }},

  // { name: 'Hindi Multi-Audio', dubbed: true, url: (id, lang, type, s, e) => {
  //   const base = `https://embed.smashystream.com/playere.php?tmdb=${id}`;
  //   return type === 'tv' ? `${base}&season=${s}&episode=${e}` : base;
  // }},
  /*  Turbo Stream — the provider behind this chip rebranded, and the old address is
   *  now a two-hop detour rather than a home:
   *
   *    111movies.com/movie/550  -> 301 -> 111movies.net/movie/550
   *                             -> 302 -> player.vidlove.cc/embed/movie/550
   *
   *  Nothing on the served page mentions 111movies any more; it identifies itself
   *  as vidlove throughout. So both hops were pure latency, and worse, the host
   *  playerHostOrigins() was warming (111movies.com) is one that never serves a
   *  frame. Straight to the end of the chain: ~0.07s to first byte against ~0.39s
   *  through the redirects. Note the new route carries an /embed/ segment, which
   *  the old one did not. The chip name is unchanged so the learned ranking keeps
   *  the history it has for this provider. */
  { name: 'Turbo Stream', dubbed: true, url: (id, lang, type, s, e) => {
    return type === 'tv'
      ? `https://player.vidlove.cc/embed/tv/${id}/${s}/${e}`
      : `https://player.vidlove.cc/embed/movie/${id}`;
  }},
  
    { name: 'VidFast 4K', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    const opts = `autoPlay=true&theme=FFC107&title=true&poster=true&autoNext=true&nextButton=true&lang=${lang}`;
    return type === 'tv'
      ? `https://vidfast.vc/tv/${id}/${s}/${e}?${opts}`
      : `https://vidfast.vc/movie/${id}?${opts}`;
  }},
  /*  #8b: MultiAudio — replaces VidZen, which was pulled for the two reasons it
   *  was reported for: most titles never resolved a source at all, and the ones
   *  that did carried an English track only.
   *
   *  This provider is the opposite trade. Every title is resolved server-side
   *  against a pool of independent upstreams and the whole list arrives inside the
   *  embed document, so there is no blank rectangle while sources resolve and a
   *  dead upstream is skipped in-player instead of ending the session. Measured on
   *  an Indian connection before shipping (TMDB ids unless noted):
   *
   *    3 Idiots (20453)              7 sources
   *    Game of Thrones S1E1 (1399)   8 sources
   *    Superman (1061474)            9 sources  <- incl. "Server SWM2-Hindi" (IN)
   *    Animal (tt13751694)           3 sources  <- Kannada + Malayalam labelled
   *    One Piece S1E1 (37854)        6 sources
   *    Doraemon S1E1 (30983)         5 sources
   *    RRR (579974) / Oppenheimer    4 / 5 sources
   *
   *  The language story is the point. Sources come back tagged with their audio
   *  language and country flag, so a Hindi dub shows up as its own entry in the
   *  player's server menu rather than being buried; on top of that the player
   *  reads the audio tracks out of the HLS manifest and exposes them as a separate
   *  Audio menu with the viewer's choice remembered. That is real multi-audio,
   *  which is what the `lang=` query string on some of the other servers here only
   *  claims. Quality is adaptive HLS with a manual pin, 2160p included.
   *
   *  Two provider rules this integration has to respect, both already satisfied:
   *    - It answers inside an iframe only; a direct hit 404s. The warm-up path
   *      fetches with `mode: 'no-cors'`, where a 404 resolves as an opaque
   *      response, so it never mistakes that 404 for a dead host and demotes it.
   *      The two frames that do get built (prewarm + loadPlayer) are real iframes.
   *    - A `sandbox` attribute on the frame — or on any ancestor frame — makes it
   *      refuse to play. Neither frame sets one, and nothing must start.
   *
   *  `autoplay=true` is the only query parameter it takes (verified: `st`, `srv`
   *  and `ad` are all ignored from the query string), and warmUrlVariant flips it
   *  to false on warm-ups, so a prewarm can never start audio in a hidden frame.
   *  Movie and episode share the vidsrc.buzz origin, so a series never pays a cold
   *  handshake the movie probe already warmed. */
  // { name: 'MultiAudio 4K', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
  //   return type === 'tv'
  //     ? `https://vidsrc.buzz/embed/tv/${id}/${s}/${e}?autoplay=true`
  //     : `https://vidsrc.buzz/embed/movie/${id}?autoplay=true`;
  // }},
  // { name: 'Ultra HD', dubbed: true, url: (id, lang, type, s, e) => {
  //   // #6: AutoEmbed — India ke networks par blockage kam aati hai
  //   return (type === 'tv' ? `https://autoembed.co/tv/tmdb/${id}-${s}-${e}` : 'https://autoembed.co/movie/tmdb/' + id) + `?lang=${lang}`;
  // }},
  { name: 'Pro Stream', dubbed: true, url: (id, lang, type, s, e) => {
    // #4: VidLink Pro — Clean interface with settings
  
    const at = (typeof mzResumeSec === 'function') ? mzResumeSec(id, type, s, e) : 0;
    return (type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : 'https://vidlink.pro/movie/' + id)
      + `?lang=${lang}` + (at ? '&startAt=' + at : '');
  }},

  /*  ══════════════════════════════════════════════════════════════════════
   *  #9: MultiLang HD — replaces VidCore HD, which is blocked, not slow
   *  ══════════════════════════════════════════════════════════════════════
   *  vidcore.io no longer reaches a player at all. Driven in real Chrome inside a
   *  real unsandboxed iframe with our own Referer, the embed document answers
   *
   *      403  "Attention Required! | Cloudflare"
   *      "Sorry, you have been blocked — You are unable to access vidcore.io"
   *
   *  and the frame's only other network activity is that challenge page. Note that
   *  a plain server-side fetch of the same URL still returns 200 with a 50 KB
   *  player document, which is exactly why this was not caught earlier: the status
   *  code lies. Only a browser gets the block, because only a browser presents the
   *  fingerprint Cloudflare is filtering on. Every reachability check in this app
   *  was passing while no viewer could ever see video.
   *
   *  ── WHY TWO PROVIDERS BEHIND ONE CHIP ──
   *  The replacement was chosen on measured playback, not on a landing page: each
   *  candidate was loaded in a real iframe and its network traffic read over the
   *  DevTools Protocol, so the pass mark is "an HLS manifest resolved AND media
   *  segments were actually fetched". Sixteen other providers were tried and
   *  produced no stream at all from this network (vidsrcapi, vidsrc.cc/to/net/vip,
   *  cinemaos, vidbinge, streamflizo, smashy, letsembed, nunflix, vidapi.xyz,
   *  moviee, multiembed, yapgrid, vidjoy — the last of which is now a parked
   *  domain). Two survived, and they are good at opposite things:
   *
   *                     movies      TV        first segment
   *      peachify.top   5 of 5      0 of 2    2.2-5.0s  (avg 3.7s)
   *      moviesapi.vip  3 of 5      3 of 4    3.3-9.5s  (avg 5.9s)
   *
   *  peachify is both faster and perfect on films, and it is the one that actually
   *  carries the feature this slot was asked for: its player reads the audio tracks
   *  out of the HLS manifest and exposes them as a switchable Audio menu, with a
   *  documented `default_dub` preference — real multi-audio, verified playing on
   *  3 Idiots, Dangal and Animal as well as on Endgame and Interstellar. Its TV
   *  route is simply not there: /embed/tv/{id}/{s}/{e} answers 200 and then resolves
   *  nothing, on Breaking Bad, Stranger Things and House of the Dragon, and the two
   *  alternative route shapes its docs hint at behave the same. So episodes go to
   *  moviesapi.vip, which resolved 15-32 segments on three of four series.
   *
   *  Routing by type inside one url() is how several entries here already work —
   *  OmniPlay splits anime/tv/movie, AnimePahe splits anime/everything-else — so
   *  this keeps the server list the same length and the chip count unchanged.
   *
   *  Both are ad-library-free in the traffic capture: peachify pulls only its own
   *  origin plus fonts and Cloudflare insights, and moviesapi pulls TMDB and
   *  OpenSubtitles for metadata and subtitles. That is one fewer ad-heavy provider
   *  than the entry it replaces.
   *
   *  The chip is renamed from 'VidCore HD' on purpose: the health ranking keys its
   *  per-server history off the name, and 'VidCore HD' has been recording load
   *  successes for a Cloudflare block page. A new key lets this compete on its real
   *  3.7s from the first visit instead of inheriting that false-positive history.
   *
   *  ── Oct 2026: films moved off peachify.top ──
   *  peachify.top's origin is gone: Cloudflare answers 523 "origin unreachable" on
   *  every path, which is exactly the reported "web series play, movies don't" —
   *  episodes were already on moviesapi.vip. Its /movie route was re-measured and
   *  now plays: Endgame 1920x800, 3 Idiots 1920x816, RRR 1920x1012, with Hindi
   *  sources in its server menu. Both types now share one provider and one host.
   */
  { name: 'MultiLang HD', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    return type === 'tv'
      ? `https://moviesapi.vip/tv/${id}/${s}/${e}`
      : `https://moviesapi.vip/movie/${id}`;
  }},

  // 🔁 Cinextream (cinextream.net) ka domain dead ho gaya (DNS record hi nahi bacha),
  //    uski jagah VidFast — 4K/multi-audio, tez CDN, movies + series dono
  //    Host is vidfast.vc: vidfast.pro now only 301s here, and the page identifies
  //    itself as .vc, so we skip the bounce and preconnect the real origin.

  // { name: 'Premium Mirror', dubbed: true, url: (id, lang, type, s, e) => {
  //   // #9: Official proxy mirror to fix 'refused to connect' / iframe block issue
  //   return (type === 'tv' ? `https://vidsrc.pm/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc.pm/embed/movie?tmdb=${id}`) + `&lang=${lang}`;
  // }}

  /*  🌸 TOON HINDI — anime and cartoons, Hindi first.
   *
   *  Our own player (/api/toon/embed, see toon-resolver.js) with a source bar:
   *    Hindi libraries  AnimeSalt (multi-audio JW player: Hindi, Tamil, Telugu,
   *                     Malayalam, English, Japanese, Hindi selected) and
   *                     ToonStream (Disney / Pixar / DreamWorks / Nick / CN films
   *                     and series in Hindi), looked up in parallel from the
   *                     TMDB id — so it needs no AniList id;
   *    backups          VidRift / vidnest / vidzee / moviesapi, measured on the
   *                     cartoons the libraries lack, so every title plays HERE.
   *  The viewer switches between them inside the player; this server never
   *  sends anyone to another one (the mz-toon listener above).
   *
   *  Last in the array on purpose: every server before it keeps its index, so
   *  saved picks (moviezone.playerSourceIdx) and learned health stay attached
   *  to the servers they were measured on.
   *
   *  `toon`: picked by the app itself only for animated titles (isCartoonContent —
   *  anime included) — though it is OFFERED on every title, like the other
   *  servers. skip() keeps it out of the opening pick, the retry chain and Try
   *  All for non-animated titles and for a title the server refused. Picked by
   *  hand, a slow load is never switched away from (loadPlayer's _mzStayPut).
   *  `patience`: the first load of our own page is fast, but a cold Worker plus
   *  a slow network should not trip the app's 5-6s load timeout.
   *  `autoplay=1`: warmUrlVariant turns it into autoplay=0 for the hidden
   *  warm-up frame, where the page only looks the title up and plays nothing.
   *  `hosts`: where the inner frames end up, so they are warmed like every
   *  other provider.
   *
   *  The builder reads nothing but its arguments and standard globals, guarded,
   *  because player-health.test.js evaluates this array in a bare sandbox. */
  { name: 'Anime/Toon Hindi', dubbed: true, anime: true, toon: true, patience: 15000,
    hosts: ['https://ravok.buzz', 'https://player.abyssplayer.com', 'https://abyssplayer.com', 'https://vidnest.fun', 'https://embed.vidrift.net'],
    skip: () => !isCartoonContent(currentModalMovie) || toonKnownMissing(currentModalMovie),
    url: (id, lang, type, s, e) => {
      const tv = type === 'tv';
      const api = (typeof TOON_API === 'string') ? TOON_API : '/api/toon';
      const page = (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) ? location.href : 'https://moviezone.dev/';
      return new URL(api + '/embed?type=' + (tv ? 'tv' : 'movie') + '&id=' + encodeURIComponent(id)
        + (tv ? '&s=' + (parseInt(s, 10) || 1) + '&e=' + (parseInt(e, 10) || 1) : '') + '&autoplay=1', page).href;
    }}
];


let currentSourceIdx = 0;
let isPlayerFullscreen = false;
 
// -- LANGUAGE CONFIG (for quick-buttons) --
const LANG_CONFIG = {
  hi: { flag: 'HI', name: 'Hindi',      code: 'hi' },
  en: { flag: 'EN', name: 'English',    code: 'en' },
  ta: { flag: 'TA', name: 'Tamil',      code: 'ta' },
  te: { flag: 'TE', name: 'Telugu',     code: 'te' },
  ml: { flag: 'ML', name: 'Malayalam',  code: 'ml' },
  kn: { flag: 'KN', name: 'Kannada',    code: 'kn' },
  mr: { flag: 'MR', name: 'Marathi',    code: 'mr' },
  bn: { flag: 'BN', name: 'Bengali',    code: 'bn' },
};

function renderLanguageButtons(spokenLangs) {
  const ext = document.getElementById('externalSources');
  if (!ext) return;
  const old = document.getElementById('mz-lang-section');
  if (old) old.remove();
  // Language quick-buttons section removed from the UI as requested. The player
  // still resolves the audio language from getSelectedLang() (stored preference
  // or default), so playback is unaffected.
  return;
}

/*  Former body kept as a comment only, so it ships zero bytes after minification.
    Restoring it also needs the three lists only it used, moved in here for that
    reason (they were the last bytes this dead feature still shipped):
  const DUBBED_LANGS = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'];
  const CORE_LANGS   = ['hi', 'en', 'ta', 'te'];
  const EXTRA_LANGS  = ['ml', 'kn', 'mr', 'bn'];

  const ext = document.getElementById('externalSources');
  if (!ext) return;
  const old = document.getElementById('mz-lang-section');
  if (old) old.remove();
  const extra = EXTRA_LANGS.filter(c => tmdbCodes.includes(c));
  const toShow = [...CORE_LANGS, ...extra];
  const curLang = getSelectedLang();

  const btnsHtml = toShow.map(code => {
    const cfg = LANG_CONFIG[code];
    if (!cfg) return '';
    const isActive = code === curLang;
    const isAvail  = tmdbCodes.includes(code);
    return `<button class="player-chip mz-lang-btn${isActive?' active':''}${isAvail?' mz-lang-avail':''}" data-lang="${code}" title="${isAvail?'Dubbed available on TMDB':'Subtitles if dub unavailable'}"><span>${cfg.flag}</span> ${cfg.name}${isAvail?'<span class="mz-avail-dot"></span>':''}</button>`;
  }).join('');

  const section = document.createElement('div');
  section.id = 'mz-lang-section';
  section.style.cssText = 'margin-top:14px; border-top:1px solid rgba(255,255,255,0.08); padding-top:12px;';
  section.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:7px;">${btnsHtml}</div>

  `;
  ext.appendChild(section);

  section.querySelectorAll('.mz-lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.getAttribute('data-lang');
      if (!lang || !currentModalMovie) return;
      setSelectedLang(lang);
      const langDrop = document.getElementById('langSelect');
      if (langDrop) langDrop.value = lang;
      section.querySelectorAll('.mz-lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Auto-switch to Multi-Audio (index 0) for dubbed languages
      let targetSrcIdx = currentSourceIdx;
      if (DUBBED_LANGS.includes(lang)) {
        targetSrcIdx = 0;
        currentSourceIdx = 0;
        document.querySelectorAll('.player-chip--source').forEach((b, i) => b.classList.toggle('active', i === 0));
      }
      loadPlayer(currentModalMovie.id, targetSrcIdx, lang, getSelectedQuality(), currentModalMovie.media_type);
      const cfg = LANG_CONFIG[lang] || {};
      showToast(` ${cfg.flag||''} ${cfg.name||lang} Audio${DUBBED_LANGS.includes(lang)?' |  Multi-Audio activated':''}`);
    });
  });
}

*/

function renderExternalSources(id, srcIdx, lang) {
  const ext = document.getElementById('externalSources');
  if (!ext) return;

  /*  ── ONE SECTION, NOT TWO (Sep 2026) ──
   *
   *  The servers used to be split into "Premium 4K • Hindi Dub" (is4K || anime) and
   *  "HD Streams • Multi-Audio" (everything else), and the second box is gone by
   *  request: all eleven servers now live in the premium box.
   *
   *  The two arrays are KEPT even though there is one section, and that is for
   *  ordering rather than grouping — concatenating them preserves exactly the
   *  on-screen order the split produced, so the 4K and anime servers still come
   *  first and the four that moved up (VidSrc HD, Turbo Stream, Pro Stream, Premium
   *  Mirror) follow them instead of interleaving. Merging by raw declared index
   *  would have shuffled MultiAudio 4K down behind Turbo Stream for no reason.
   *
   *  NO BADGES WERE CHANGED. It would have been one line to set is4K on the four
   *  that moved and make the heading literally true, and it would have been a lie
   *  on the card: none of them was measured at 2160p. They keep DUB only, so the
   *  per-card badges stay an honest description of each server while the heading
   *  stays the one asked for. buildServerCard's tooltip is likewise untouched and
   *  still says "Hindi Dubbed + Multi-Audio" for them rather than claiming 4K.
   */
  /*  Chips are rendered in the exact declared order of `playerSources` (no
   *  is4K/anime partition), so the on-screen sequence matches the array 1:1.
   *  `_idx` is still the true declared index, so playback/active-chip logic is
   *  unaffected — only the visual order follows the array now. */
  const allServers = playerSources.map((s, i) => ({ ...s, _idx: i }));

  function buildServerCard(s) {
    const tip = s.toon
      ? 'Anime + Cartoons • Hindi first, multi-audio • backups built in'
      : s.anime
      ? 'All-Rounder: Anime + Cartoons + Movies + Series (Hindi Dub supported)'
      : (s.is4K ? '4K AI Upscaling + Multi-Language + Spatial Audio' : (s.dubbed ? 'Hindi Dubbed + Multi-Audio' : 'Mostly English Audio'));
    const badges = [];
    if (s.is4K) badges.push('<span class="srv-badge srv-badge--4k"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>4K</span>');
    if (s.anime) badges.push('<span class="srv-badge srv-badge--anime"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>ANIME</span>');
    if (s.dubbed) badges.push('<span class="srv-badge srv-badge--dub"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>DUB</span>');
    return '<button class="srv-card player-chip--source'
      + (s.is4K ? ' srv-card--4k' : '')
      + (s.anime ? ' srv-card--anime' : '')
      + (s.dubbed ? ' srv-card--dubbed' : '')
      + '" data-srcidx="' + s._idx + '" title="' + escapeHTML(tip) + '">'
      + '<div class="srv-card__inner">'
      + '<span class="srv-card__name">' + escapeHTML(s.name) + '</span>'
      + '<span class="srv-card__status"></span>'
      + '</div>'
      + (badges.length ? '<div class="srv-card__badges">' + badges.join('') + '</div>' : '')
      + '<div class="srv-card__glow"></div>'
      + '</button>';
  }

  function buildSection(title, icon, servers, className) {
    if (!servers.length) return '';
    const cards = servers.map(buildServerCard).join('');
    return '<div class="srv-section ' + className + '">'
      + '<div class="srv-section__header">'
      + '<span class="srv-section__icon">' + icon + '</span>'
      + '<span class="srv-section__title">' + title + '</span>'
      + '<span class="srv-section__count">' + servers.length + ' servers</span>'
      + '</div>'
      + '<div class="srv-section__grid">' + cards + '</div>'
      + '</div>';
  }

  const headerHtml = '<div class="srv-master-header">'
    + '<div class="srv-master-header__left">'
    + '<svg class="srv-master-header__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
    + '<span class="srv-master-header__title">Playback Servers</span>'
    + '</div>'
    + '<span class="srv-master-header__live"><span class="srv-live-dot"></span>LIVE</span>'
    + '</div>'
    + '<p class="srv-master-header__hint">If a server isn\'t playing, simply <strong>switch to another one</strong></p>';

  const sectionsHtml = buildSection(
    'Premium 4K • Hindi Dub',
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    allServers, 'srv-section--premium'
  );

  ext.innerHTML = headerHtml + '<div class="srv-container">' + sectionsHtml + '</div>';

  const srcButtons = ext.querySelectorAll('.player-chip--source');
  srcButtons.forEach(btn => {
    /*  ⚡ Warm the server the user is about to pick.
     *
     *  This used to listen on mouseenter and focus only, which means it did
     *  nothing at all on a phone or tablet — there is no hover there, so every
     *  server switch on touch paid the full DNS + TCP + TLS + provider-document
     *  cost after the tap. That is most of the wait users feel when they try a
     *  different server.
     *
     *  pointerdown/touchstart fire while the finger is still down, ~100-300ms
     *  before click, and they run the LIGHT path: preconnect plus the provider
     *  document into the HTTP cache. No iframe, so nothing can start media in the
     *  background and a mistaken tap costs one cached document.
     *
     *  The heavy path (hidden prewarm frame) stays on hover/focus, where there is
     *  a real signal of intent and a desktop or TV to afford it. prewarmPlayer()
     *  also refuses once #playerFrame exists — which is exactly the switch-while-
     *  watching case — so the light path is what carries that scenario, and it
     *  now runs there too.
     */
    const warmThis = (event) => {
      const idx = parseInt(btn.getAttribute('data-srcidx') || '0', 10);
      const type = currentModalMovie ? (currentModalMovie.media_type || 'movie') : 'movie';
      try { warmEmbedUrl(buildPlayerUrl(id, type, idx), playerSources[idx] && playerSources[idx].name); } catch (e) {}
      const kind = event && event.type;
      if (kind === 'mouseenter' || kind === 'focus') prewarmPlayer(id, type, idx);
    };
    ['mouseenter', 'focus', 'pointerdown', 'touchstart']
      .forEach(evt => btn.addEventListener(evt, warmThis, { passive: true }));
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-srcidx')||'0', 10);
      const type = currentModalMovie ? currentModalMovie.media_type : 'movie';
      const quality = getSelectedQuality();
      // userPick: the viewer chose this server by hand (read by Toon Hindi only).
      loadPlayer(id, idx, getSelectedLang(), quality, type, { userPick: true });
      srcButtons.forEach(b => { b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
  if (typeof srcIdx === 'number') {
    srcButtons.forEach(b => { b.classList.remove('active'); });
    const activeBtn = ext.querySelector('.player-chip--source[data-srcidx="'+srcIdx+'"]');
    if (activeBtn) activeBtn.classList.add('active');
  }

  // Render language quick-buttons below server buttons
  const spokenLangs = (currentModalMovie && currentModalMovie.spoken_languages) || [];
  renderLanguageButtons(spokenLangs);
}
 
function getSelectedLang() {
  const select = document.getElementById('langSelect');
  return select ? select.value : (localStorage.getItem('moviezone.playerLang') || 'hi');
}
 
function setSelectedLang(lang) {
  const select = document.getElementById('langSelect');
  if (select) select.value = lang;
  localStorage.setItem('moviezone.playerLang', lang);
}
 
function getSelectedQuality() {
  const select = document.getElementById('qualitySelect');
  return select ? select.value : (localStorage.getItem('moviezone.playerQuality') || 'fhd');
}
 
function setSelectedQuality(quality) {
  const select = document.getElementById('qualitySelect');
  if (select) select.value = quality;
  localStorage.setItem('moviezone.playerQuality', quality);
}
 
/*  ══════════════════════════════════════════════════════════════════════
 *  LEARNED SERVER HEALTH — why playback used to feel slow
 *  ══════════════════════════════════════════════════════════════════════
 *  The player had no memory. Every play started at a fixed server index and
 *  waited a flat 5000 ms before deciding that server was dead, then walked to
 *  the NEXT INDEX and waited another 5000 ms. If the first two providers were
 *  blocked on this user's network — which is normal, these hosts get blocked
 *  regionally all the time — the user sat through 10-15 seconds of spinner
 *  before anything played. And because nothing was recorded, the exact same
 *  penalty was paid again on the next movie, forever.
 *
 *  Now every load outcome is measured and persisted, so the player converges
 *  on whatever actually works fast for THIS user:
 *
 *    • ordering — servers are tried best-first by measured latency and failure
 *      rate instead of by their position in the array
 *    • give-up time — a server that normally answers in 1.2 s is no longer
 *      given 5 s to prove it is broken; the timeout follows its own history
 *    • recovery — a success partially forgives past failures, so a provider
 *      that was down for a day is not blacklisted forever
 *
 *  Latency is stored as an EWMA so one slow night does not condemn a good
 *  server and a recovering one climbs back quickly.
 */
const MZ_PLAYER_HEALTH_KEY = 'mz_player_health_v1';
const MZ_PH_DEFAULT_TIMEOUT = 5000;  // unknown server: same patience as before
const MZ_PH_MIN_TIMEOUT = 2200;      // never abandon faster than this
const MZ_PH_MAX_TIMEOUT = 6000;
const MZ_DUBBED_LANGS = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'];

let _mzPlayerHealth = null;

function playerHealth() {
  if (_mzPlayerHealth) return _mzPlayerHealth;
  try {
    _mzPlayerHealth = JSON.parse(localStorage.getItem(MZ_PLAYER_HEALTH_KEY)) || {};
  } catch (e) { _mzPlayerHealth = {}; }
  return _mzPlayerHealth;
}

function _mzPersistPlayerHealth() {
  // Tiny payload, but still keep it off the critical path — this fires right
  // when the player is starting up.
  _mzOnIdle(() => {
    try { localStorage.setItem(MZ_PLAYER_HEALTH_KEY, JSON.stringify(playerHealth())); }
    catch (e) {}
  });
}

function _mzHealthEntry(name) {
  const h = playerHealth();
  if (!h[name]) h[name] = { ok: 0, fail: 0, ms: 0 };
  return h[name];
}

/** A provider answered. Record how long it took. */
function recordPlayerLoad(name, ms) {
  if (!name || !(ms >= 0)) return;
  const e = _mzHealthEntry(name);
  e.ok++;
  e.ms = e.ms ? Math.round(e.ms * 0.7 + ms * 0.3) : ms;
  // Partial forgiveness: a provider that is back up should climb the order
  // again instead of carrying its outage for the rest of the user's life.
  e.fail = Math.max(0, +(e.fail - 0.5).toFixed(1));
  _mzPersistPlayerHealth();
}

/** A provider timed out or refused. */
function recordPlayerFailure(name) {
  if (!name) return;
  const e = _mzHealthEntry(name);
  e.fail++;
  _mzPersistPlayerHealth();
}

/*  ══════════════════════════════════════════════════════════════════════════
 *  A FRAME THAT LOADED IS NOT A SERVER THAT PLAYED
 *  ══════════════════════════════════════════════════════════════════════════
 *  recordPlayerLoad() is called from iframe.onload, and `load` fires for ANY
 *  document the provider returns — including its error pages. Measured on the two
 *  servers reported as broken, driven in real Chrome inside a real iframe:
 *
 *    player.videasy.to   502 Bad Gateway   (every host, every path, ~14.5s)
 *    vidcore.io          403 Cloudflare "Sorry, you have been blocked"
 *
 *  Both of those documents fire `load`. So `hasLoaded` goes true, the retry timer
 *  is CANCELLED, recordPlayerLoad() books a success, and the health ranking keeps
 *  the server near the top — while every viewer sees an error page and the
 *  auto-retry chain that exists to rescue them never runs. That is exactly the
 *  reported "blocked dikha raha hai, movie play nahi ho raha", and this file
 *  already documents the same failure class once before, for VidRock: "the iframe
 *  LOADS, so recordPlayerLoad() counts it as a success and the health ranking keeps
 *  this server near the top while it shows an error to everyone."
 *
 *  A cross-origin frame cannot be inspected, so there is no way to READ the error.
 *  What can be observed is the consequence: a server that genuinely played produces
 *  watch activity — the watch session accrues seconds, or the player posts a
 *  progress event. A server that returned an error page produces neither, ever.
 *
 *  So `ok` is split into two counters. `ok` still means "answered", and keeps
 *  driving the latency estimate and the adaptive timeout. `played` means "a human
 *  actually watched something through this server", and playerCost() weighs a
 *  server that has answered repeatedly without ever playing as heavily as an
 *  outright failure. Nothing is ever hard-blocked: one successful play clears the
 *  suspicion, so a provider that comes back up climbs the order again.
 *
 *  Deliberately NOT a server definition change: no URL, parameter or host is
 *  touched by any of this. It is the retry and ranking logic learning to tell a
 *  working server from one that merely answers.
 */
const MZ_NOPLAY_SUSPECT_AFTER = 2;

/*  Seconds of visible, focused playback that count as proof a server worked. Past
 *  any plausible accident, and short enough that the very first viewing of a
 *  provider already teaches the ranking something. */
const MZ_PLAYED_PROOF_SEC = 15;

/** A human actually watched something through this provider. */
function recordPlayerPlayed(name) {
  if (!name) return;
  const e = _mzHealthEntry(name);
  e.played = (e.played || 0) + 1;
  // A real play is proof the server works, so it also forgives past impatience.
  e.fail = Math.max(0, +(e.fail - 1).toFixed(1));
  _mzPersistPlayerHealth();
}

/** True for a provider that keeps answering but has never actually played. */
function playerNeverPlayed(name) {
  const e = playerHealth()[name];
  if (!e) return false;
  return (e.ok || 0) >= MZ_NOPLAY_SUSPECT_AFTER && !(e.played > 0);
}

/*  Ranking cost, lower is better. A failure is weighted far above any latency
 *  difference, because waiting for a dead server costs the full timeout while
 *  the gap between a fast and a slow working server is a second or two.
 *  Never-tried servers sit mid-pack: ahead of known-bad, behind known-good, so
 *  the player explores rather than locking onto the first thing that worked.
 */
function playerCost(name) {
  const h = playerHealth()[name];
  if (!h || (!h.ok && !h.fail)) return 4000;
  const attempts = h.ok + h.fail;
  const failRate = h.fail / Math.max(1, attempts);
  /*  A server that keeps ANSWERING but has never actually played is treated as
   *  badly as one that fails outright — see the note above recordPlayerPlayed.
   *  Without this a provider serving a 502 or a Cloudflare block page ranks FIRST,
   *  because an error page answers fast and books a success every time.
   *
   *  Added rather than multiplied, and clearable by a single real play, so this can
   *  never permanently bury a provider that is merely having an outage. */
  const noPlay = playerNeverPlayed(name) ? 12000 : 0;
  return (h.ms || 3500) + failRate * 12000 + noPlay;
}

function rankSourceIdxs(idxs) {
  return idxs.slice().sort((a, b) => {
    const d = playerCost(playerSources[a].name) - playerCost(playerSources[b].name);
    return d !== 0 ? d : a - b;   // stable: fall back to declared order
  });
}

/** Servers eligible for this content, honouring the anime and dub rules. */
function candidateSourceIdxs(lang, movie) {
  /*  A server may declare itself unusable on this browser via `skip()` — e.g. a
   *  player that refuses to run inside Android in-app browsers and shows its own
   *  "unsupported browser" panel, which still fires the iframe's load event, so the
   *  auto-retry chain could not detect it. No entry needs it right now (VidSrc HD,
   *  the one that did, was removed); the hook stays for the next one that does.
   *  Applied first so the anime and dub rules below only ever see usable servers,
   *  and guarded so it can never empty the pool. */
  const usable = playerSources.map((_, i) => i).filter(i => {
    const s = playerSources[i];
    if (typeof s.skip !== 'function') return true;
    try { return !s.skip(); } catch (err) { return true; }
  });
  const all = usable.length ? usable : playerSources.map((_, i) => i);
  const isAnime = movie && (isAnimeContent(movie) || isCartoonContent(movie));
  if (isAnime) {
    const a = all.filter(i => playerSources[i].anime);
    if (a.length) return a;
  }
  if (MZ_DUBBED_LANGS.indexOf(lang) !== -1) {
    const d = all.filter(i => playerSources[i].dubbed);
    if (d.length) return d;
  }
  return all;
}

/** How long to wait before giving up on this specific server. */
function adaptivePlayerTimeout(name) {
  const h = playerHealth()[name];
  if (!h || !h.ok || !h.ms) return MZ_PH_DEFAULT_TIMEOUT;
  return Math.min(MZ_PH_MAX_TIMEOUT, Math.max(MZ_PH_MIN_TIMEOUT, Math.round(h.ms * 2.2)));
}

// Servers already attempted for the current play, so a retry chain never loops
// back onto something that just failed.
let _mzTriedSources = new Set();
function resetTriedSources() { _mzTriedSources = new Set(); }

function getSelectedSourceIdx() {
  const raw = localStorage.getItem('moviezone.playerSourceIdx');
  const saved = parseInt(raw === null ? '-1' : raw, 10);
  /*  candidateSourceIdxs (not the raw index list) so a server that declares
   *  itself unusable on this browser is never the opening pick either — otherwise
   *  an in-app-browser viewer would land straight on its "unsupported" panel
   *  before the retry chain has any say.
   *
   *  getSelectedLang is guarded rather than assumed: player-health.test.js extracts
   *  this function into a bare VM sandbox that has no DOM and no language helper,
   *  and 'en' is the neutral value there — it selects the full pool, which is the
   *  behaviour that test asserts. */
  const lang = (typeof getSelectedLang === 'function') ? getSelectedLang() : 'en';
  const pool = candidateSourceIdxs(lang, currentModalMovie);
  const ranked = rankSourceIdxs(pool.length ? pool : playerSources.map((_, i) => i));
  const best = ranked.length ? ranked[0] : 0;

  // Nothing stored yet — open on whatever has actually performed best here
  // rather than always on index 0.
  if (isNaN(saved) || saved < 0 || saved >= playerSources.length) return best;

  /*  A saved pick that rules itself out for THIS title (skip(): Toon Hindi on a
   *  live-action film) is not reopened on it; the next animated title still is,
   *  because the saved index itself is left alone. Only servers that declare
   *  skip() are affected. */
  const savedSource = playerSources[saved];
  if (savedSource && typeof savedSource.skip === 'function') {
    try { if (savedSource.skip()) return best; } catch (err) { /* keep the saved pick */ }
  }

  /*  A stored pick is respected, with one exception: if that server's measured
   *  record is far worse than the best available, honouring it would mean
   *  knowingly making the user watch a spinner. The threshold is deliberately
   *  high (twice the cost AND above the mid-pack baseline) so a genuine
   *  preference is not overridden by one unlucky failure.
   */
  const savedCost = playerCost(playerSources[saved].name);
  if (savedCost > playerCost(playerSources[best].name) * 2 && savedCost > 6000) return best;
  return saved;
}
 
function setSelectedSourceIdx(idx) {
  localStorage.setItem('moviezone.playerSourceIdx', String(idx));
}
 
function buildSourceLabel(srcIdx) {
  return playerSources[srcIdx] ? playerSources[srcIdx].name : (playerSources[0] ? playerSources[0].name : 'Source');
}
 
function playMovie() {
  if (!currentModalMovie) return;
  // Start an accurate watch session (real progress, not a random guess). It
  // seeds the Continue Watching rail immediately and tracks visible watch time
  // against the title's runtime — see _mzStartWatchSession.
  if (typeof _mzStartWatchSession === 'function' && currentModalMovie) {
    const rt = currentModalMovie.runtime ||
      (currentModalMovie.episode_run_time && currentModalMovie.episode_run_time[0]) || 0;
    _mzStartWatchSession(currentModalMovie, rt);
  }
  currentSourceIdx = getSelectedSourceIdx();
  const lang = getSelectedLang();
  const quality = getSelectedQuality();
  /*  The saved server ruled itself out for this title (skip(): Toon Hindi on a
   *  live-action film), so getSelectedSourceIdx() opened another one. That is a
   *  per-title stand-in, not a new choice: keepPick leaves the saved server in
   *  place for the next title it does serve. */
  const savedRaw = parseInt(localStorage.getItem('moviezone.playerSourceIdx') || '-1', 10);
  const savedSource = playerSources[savedRaw];
  let savedStandIn = false;
  if (savedSource && savedRaw !== currentSourceIdx && typeof savedSource.skip === 'function') {
    try { savedStandIn = !!savedSource.skip(); } catch (e) { savedStandIn = false; }
  }
  // Anime/Cartoon: agar user ka saved server anime support nahi karta to
  // automatically All-Rounder (anime-capable) server pe switch kar do
  if ((isAnimeContent(currentModalMovie) || isCartoonContent(currentModalMovie)) &&
      playerSources[currentSourceIdx] && !playerSources[currentSourceIdx].anime) {
    const animeIdx = playerSources.findIndex(sr => sr.anime);
    if (animeIdx !== -1) {
      currentSourceIdx = animeIdx;
      showToast(`Anime detected — switched to ${playerSources[animeIdx].name}`);
    }
  }
  _mzToonUserPick = false;   // the app is choosing now, not the viewer
  loadPlayer(currentModalMovie.id, currentSourceIdx, lang, quality, currentModalMovie.media_type,
    savedStandIn ? { keepPick: true } : undefined);
}
 
function playNextEpisode() {
  if (!currentModalMovie || currentModalMovie.media_type !== 'tv') return;
  
  const sInput = document.getElementById('seasonInput');
  const eInput = document.getElementById('episodeInput');
  if (!sInput || !eInput) return;
 
  const currentS = parseInt(sInput.value, 10);
  const currentE = parseInt(eInput.value, 10);
  
  const nextEpOption = Array.from(eInput.options).find(opt => parseInt(opt.value) === currentE + 1);
  
  if (nextEpOption) {
    eInput.value = currentE + 1;
    eInput.dispatchEvent(new Event('change'));
    showToast(` Playing Season ${currentS} Episode ${currentE + 1}`);
  } else {
    const seasons = (currentModalMovie.seasons || []).filter(s => s.season_number > 0);
    const nextSeason = seasons.find(s => s.season_number === currentS + 1);
    if (nextSeason) {
      sInput.value = currentS + 1;
      sInput.dispatchEvent(new Event('change'));
      showToast(` Playing Season ${currentS + 1} Episode 1`);
    } else {
      showToast(" You have reached the latest episode!");
    }
  }
}
 
/* ══════════════════════════════════════════════════════════════
   INSTANT PLAY ENGINE (Zero-wait playback)
   1. Provider host preconnect (DNS + TLS handshake pehle se ready)
   2. Hidden prewarm iframe — stream background me resolve ho jata hai
      jab user description/servers dekh raha hota hai
   3. Play dabate hi wahi ready frame reveal hota hai (naya load nahi)
   ══════════════════════════════════════════════════════════════ */
/*  Every provider origin the player can actually navigate to, derived from
 *  playerSources instead of written out by hand.
 *
 *  The hand-written list had drifted badly and silently: it still warmed
 *  vidrock.ru and embed.smashystream.com (the latter is a commented-out source)
 *  while three live servers — vidfast.pro, the Flicky player host and
 *  111movies.com — were never warmed at all. A user switching to one of those
 *  paid a full DNS + TCP +
 *  TLS handshake at the exact moment they wanted video. Deriving the list means
 *  adding or replacing a server warms the right host automatically.
 *
 *  Deriving it is also what made the Flicky host move (flicky.host ->
 *  player.vidzee.wtf) a one-line change instead of a hunt: the warm list, the
 *  dns-prefetch hints and the fallback preconnects all followed the new origin
 *  the moment the URL builder changed.
 *
 *  The URL builders read currentModalMovie for anime detection; with no modal
 *  open they take the plain movie branch, which is the origin we want. Each call
 *  is guarded because a builder for a server that needs an AniList id may throw.
 */
const ANILIST_HOST = 'https://graphql.anilist.co';
let _mzPlayerOrigins = null;

function playerHostOrigins() {
  if (_mzPlayerOrigins) return _mzPlayerOrigins;
  const origins = [];
  const add = (url) => {
    try {
      const origin = new URL(url).origin;
      if (origins.indexOf(origin) === -1) origins.push(origin);
    } catch (e) { /* not a URL we can warm */ }
  };
  playerSources.forEach((source) => {
    /*  BOTH branches, not just the movie one.
     *
     *  This probed only source.url(550, 'en', 'movie', ...), which is correct for
     *  every entry that serves films and episodes from one host — and silently
     *  wrong for one that does not. MultiLang HD used to send films to peachify.top
     *  and episodes to moviesapi.vip, so with the movie-only probe the episode host was
     *  never in this list: no dns-prefetch, no preconnect, and every series started
     *  with a cold DNS + TLS handshake on the critical path. Warming both costs two
     *  builder calls at startup and nothing at runtime, and it is future-proof for
     *  any other entry that splits by type. */
    try { add(source.url(550, 'en', 'movie', '1', '1')); } catch (e) { /* needs a modal */ }
    try { add(source.url(1399, 'en', 'tv', '1', '1')); } catch (e) { /* needs a modal */ }
    // A server whose URL is our own redirect names the hosts its frames land on.
    if (Array.isArray(source.hosts)) source.hosts.forEach(add);
  });
  origins.push(ANILIST_HOST);
  _mzPlayerOrigins = origins;
  return origins;
}

const _mzPreconnected = new Set();
let _mzPrewarm = null;

function preconnectHost(origin) {
  if (!origin || _mzPreconnected.has(origin)) return;
  _mzPreconnected.add(origin);
  try {
    const pc = document.createElement('link');
    pc.rel = 'preconnect'; pc.href = origin; pc.crossOrigin = 'anonymous';
    document.head.appendChild(pc);
    const dp = document.createElement('link');
    dp.rel = 'dns-prefetch'; dp.href = origin;
    document.head.appendChild(dp);
  } catch (e) {}
}

function preconnectPlayerHosts(limit) {
  playerHostOrigins().slice(0, limit || 4).forEach(preconnectHost);
}

/*  Warm the handshakes for the servers this user would ACTUALLY fall back to.
 *
 *  preconnectPlayerHosts() warms a slice of a hardcoded list, which has no
 *  relationship to the retry chain — it could warm three hosts none of which
 *  are ever used while the real fallback stays cold. This walks the same
 *  ranked, dub/anime-filtered pool that autoRetryNextServer() picks from, so
 *  if the first choice does fail the next attempt starts on an open connection
 *  instead of a fresh DNS lookup.
 *
 *  Only the TLS handshake is warmed here, not the embed document — prefetching
 *  several provider pages that will probably go unused is bandwidth a phone
 *  cannot spare.
 */
function warmRankedFallbacks(id, type, lang, count) {
  try {
    const pool = candidateSourceIdxs(lang, currentModalMovie);
    rankSourceIdxs(pool).slice(0, (count || 2) + 1).forEach((idx) => {
      const u = buildPlayerUrl(id, type, idx, lang);
      if (!u) return;
      try { preconnectHost(new URL(u).origin); } catch (e) {}
    });
  } catch (e) {}
}

function isDataSaver() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return ['slow-2g', '2g'].indexOf(c.effectiveType) !== -1;
}

/** Anime-aware server index (playMovie ka same logic, reuse ke liye) */
function effectiveSourceIdx() {
  let idx = getSelectedSourceIdx();
  const m = currentModalMovie;
  if (m && (isAnimeContent(m) || isCartoonContent(m)) && playerSources[idx] && !playerSources[idx].anime) {
    const animeIdx = playerSources.findIndex(sr => sr.anime);
    if (animeIdx !== -1) idx = animeIdx;
  }
  return idx;
}

function currentEpisodeSelection() {
  const sInput = document.getElementById('seasonInput');
  const eInput = document.getElementById('episodeInput');
  return {
    s: (sInput && sInput.value) ? sInput.value : '1',
    e: (eInput && eInput.value) ? eInput.value : '1'
  };
}

/*  ── RESUME OFFSET ─────────────────────────────────────────────────────────
 *
 *  Seconds to start playback at for a given title, read straight out of the
 *  Continue Watching entry. Zero when there is nothing worth resuming.
 *
 *  This exists as ONE function on purpose. loadPlayer() and prewarmPlayer() both
 *  build their URL through the same source builders, and takePrewarmedFrame()
 *  decides whether a prewarmed iframe is reusable by comparing the two URLs as
 *  STRINGS (`st.realUrl !== src`). If the offset were computed independently in
 *  each path, a one-second drift between them would silently disable prewarming
 *  and nobody would notice — the player would just get slower.
 *
 *  Only `positionSec` is used, never `watchedSec`. They are different things: for a
 *  provider that reports its playhead, positionSec is where the viewer actually is;
 *  watchedSec is how long the tab was open and focused, which is a fine progress
 *  estimate but a bad place to jump to. So a title only resumes when the position
 *  is genuinely known.
 *
 *  TV resumes per episode, because a season-2 episode-3 position is meaningless in
 *  season 1 episode 1.
 */
function mzResumeSec(id, type, s, e) {
  try {
    const list = JSON.parse(localStorage.getItem('mz_continue_watching')) || [];
    const key = (type === 'tv') ? (Number(id) + ':' + s + ':' + e) : String(Number(id));
    const entry = list.find(item => item && String(item.key || item.id) === key);
    const at = entry && Number(entry.positionSec);
    // Under half a minute is not a resume, it is a restart.
    return (Number.isFinite(at) && at > 30) ? Math.floor(at) : 0;
  } catch (err) { return 0; }
}

function buildPlayerUrl(id, type, srcIdx, lang) {
  const sel = currentEpisodeSelection();
  try {
    return playerSources[srcIdx].url(id, lang || getSelectedLang(), type, sel.s, sel.e);
  } catch (e) { return null; }
}

function destroyPrewarm() {
  if (_mzPrewarm && _mzPrewarm.iframe && _mzPrewarm.iframe.parentNode) {
    try { _mzPrewarm.iframe.src = 'about:blank'; } catch (e) {}
    try { _mzPrewarm.iframe.parentNode.removeChild(_mzPrewarm.iframe); } catch (e) {}
  }
  _mzPrewarm = null;
}

const _mzWarmedDocs = new Set();

/*  A warm-up that cannot reach the host at all is the earliest possible signal
 *  that this server is dead for THIS user — and it arrives while they are still
 *  reading the description, not after they pressed play and watched a spinner.
 *  Live probe from one Indian connection: nine of the ten servers answered in
 *  232-928ms, one did not answer within twelve seconds. Feeding that into the
 *  same ranking the real playback attempts feed means the next pick avoids it.
 *
 *  Only network-level failures count. A no-cors fetch resolves for opaque
 *  responses, including 403 and 404, so a rejection here means DNS, TLS, a
 *  refused connection or the timeout below — never "the provider answered
 *  something we cannot read".
 */
const MZ_WARM_TIMEOUT_MS = 8000;

/**
 * Warms the network path for an embed URL:
 *   1. preconnect  -> DNS + TCP + TLS handshake done before the click
 *   2. no-cors GET -> provider HTML lands in the HTTP cache
 * No iframe and no media element is created here, so the provider cannot start
 * video in a hidden frame (that is what produced the background-autoplay abort).
 */
function warmEmbedUrl(url, sourceName) {
  if (!url) return;
  try { preconnectHost(new URL(url).origin); } catch (e) {}
  if (isDataSaver() || _mzWarmedDocs.has(url)) return;
  _mzWarmedDocs.add(url);
  try {
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => { try { controller.abort(); } catch (e) {} }, MZ_WARM_TIMEOUT_MS)
      : null;
    const options = {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'force-cache',
      referrerPolicy: 'no-referrer'
    };
    if (controller) options.signal = controller.signal;
    fetch(url, options)
      .then(() => { if (timer) clearTimeout(timer); })
      .catch(() => {
        if (timer) clearTimeout(timer);
        /*  Let the ranking learn from it. The URL is dropped from the warmed set
         *  so a later attempt (better network, provider back up) can try again. */
        _mzWarmedDocs.delete(url);
        if (sourceName && typeof recordPlayerFailure === 'function') {
          try { recordPlayerFailure(sourceName); } catch (e) {}
        }
      });
  } catch (e) {}
}

function warmPlayerConnection(id, type) {
  if (!id) return;
  const idx = effectiveSourceIdx();
  warmEmbedUrl(buildPlayerUrl(id, type, idx), playerSources[idx] && playerSources[idx].name);
}

/**
 * Warm the selected provider connection without creating a browsing context.
 * The real iframe is created only by loadPlayer(), following an explicit play.
 */
function warmUrlVariant(url) {
  // Autoplay params ko warmup ke liye off kar do (param ka exact casing preserve).
  return url.replace(/([?&])(autoplay|autoPlay|autoplayNextEpisode|autoplaynextepisode)=true/g,
    (m, sep, key) => sep + key + '=false')
    /*  Numeric form (OmniPlay / VidRift): `autoplay=0` is that player's only
     *  "do not start" switch, so a hidden warm-up frame must carry it. */
    .replace(/([?&])autoplay=1(?=&|$)/g, (m, sep) => sep + 'autoplay=0');
}

/**
 * INSTANT PLAY: modal khulne par provider ko ek hidden frame me load kar deta hai,
 * lekin autoplay OFF ke saath ? isliye Chrome ka "background media paused to save
 * power" abort nahi aata. Play dabane par usi frame ko real stream URL par navigate
 * kiya jata hai: DNS/TLS, provider JS/CSS sab cached hote hain, to playback jaldi shuru.
 */
/*  ── WHO CAN AFFORD A SPECULATIVE SECOND BROWSING CONTEXT ──────────────────
 *  prewarmPlayer() below does not merely open a socket — it attaches a live
 *  iframe pointing at a third-party player document, which pulls that provider's
 *  HTML, JS and CSS and usually an ad/resolver chain behind it, all before the
 *  viewer has pressed Play. On a fast device that is the trade the "instant play"
 *  design intends and it pays off.
 *
 *  It was guarded only by isDataSaver() and "a real player already exists", so
 *  the weakest hardware in the fleet was paying the largest speculative cost:
 *
 *  - On a TV this is the worst thing on the page. It is a whole extra document on
 *    a CPU already several times slower than a phone's, held at opacity:0.001
 *    rather than display:none (deliberately, so the frame is not throttled) which
 *    means it is also composited on every frame. And it is not even click-gated
 *    there: tv-mode.js synthesises a mouseover after ~650-900ms of D-pad rest on a
 *    card, so merely leaving the highlight on a tile started a provider load.
 *  - On a 2-core / 2GB phone the parse and execute of the provider's bundle lands
 *    on the same main thread the modal is still settling on, which is precisely
 *    the interaction the user is waiting on.
 *
 *  Nothing is lost by declining: playMovie() builds the real frame on demand, and
 *  warmEmbedUrl above still runs for every device, so the DNS/TLS handshake to
 *  the chosen provider is warmed regardless. Only the speculative document fetch
 *  is skipped — the cheap half of the optimisation is kept everywhere, and only
 *  the expensive half is means-tested. */
function canAffordPrewarmFrame() {
  if (isDataSaver()) return false;   // save-data, 2g, slow-2g
  if (isMzTV()) return false;        // weakest CPU, and triggered by focus rest
  if (mzLowTier) return false;       // <=2 cores / <=2GB / TV UA / 2g
  return true;
}

function prewarmPlayer(id, type, srcIdxOverride) {
  if (!id || isDataSaver() || document.getElementById('playerFrame')) return;
  const embedEl = document.getElementById('videoEmbed');
  if (!embedEl) return;
  const idx = (typeof srcIdxOverride === 'number') ? srcIdxOverride : effectiveSourceIdx();
  const realUrl = buildPlayerUrl(id, type, idx);
  if (!realUrl) return;
  warmEmbedUrl(realUrl, playerSources[idx] && playerSources[idx].name);
  /*  The split point, and it matters which side of warmEmbedUrl it sits on.
   *  Above, every device — TV and low-tier phone included — has already warmed
   *  DNS/TLS to the chosen provider, which is the cheap half of "instant play".
   *  Only the speculative document fetch below is means-tested. Declining before
   *  warmEmbedUrl would have taken that free win away from exactly the devices
   *  this guard exists to protect. */
  if (!canAffordPrewarmFrame()) return;
  if (_mzPrewarm && _mzPrewarm.realUrl === realUrl && _mzPrewarm.iframe && _mzPrewarm.iframe.parentNode) return;

  destroyPrewarm();
  const frame = document.createElement('iframe');
  frame.className = 'mz-prewarm-frame';
  frame.id = 'mzPrewarmFrame';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('title', 'Preparing stream');
  frame.setAttribute('frameborder', '0');
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', 'encrypted-media'); // autoplay delegate NAHI
  frame.setAttribute('loading', 'eager');
  frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0.001;pointer-events:none;z-index:0;';

  const state = { realUrl: realUrl, iframe: frame, loaded: false, srcIdx: idx, id: id, type: type, startedAt: Date.now() };
  frame.addEventListener('load', () => { state.loaded = true; });
  try {
    if (getComputedStyle(embedEl).position === 'static') embedEl.style.position = 'relative';
  } catch (e) {}
  embedEl.appendChild(frame);
  frame.src = warmUrlVariant(realUrl);
  _mzPrewarm = state;
}

/** Prewarmed frame ko claim karta hai agar wahi stream URL match kare */
function takePrewarmedFrame(embedEl, src) {
  const st = _mzPrewarm;
  if (!st || !src || st.realUrl !== src) return null;
  if (!st.iframe || st.iframe.parentNode !== embedEl) return null;
  _mzPrewarm = null;
  return st;
}

/** Modal khulte hi (ya Play button hover par) playback ready karna */
function schedulePlayerPrewarm(id, type, delay) {
  if (window._mzPrewarmTimer) clearTimeout(window._mzPrewarmTimer);
  window._mzPrewarmTimer = setTimeout(() => prewarmPlayer(id, type), typeof delay === 'number' ? delay : 120);
}

/*  ── PROVIDER HANDSHAKE WATCHDOG ───────────────────────────────────────────
 *  A cross-origin frame that fired `load` may still be an error card (HTTP 451
 *  "This title is not available.", a dead resolver ...), and `load` alone cannot
 *  tell the two apart — which is how earlier outages hid behind "the iframe
 *  loaded". A server that declares `signal: { origin, prefix }` posts messages
 *  of that prefix as soon as its real player boots (VidRift: vidrift:ui-hidden and
 *  vidrift:providers within ~1s, measured). No such message by
 *  MZ_SIGNAL_GRACE_MS after `load` means there is no player in the frame, and the
 *  viewer is moved to the next server instead of being left on the error card.
 *
 *  Title-specific by nature, so it neither records a ranking failure nor
 *  overwrites the viewer's saved server: the next title still opens on it. */
const MZ_SIGNAL_GRACE_MS = 7000;
let _mzSignalWatch = null;

function clearSignalWatch() {
  if (_mzSignalWatch && _mzSignalWatch.timer) clearTimeout(_mzSignalWatch.timer);
  _mzSignalWatch = null;
}

window.addEventListener('message', (event) => {
  const w = _mzSignalWatch;
  if (!w || event.origin !== w.origin) return;
  const d = event.data;
  const t = (d && typeof d === 'object') ? d.type : null;
  if (typeof t !== 'string' || t.indexOf(w.prefix) !== 0) return;
  w.seen = true;
  if (w.timer) { clearTimeout(w.timer); w.timer = null; }
});

/** Armed when the frame starts navigating, so an early handshake is not missed. */
function armSignalWatch(source, iframe, onSilent) {
  clearSignalWatch();
  if (!source || !source.signal || !iframe) return null;
  _mzSignalWatch = { origin: source.signal.origin, prefix: source.signal.prefix,
    iframe: iframe, onSilent: onSilent, seen: false, timer: null };
  return _mzSignalWatch;
}

/** Called from the frame's `load`: start the grace period unless it already spoke. */
function startSignalGrace(iframe) {
  const w = _mzSignalWatch;
  if (!w || w.iframe !== iframe || w.seen || w.timer) return;
  w.timer = setTimeout(() => {
    if (_mzSignalWatch !== w || w.seen) return;
    _mzSignalWatch = null;
    // Superseded (server switched, modal closed): nothing to rescue.
    if (!iframe.isConnected || document.getElementById('playerFrame') !== iframe) return;
    try { w.onSilent(); } catch (e) {}
  }, MZ_SIGNAL_GRACE_MS);
}

/*  Referrer policy per provider frame. Everything stays on no-referrer (what each
 *  server was measured with) EXCEPT OmniPlay's engine, VidRift, which needs to know
 *  its parent page. With no Referer it sees parent "" and runs its popup-capability
 *  probe on every viewer's first click; with our origin it recognises the embedder
 *  (localhost skips the probe outright, and a production host gets judged on its
 *  own record instead of the anonymous bucket that sandboxing embedders share).
 *  Origin only — never the path or #watch hash — and the same policy the SSR
 *  watch page (seo-ssr.js) already uses for this exact player. */
const MZ_FRAME_REFERRER = { 'https://embed.vidrift.net': 'origin' };
function frameReferrerPolicy(src) {
  try { return MZ_FRAME_REFERRER[new URL(src).origin] || 'no-referrer'; } catch (e) { return 'no-referrer'; }
}

function loadPlayer(id, srcIdx, lang, quality, type = 'movie', opts) {
  // Stop trailer instantly when movie starts playing
  if (activeTrailerStopper) activeTrailerStopper();
  // A new player supersedes any handshake still pending for the previous one.
  clearSignalWatch();

  const embedEl = document.getElementById('videoEmbed');
  if (!embedEl) return;
  
  currentSourceIdx = srcIdx;
  // A title-specific automatic fallback (see armSignalWatch) must not overwrite
  // the viewer's saved server — the next title should still open on it.
  if (!(opts && opts.keepPick)) setSelectedSourceIdx(srcIdx);
  lang = lang || getSelectedLang();
  setSelectedLang(lang);
  quality = quality || getSelectedQuality();
  setSelectedQuality(quality);
  
  // -- SMART SERVER SELECTION: Hindi/Regional = auto-pick best dubbed server --
  const DUBBED_LANG_LIST = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'];
  if (DUBBED_LANG_LIST.includes(lang) && playerSources[srcIdx] && !playerSources[srcIdx].dubbed) {
    // User ne Hindi/Regional select kiya but non-dubbed server pe hai - auto switch to best dubbed server
    const bestDubIdx = playerSources.findIndex(s => s.dubbed === true);
    if (bestDubIdx !== -1 && bestDubIdx !== srcIdx) {
      srcIdx = bestDubIdx;
      currentSourceIdx = srcIdx;
      setSelectedSourceIdx(srcIdx);
      showToast(` Auto-switched to ${playerSources[srcIdx].name} for best Hindi Dub`);
    }
  }
  
  const sInput = document.getElementById('seasonInput');
  const eInput = document.getElementById('episodeInput');
  const s = sInput ? sInput.value : '1';
  const e = eInput ? eInput.value : '1';
  const src = playerSources[srcIdx].url(id, lang, type, s, e);

  // Anime/Cartoon servers: AniList ID background me resolve karo aur milte hi
  // player ko asli anime stream (Hindi dub / dub / sub) par upgrade kar do.
  // Only servers whose URL actually uses the AniList id (`anilist: true`) —
  // reloading a TMDB-route player would restart playback for an identical URL.
  if (playerSources[srcIdx] && playerSources[srcIdx].anilist && isAnimeContent(currentModalMovie)) {
    ensureAnilistThenReload(currentModalMovie, s, srcIdx, lang, quality, type);
  }
 
  // AUTO-SAVE TV PROGRESS (Continue Watching)
  if (type === 'tv') {
    localStorage.setItem('mz_progress_' + id, JSON.stringify({ season: parseInt(s), episode: parseInt(e) }));
  }

  // ── INSTANT PLAY: agar yahi stream pehle se prewarm ho chuki hai to
  //    naya load karne ki zarurat nahi — sirf usi ready frame ko reveal karo
  const preState = takePrewarmedFrame(embedEl, src);
  const reusable = preState ? preState.iframe : null;
  // Warm frame ko real (autoplay) URL par navigate karna padta hai, to loader dikhega.
  const preAlreadyLoaded = false;

  if (reusable) {
    // Placeholder/loader hatao, prewarm frame ko waise hi rehne do (reparent = reload)
    Array.prototype.slice.call(embedEl.childNodes).forEach(n => { if (n !== reusable) embedEl.removeChild(n); });
  } else {
    destroyPrewarm();
    // Clear previous player instantly to prevent background audio/lag
    embedEl.innerHTML = '';
  }
  
  // Cancel any running auto-retry timer
  if (window._mzRetryTimer) { clearTimeout(window._mzRetryTimer); window._mzRetryTimer = null; }
 
  // Add Optimized Loading Spinner with server info
  const isDubServer = playerSources[srcIdx].dubbed;
  let loader = null;
  if (!preAlreadyLoaded) {
    loader = document.createElement('div');
    loader.className = 'player-loader';
    loader.id = 'mzPlayerLoader';
    loader.innerHTML = `
      <div class="player-spinner"></div>
      <div style="color:var(--gold); margin-top:15px; font-weight:600; font-size:0.9rem;">
        ${reusable ? 'Almost ready...' : (isDubServer ? 'Loading Hindi Dubbed Stream...' : 'Loading Stream...')}
      </div>
      <div style="color:rgba(255,255,255,0.4); margin-top:6px; font-size:0.75rem;">
        Server: ${escapeHTML(playerSources[srcIdx].name)} ${isDubServer ? '• Dubbed' : ''}
      </div>
    `;
    embedEl.appendChild(loader);
  }
 
  const iframe = reusable || document.createElement('iframe');
  iframe.id = 'playerFrame';
  iframe.style.cssText = 'width: 100%; height: 100%; border: none; background: transparent; position: relative; z-index: 1; transform: translateZ(0);';
  iframe.style.opacity = '1';
  iframe.style.pointerEvents = 'auto';
  iframe.className = '';
  iframe.removeAttribute('aria-hidden');
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
  /*  Console warning fix: "Allow attribute will take precedence over
   *  'allowfullscreen'". Jab `allow` present hota hai to browser legacy
   *  `allowfullscreen` ko ignore kar deta hai aur warn karta hai. Legacy
   *  attributes sirf un purane browsers ke liye chahiye (kuch Smart TV
   *  browsers) jo `allow` support nahi karte — isliye ab conditional. */
  if (!('allow' in HTMLIFrameElement.prototype)) {
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('webkitallowfullscreen', '');
  }
  iframe.setAttribute('title', 'MovieZone video player');
  iframe.setAttribute('tabindex', '0');
  iframe.setAttribute('referrerpolicy', frameReferrerPolicy(src));
  iframe.setAttribute('fetchpriority', 'high');
  iframe.setAttribute('loading', 'eager');
  if (!reusable) embedEl.appendChild(iframe);
  /*  Handshake watch is armed BEFORE navigation starts, so a provider message
   *  posted ahead of `load` (VidRift posts at ~0.6s) still counts. */
  const _mzSource = playerSources[srcIdx];
  /*  Toon Hindi picked by hand stays put while it LOADS: no timeout switch.
   *  Nothing else moves it either — a title its Hindi libraries lack plays a
   *  backup inside its own player (see the mz-toon listener).
   *  The pick sticks while Toon Hindi is the server — an episode, season or
   *  language change reloads it without a flag and must not undo the choice.
   *  It is cleared by loading any other server, and by the app choosing a
   *  server itself (playMovie, the retry chain, Try All), which fail over. */
  if (!_mzSource.toon) _mzToonUserPick = false;
  else if (opts && opts.userPick) _mzToonUserPick = true;
  const _mzStayPut = _mzToonUserPick;
  armSignalWatch(_mzSource, iframe, () => {
    autoRetryNextServer(id, srcIdx, lang, quality, type, { keepPick: true, reason: 'unavailable' });
  });
  // Same element par navigate: connection + provider assets already warm.
  iframe.src = src;

  // -- AUTO-RETRY SYSTEM: If server doesn't load in time, try next dubbed server --
  let hasLoaded = preAlreadyLoaded;
  const _mzSrcName = playerSources[srcIdx].name;
  const _mzStartedAt = Date.now();
  _mzTriedSources.add(_mzSrcName);
  /*  Which provider the watch tracker should credit when it sees real playback.
   *  Read by recordPlayerPlayed's callers — see the note above that function for
   *  why "the frame loaded" is not the signal the ranking needs. */
  window._mzActivePlayerName = _mzSrcName;

  let _mzResumeSent = false;
  iframe.onload = () => {
    hasLoaded = true;
    // Feeds the ranking: this is how the player learns which providers are
    // actually fast on this user's network.
    recordPlayerLoad(_mzSrcName, Date.now() - _mzStartedAt);
    startSignalGrace(iframe);
    /*  Players that take the resume point as a message (OmniPlay / VidRift:
     *  vidrift:resume, "safe to send before the video is ready"). Once per play —
     *  a later `load` is the provider swapping episodes itself, and an old
     *  position must not be pushed into a different episode. */
    if (!_mzResumeSent && _mzSource.resume && _mzSource.signal) {
      _mzResumeSent = true;
      const at = (typeof mzResumeSec === 'function') ? mzResumeSec(id, type, s, e) : 0;
      if (at > 0) {
        try { iframe.contentWindow.postMessage(_mzSource.resume(at), _mzSource.signal.origin); } catch (err) {}
      }
    }
    if (loader && loader.parentNode) { 
      loader.style.opacity = '0';
      setTimeout(() => { if (loader && loader.parentNode) loader.remove(); }, 400);
    }
  };
  
  iframe.onerror = () => {
    // Server refused connection - auto try next
    recordPlayerFailure(_mzSrcName);
    autoRetryNextServer(id, srcIdx, lang, quality, type);
  };

  // Prewarm frame pehle hi load ho chuka tha — loader hi mat dikhao
  if (preAlreadyLoaded && loader && loader.parentNode) loader.remove();

  // Timeout-based auto-retry. The wait now follows this server's own measured
  // history instead of a flat 5 s, so a provider that normally answers in
  // ~1.2 s is abandoned in ~2.6 s rather than holding the user for five.
  if (!hasLoaded) {
    /*  `patience`: a server whose first navigation includes work on our side
     *  (Toon Hindi resolves the title before redirecting) gets that time on top
     *  of its measured history. Only servers that declare it are affected. */
    const base = Math.max(adaptivePlayerTimeout(_mzSrcName), _mzSource.patience || 0);
    const retryAfter = Math.max(MZ_PH_MIN_TIMEOUT, reusable ? base - 800 : base);
    window._mzRetryTimer = setTimeout(() => {
      if (!hasLoaded && _mzStayPut) {
        // Picked by hand: never switch away. Uncover the frame so whatever it
        // is showing can be seen, and say so; the viewer decides what next.
        const slowLoader = document.getElementById('mzPlayerLoader');
        if (slowLoader) slowLoader.remove();
        showToast(`${_mzSrcName} is slow right now. Give it a moment, or pick another server.`);
        return;
      }
      if (!hasLoaded) {
        recordPlayerFailure(_mzSrcName);
        const loaderEl = document.getElementById('mzPlayerLoader');
        if (loaderEl) {
          loaderEl.innerHTML = `
            <div style="color:#e63946; font-size:0.9rem; font-weight:600;"> Server slow/blocked</div>
            <div style="color:rgba(255,255,255,0.5); margin-top:6px; font-size:0.78rem;">Auto-trying next dubbed server...</div>
            <div class="player-spinner" style="width:28px; height:28px; border-width:2px; margin-top:10px;"></div>
          `;
        }
        setTimeout(() => autoRetryNextServer(id, srcIdx, lang, quality, type), 400);
      }
    }, retryAfter);
  }

  // Optimistic UI: Start fading loader after 1.5s for perceived speed
  setTimeout(() => {
    if (hasLoaded && loader && loader.parentNode) {
        loader.style.opacity = '0';
        setTimeout(() => { if (loader && loader.parentNode) loader.remove(); }, 400);
    }
  }, 1500);
 
  // Render Player Controls with "Try All Servers" button
  const _toastLangName = (LANG_CONFIG[lang] && LANG_CONFIG[lang].name) || lang.toUpperCase();
  const _dubbedStatus = isDubServer ? 'Dubbed' : 'Original';
  const _epLabel = type === 'tv' ? ` | S${s} E${e}` : '';
  // Left side of the toolbar: which server is on screen right now.
  let controlsHtml = '<div id="playerControls" class="player-controls">' +
    '<div class="player-now"><i></i><b>' + escapeHTML(_mzSrcName) + '</b><span>' +
    escapeHTML(_toastLangName) + ' · ' + _dubbedStatus + _epLabel.replace(' |', ' ·') + '</span></div>';
  if (type === 'tv') {
    controlsHtml += '<button onclick="playNextEpisode()" class="player-chip premium-play-btn">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>' +
        '<span>Next Ep</span></button>';
  }
  // TRY ALL SERVERS BUTTON (Dubbed)
  controlsHtml += '<button onclick="tryAllDubbedServers()" class="player-chip player-chip--try" id="tryAllBtn" title="Automatically cycle through all dubbed servers to find working Hindi audio">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>' +
      '<span>Try All Dubbed Servers</span></button>';
  controlsHtml += '<button onclick="togglePlayerFS()" class="player-chip player-chip--fs" id="fsBtn">' +
        '<svg class="player-chip__icon" viewBox="0 0 24 24"><path d="M7 3H3v4h2V5h2V3zm10 0v2h2v2h2V3h-4zM5 17H3v4h4v-2H5v-2zm16 0h-2v2h-2v2h4v-4z"></path></svg>' +
        '<span>Fullscreen</span></button></div>';

 
  const existingControls = document.getElementById('playerControls');
  if (existingControls) existingControls.outerHTML = controlsHtml;
  else embedEl.insertAdjacentHTML('afterend', controlsHtml);
 
  try { renderExternalSources(id, srcIdx, lang); } catch(e){}
 
  showToast('' + buildSourceLabel(srcIdx) + ' |  ' + _toastLangName + ' | ' + _dubbedStatus + _epLabel);
 
  // Smooth scroll to video player
  setTimeout(() => embedEl.scrollIntoView({ behavior: isMzTVMode() ? 'auto' : 'smooth', block: 'center' }), 300);
  
}

function autoRetryNextServer(id, currentIdx, lang, quality, type, opts) {
  /*  Retry order is measured, not positional.
   *
   *  This used to scan forward from currentIdx and take the next index that
   *  matched the dub/anime rule, so the fallback chain was simply whatever
   *  order the array happened to be in. A user whose first three providers are
   *  regionally blocked walked all three on every single play, paying the full
   *  timeout each time, and learned nothing for next time.
   *
   *  The eligible pool now gets ordered by the same learned cost the initial
   *  pick uses, and anything already attempted during THIS play is skipped so
   *  the chain cannot loop back onto a server that just failed.
   */
  const pool = candidateSourceIdxs(lang, currentModalMovie)
    .filter(i => i !== currentIdx && !_mzTriedSources.has(playerSources[i].name));

  let nextIdx = -1;
  const ranked = rankSourceIdxs(pool);
  if (ranked.length) {
    nextIdx = ranked[0];
  } else {
    // Every eligible server has been tried for this title. Start exploration
    // over on the best of the full list so the user still gets a player
    // instead of a dead end.
    resetTriedSources();
    const wide = rankSourceIdxs(playerSources.map((_, i) => i).filter(i => i !== currentIdx));
    if (wide.length) nextIdx = wide[0];
  }
  
  if (nextIdx !== -1 && nextIdx !== currentIdx) {
    const from = playerSources[currentIdx] ? playerSources[currentIdx].name : 'Server';
    const why = opts && opts.reason;
    const toName = playerSources[nextIdx].name;
    // A server that said "not here": the reason is shown AFTER loadPlayer,
    // whose own "<server> | Hindi" toast would otherwise replace it at once and
    // leave the viewer wondering why the server changed.
    const reasonToast = why === 'unavailable'
      ? ` ${from} doesn't have this title. Playing it on ${toName}...` : '';
    if (!reasonToast) showToast(` Server failed. Trying ${toName}...`);
    _mzToonUserPick = false;   // the app is choosing now, not the viewer
    loadPlayer(id, nextIdx, lang, quality, type, opts);
    if (reasonToast) showToast(reasonToast);
    /*  loadPlayer() has already re-rendered the chips with the right one active.
     *  Matched on data-srcidx, not DOM position: the chips are grouped (4K/anime
     *  first), so the Nth chip is not necessarily playerSources[N]. */
    document.querySelectorAll('.player-chip--source')
      .forEach(b => b.classList.toggle('active', b.getAttribute('data-srcidx') === String(nextIdx)));
  } else {
    showToast('All servers tried. Please try again later or change language.');
  }
}

// -- TRY ALL DUBBED SERVERS (One-click cycle through all dubbed servers) --
let _tryAllRunning = false;
let _tryAllCancelled = false;

function tryAllDubbedServers() {
  if (!currentModalMovie) return;
  
  if (_tryAllRunning) {
    // Cancel if already running
    _tryAllCancelled = true;
    _tryAllRunning = false;
    const btn = document.getElementById('tryAllBtn');
    if (btn) btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg><span style="font-size:12px; font-weight:700;">Try All Dubbed Servers</span>';
    showToast('Server cycling stopped');
    return;
  }
  
  _tryAllRunning = true;
  _tryAllCancelled = false;
  
  const lang = getSelectedLang();
  const quality = getSelectedQuality();
  const type = currentModalMovie.media_type || 'movie';
  const id = currentModalMovie.id;
  
  // Get only dubbed servers — minus any that rules itself out for this title
  // (skip(): Toon Hindi on a live-action film), so the cycle never stops on a
  // "not on this server" page.
  const dubbedIndices = [];
  playerSources.forEach((s, i) => {
    if (!s.dubbed) return;
    if (typeof s.skip === 'function') { try { if (s.skip()) return; } catch (err) { /* keep it */ } }
    dubbedIndices.push(i);
  });
  
  if (dubbedIndices.length === 0) {
    showToast('No dubbed servers available');
    _tryAllRunning = false;
    return;
  }
  
  const btn = document.getElementById('tryAllBtn');
  let currentTryIdx = 0;
  
  function tryNext() {
    if (_tryAllCancelled || currentTryIdx >= dubbedIndices.length) {
      _tryAllRunning = false;
      if (btn) btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg><span style="font-size:12px; font-weight:700;">Try All Dubbed Servers</span>';
      if (!_tryAllCancelled) showToast('All dubbed servers tested! Keep the one that works best.');
      return;
    }
    
    const serverIdx = dubbedIndices[currentTryIdx];
    const serverName = playerSources[serverIdx].name;
    
    if (btn) btn.innerHTML = `<div class="player-spinner" style="width:14px;height:14px;border-width:2px;border-color:rgba(245,197,24,0.2);border-left-color:var(--gold);"></div><span style="font-size:12px;font-weight:700;">Testing ${currentTryIdx + 1}/${dubbedIndices.length}... (Click to Stop)</span>`;
    
    showToast(` Testing server ${currentTryIdx + 1}/${dubbedIndices.length}: ${serverName}`);
    _mzToonUserPick = false;   // the app is cycling, not the viewer picking
    loadPlayer(id, serverIdx, lang, quality, type);
    
    // Update active button (by data-srcidx: chip order is grouped, not declared)
    document.querySelectorAll('.player-chip--source')
      .forEach(b => b.classList.toggle('active', b.getAttribute('data-srcidx') === String(serverIdx)));
    
    currentTryIdx++;
    
    // Give 8 seconds per server before trying next
    window._mzTryAllTimer = setTimeout(tryNext, 8000);
  }
  
  // Clear any existing retry timer
  if (window._mzRetryTimer) { clearTimeout(window._mzRetryTimer); window._mzRetryTimer = null; }
  if (window._mzTryAllTimer) { clearTimeout(window._mzTryAllTimer); window._mzTryAllTimer = null; }
  
  tryNext();
}
 
 
/*  ── DOWNLOADS ─────────────────────────────────────────────────────────────
 *  The Download button opens a sheet listing every download server on the Olly
 *  Embed roster (D1-D4), built for this title — or, for a series, for the season
 *  and episode picked below, with a stepper for the rest of the season. The sheet
 *  is /downloads.js (its header has the measurements behind each row): only a
 *  click needs it, so it stays out of the first-paint budget. It is requested the
 *  first time the button is approached (hover, focus, touch) and the click awaits
 *  that same request, so a cold click costs one small cached-forever fetch and a
 *  warm one costs nothing. */
let _mzDownloads = null;

function loadDownloads() {
  if (!_mzDownloads) {
    _mzDownloads = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/downloads.js?v=1';
      s.async = true;
      // A failed load must not poison the next click: forget it so that one retries.
      const fail = () => { _mzDownloads = null; s.remove(); reject(new Error('downloads.js did not load')); };
      s.onload = () => (window.MZDownloads ? resolve(window.MZDownloads) : fail());
      s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  return _mzDownloads;
}

async function downloadMovie() {
  const movie = currentModalMovie;
  if (!movie) return;
  const btn = document.querySelector('.btn-download');
  const isSeries = movie.media_type === 'tv';
  const sel = currentEpisodeSelection();
  /*  The season's episodes, read back from the Episode <select> openModal() filled:
   *  "Ep 3 · The Rains of Castamere" -> { n: 3, name: 'The Rains of Castamere' }.
   *  While a season is still loading its only option is not a number and is skipped. */
  const episodes = [];
  const eInput = isSeries ? document.getElementById('episodeInput') : null;
  if (eInput) {
    Array.prototype.forEach.call(eInput.options, (o) => {
      const n = parseInt(o.value, 10);
      if (n > 0) episodes.push({ n, name: o.textContent.replace(/^Ep\s*\d+\s*\u00b7\s*/, '').trim() });
    });
  }
  const date = movie.release_date || movie.first_air_date || '';
  let sheet;
  if (btn) btn.setAttribute('aria-busy', 'true');
  try {
    sheet = await loadDownloads();
  } catch (err) {
    showToast('Download servers could not load. Check your connection and try again.');
    return;
  } finally {
    if (btn) btn.removeAttribute('aria-busy');
  }
  // The viewer may have closed the page, or opened another title, meanwhile.
  if (currentModalMovie !== movie) return;
  sheet.open({
    id: movie.id,
    type: isSeries ? 'tv' : 'movie',
    title: movie.title || movie.name || '',
    year: date.slice(0, 4),
    s: sel.s,
    e: sel.e,
    episodes,
    opener: btn
  });
}

// Warm the sheet on intent, so the click itself does not wait on the network.
(function warmDownloadsOnIntent() {
  const btn = document.querySelector('.btn-download');
  if (!btn) return;
  const warm = () => { loadDownloads().catch(() => {}); };
  ['pointerenter', 'focus', 'touchstart'].forEach((type) => btn.addEventListener(type, warm, { once: true, passive: true }));
})();
 
function togglePlayerFS() {
  const embedEl = document.getElementById('videoEmbed');
  const btn = document.getElementById('fsBtn');
  if (!embedEl) return;

  const activateCSSFullscreen = () => {
    isPlayerFullscreen = true;
    embedEl.classList.add('fullscreen-mode');
    if (btn) btn.textContent = 'Exit';
    document.addEventListener('keydown', exitFSOnEsc);
  };
 
  if (!document.fullscreenElement && !document.webkitFullscreenElement && !isPlayerFullscreen) {
    const target = embedEl;
    try {
      let fsResult = null;
      if (target.requestFullscreen) fsResult = target.requestFullscreen();
      else if (target.webkitRequestFullscreen) fsResult = target.webkitRequestFullscreen();
      else {
        activateCSSFullscreen();
        return;
      }
      
      Promise.resolve(fsResult).then(() => {
        if (screen.orientation && screen.orientation.lock) {
          return screen.orientation.lock('landscape').catch(() => {});
        }
      }).catch(activateCSSFullscreen);
    } catch (err) {
      activateCSSFullscreen();
    }
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    
    isPlayerFullscreen = false;
    embedEl.classList.remove('fullscreen-mode');
    if (btn) btn.textContent = 'Full';
    document.removeEventListener('keydown', exitFSOnEsc);
  }
}
 
const handleFullscreenChange = () => {
  const isFS = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
  if (!isFS) {
    // Jab fullscreen se bahar aaye, to rotation lock hata do
    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch(e){}
    }
  } else {
    // Jab bhi fullscreen mode me jaye, automatically Landscape me ghuma do (Mobile ke liye)
    if (screen.orientation && screen.orientation.lock) {
      try { screen.orientation.lock('landscape').catch(() => {}); } catch(e){}
    }
  }
};
 
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('mozfullscreenchange', handleFullscreenChange);
document.addEventListener('MSFullscreenChange', handleFullscreenChange);
 
// Direct #watch URLs are never auto-opened. Startup and BFCache/session restoration
// are sanitized by resetRestoredWatchSurface() before interaction.
 
function exitFSOnEsc(e) {
  if (e.key === 'Escape') togglePlayerFS();
}
 
const modalOverlay = document.getElementById('modal-overlay');
if (modalOverlay) {
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });
}
 
