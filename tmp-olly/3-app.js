/*
 * OllyEmbed - Premium Video Aggregation & Routing Engine
 * Author: Antigravity AI
 */

const TMDB_API_KEY = atob("YWJiZjUwMmFkN2VmNTQ1OGJmMGI5MWUwOWQ1MDQzYzA=");
const TMDB_BASE_URL = "https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/tmdb-api/3";

// State variables
let currentMediaType = "movie"; // 'movie' or 'tv'
let currentId = "";
let currentSeason = 1;
let currentEpisode = 1;
let activeServerIndex = 0;
let currentImdbId = "";
let currentMediaTitle = "";

// Server definitions synced with OllyFlix (12 Dedicated Live Streaming Servers)
let MOVIE_SERVERS = [
    { name: "Server Hindi", url: (id, imdb) => imdb ? `https://hanna427def.com/play/${imdb}` : `https://player.vidzee.wtf/embed/movie/${id}`, icon: "mic-outline", badge: "Dual Audio" },
    { name: "Server 2", url: (id) => `https://nxsha.space/embed/movie/${id}?lang=hi`, icon: "videocam-outline", badge: "Hindi v2" },
    { name: "Server 3", url: (id) => `https://vidstuck.xyz/embed/movie/${id}?server=centaurus&dubLang=hi`, icon: "flash-outline", badge: "Hindi v3" },
    { name: "Server 4", url: (id) => `https://backup.zxcprime.xyz/player/movie/${id}?dubLang=hi`, icon: "play-circle-outline", badge: "Hindi v4" },
    { name: "Server 5", url: (id) => `https://peachify.top/embed/movie/${id}`, icon: "happy-outline", badge: "Peachify" },
    { name: "Server 6", url: (id) => `https://player.vidzee.wtf/embed/movie/${id}`, icon: "videocam-outline", badge: "Zen" },
    { name: "Server 7", url: (id) => `https://nontongo.win/embed/movie/${id}`, icon: "moon-outline", badge: "Eclipse" },
    { name: "Server 8", url: (id) => `https://vidflix.club/movie/${id}`, icon: "tv-outline", badge: "Aurora" },
    { name: "Server 9", url: (id) => `https://vidlink.pro/movie/${id}`, icon: "link-outline", badge: "Nebula" },
    { name: "Server 10", url: (id) => `https://vidfast.vc/movie/${id}`, icon: "film-outline", badge: "Crimson" },
    { name: "Server 11", url: (id) => `https://vidsrc.fyi/embed/movie/${id}`, icon: "globe-outline", badge: "Zenith" },
    { name: "Server 12", url: (id) => `https://screenscape.me/embed?tmdb=${id}&type=movie`, icon: "sparkles-outline", badge: "Phantom" }
];

let TV_SERVERS = [
    { name: "Server Hindi", url: (id, imdb, s, e) => imdb ? `https://hanna427def.com/play/${imdb}?s=${s}&e=${e}` : `https://player.vidzee.wtf/embed/tv/${id}/${s}/${e}`, icon: "mic-outline", badge: "Dual Audio" },
    { name: "Server 2", url: (id, imdb, s, e) => `https://nxsha.space/embed/tv/${id}/${s}/${e}?lang=hi`, icon: "videocam-outline", badge: "Hindi v2" },
    { name: "Server 3", url: (id, imdb, s, e) => `https://vidstuck.xyz/embed/tv/${id}/${s}/${e}?server=centaurus&dubLang=hi`, icon: "flash-outline", badge: "Hindi v3" },
    { name: "Server 4", url: (id, imdb, s, e) => `https://backup.zxcprime.xyz/player/tv/${id}/${s}/${e}?dubLang=hi`, icon: "play-circle-outline", badge: "Hindi v4" },
    { name: "Server 5", url: (id, imdb, s, e) => `https://peachify.top/embed/tv/${id}/${s}/${e}`, icon: "happy-outline", badge: "Peachify" },
    { name: "Server 6", url: (id, imdb, s, e) => `https://player.vidzee.wtf/embed/tv/${id}/${s}/${e}`, icon: "videocam-outline", badge: "Zen" },
    { name: "Server 7", url: (id, imdb, s, e) => `https://nontongo.win/embed/tv/${id}/${s}/${e}`, icon: "moon-outline", badge: "Eclipse" },
    { name: "Server 8", url: (id, imdb, s, e) => `https://vidflix.club/tv/${id}/${s}/${e}`, icon: "tv-outline", badge: "Aurora" },
    { name: "Server 9", url: (id, imdb, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`, icon: "link-outline", badge: "Nebula" },
    { name: "Server 10", url: (id, imdb, s, e) => `https://vidfast.vc/tv/${id}/${s}/${e}`, icon: "film-outline", badge: "Crimson" },
    { name: "Server 11", url: (id, imdb, s, e) => `https://vidsrc.fyi/embed/tv/${id}/${s}/${e}`, icon: "globe-outline", badge: "Zenith" },
    { name: "Server 12", url: (id, imdb, s, e) => `https://screenscape.me/embed?tmdb=${id}&type=tv&s=${s}&e=${e}`, icon: "sparkles-outline", badge: "Phantom" }
];

// ═══════════════════════════════════════════════════════════════════════════
// Dynamic Server Synchronizer with OllyFlix Cloudflare (Zero Code Maintenance)
// ═══════════════════════════════════════════════════════════════════════════
const OLLYFLIX_SERVERS_API = "https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/api/embed-servers";
const STORAGE_SERVERS_KEY = "ollyembed_dynamic_servers";
const STORAGE_DOWNLOAD_SERVERS_KEY = "ollyembed_dynamic_download_servers";

// Download Server definitions synced with OllyFlix Cloudflare
let DOWNLOAD_SERVERS = [
    {
        id: 2,
        serverIndex: 1,
        name: "⚡ 02Downloader",
        displayName: "⚡ 02Downloader",
        cleanName: "02Downloader",
        badge: "D1",
        domain: "02moviedownloader.site",
        movie_url: "https://02moviedownloader.site/api/download/movie/{tmdb_id}",
        tv_url: "https://02moviedownloader.site/api/download/tv/{tmdb_id}/{season}/{episode}",
        color: "linear-gradient(135deg, var(--accent-purple), #6366f1)"
    },
    {
        id: 3,
        serverIndex: 2,
        name: "🔥 NxSha",
        displayName: "🔥 NxSha",
        cleanName: "NxSha",
        badge: "D2",
        domain: "nxsha.space",
        movie_url: "https://nxsha.space/dl/movie/{tmdb_id}",
        tv_url: "https://nxsha.space/dl/tv/{tmdb_id}/{season}/{episode}",
        color: "linear-gradient(135deg, #f97316, #e11d48)"
    },
    {
        id: 4,
        serverIndex: 3,
        name: "🚀 VidSync",
        displayName: "🚀 VidSync",
        cleanName: "VidSync",
        badge: "D3",
        domain: "vidsync.pro",
        movie_url: "https://vidsync.pro/embed/download/movie/{tmdb_id}",
        tv_url: "https://vidsync.pro/embed/download/tv/{tmdb_id}/{season}/{episode}",
        color: "linear-gradient(135deg, #22c55e, #059669)"
    },
    {
        id: 1,
        serverIndex: 4,
        name: "🎬 VidVault",
        displayName: "🎬 VidVault",
        cleanName: "VidVault",
        badge: "D4",
        domain: "vidvault.to",
        movie_url: "https://vidvault.to/movie/{tmdb_id}",
        tv_url: "https://vidvault.to/tv/{tmdb_id}/{season}/{episode}",
        color: "linear-gradient(135deg, #0ea5e9, #2563eb)"
    }
];

let pgActiveDownloadServerIndex = 0;

function applyRemoteDownloadServers(dlList) {
    if (!Array.isArray(dlList) || dlList.length === 0) return;
    const colorPalette = [
        "linear-gradient(135deg, var(--accent-purple), #6366f1)",
        "linear-gradient(135deg, #f97316, #e11d48)",
        "linear-gradient(135deg, #22c55e, #059669)",
        "linear-gradient(135deg, #0ea5e9, #2563eb)",
        "linear-gradient(135deg, #ec4899, #d946ef)",
        "linear-gradient(135deg, #eab308, #d97706)"
    ];
    DOWNLOAD_SERVERS = dlList.map((s, idx) => ({
        id: s.id || (idx + 1),
        serverIndex: s.serverIndex || (idx + 1),
        name: s.name || ("Download Server " + (idx + 1)),
        displayName: s.displayName || s.name || ("Download Server " + (idx + 1)),
        cleanName: s.cleanName || (s.name ? s.name.replace(/^[^\w\s]+/, '').trim() : ("Download " + (idx + 1))),
        badge: s.badge || ("D" + (idx + 1)),
        domain: s.domain || "",
        movie_url: s.movie_url || "",
        tv_url: s.tv_url || "",
        color: s.color || colorPalette[idx % colorPalette.length]
    }));

    // Update player settings & drawer download buttons
    renderDownloadButtons();
    // Update playground download server pills
    renderPlaygroundDownloadServers();
    // Update documentation download servers list
    renderDocsDownloadServers();
}

function loadCachedDownloadServers() {
    try {
        const cached = localStorage.getItem(STORAGE_DOWNLOAD_SERVERS_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0) {
                applyRemoteDownloadServers(parsed);
                return;
            }
        }
    } catch (e) {}
    // Render defaults if no cache yet
    renderDownloadButtons();
    renderPlaygroundDownloadServers();
    renderDocsDownloadServers();
}

function renderDownloadButtons() {
    const containers = [
        document.getElementById("settingsDownloadList"),
        document.getElementById("drawerDownloadList")
    ];

    containers.forEach(container => {
        if (!container) return;
        container.innerHTML = "";

        DOWNLOAD_SERVERS.forEach((server, idx) => {
            const btn = document.createElement("button");
            btn.className = "dl-button dl-srv-" + (server.id || idx);
            btn.style.height = "38px";
            btn.style.display = "flex";
            btn.style.alignItems = "center";
            btn.style.justifyContent = "center";
            btn.style.fontSize = "13px";
            btn.style.fontWeight = "800";
            btn.style.borderRadius = "8px";
            btn.style.border = "none";
            btn.style.cursor = "pointer";
            btn.style.transition = "transform 0.2s ease, box-shadow 0.2s ease";
            btn.style.background = server.color || "linear-gradient(135deg, var(--accent-purple), #6366f1)";
            btn.style.color = "white";
            btn.title = (server.cleanName || server.name) + " (Download)";
            btn.innerText = server.badge || ("D" + (idx + 1));

            btn.onmouseenter = () => { btn.style.transform = "translateY(-2px)"; btn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)"; };
            btn.onmouseleave = () => { btn.style.transform = "translateY(0)"; btn.style.boxShadow = "none"; };

            btn.onclick = (e) => {
                e.stopPropagation();
                triggerServerDownload(server);
            };

            container.appendChild(btn);
        });
    });
}

function renderPlaygroundDownloadServers() {
    const container = document.getElementById("pgDownloadPills");
    if (!container) return;
    container.innerHTML = "";

    DOWNLOAD_SERVERS.forEach((server, index) => {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = `pg-server-pill pg-dl-pill ${index === pgActiveDownloadServerIndex ? 'active' : ''}`;
        pill.innerHTML = `
            <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#22c55e; margin-right:4px;"></span>
            <span>${server.cleanName || server.name}</span>
            <span class="badge" style="background: rgba(255,255,255,0.15); margin-left: 6px;">${server.badge || ('D' + (index + 1))}</span>
        `;

        pill.addEventListener("click", () => {
            pgActiveDownloadServerIndex = index;
            document.querySelectorAll(".pg-dl-pill").forEach((btn, idx) => {
                btn.classList.toggle("active", idx === index);
            });
            if (typeof updatePlaygroundCode === "function") {
                updatePlaygroundCode(pgMediaType, pgId, pgSeason, pgEpisode, getActiveCodeTab());
            }
        });

        container.appendChild(pill);
    });

    const statusBadge = document.getElementById("pgDlStatusBadge");
    if (statusBadge) {
        statusBadge.innerText = `${DOWNLOAD_SERVERS.length} DL Synced`;
    }
}

function downloadPlaygroundMedia() {
    const currentServer = DOWNLOAD_SERVERS[pgActiveDownloadServerIndex] || DOWNLOAD_SERVERS[0];
    if (!currentServer) return;

    const idInput = document.getElementById("pgTmdbId");
    const seasonInput = document.getElementById("pgSeason");
    const episodeInput = document.getElementById("pgEpisode");

    const id = (idInput && idInput.value ? idInput.value.trim() : "") || pgId || "299534";
    const season = (seasonInput && seasonInput.value ? seasonInput.value.trim() : "") || pgSeason || 1;
    const episode = (episodeInput && episodeInput.value ? episodeInput.value.trim() : "") || pgEpisode || 1;

    const isMovie = pgMediaType === "movie";
    const template = isMovie ? currentServer.movie_url : currentServer.tv_url;

    if (!template) {
        const fallbackUrl = isMovie
            ? "https://vidvault.to/movie/" + id
            : "https://vidvault.to/tv/" + id + "/" + season + "/" + episode;
        window.open(fallbackUrl, "_blank");
        return;
    }

    const resolvedUrl = template
        .replace(/{tmdb_id}/g, id)
        .replace(/{imdb_id}/g, (typeof pgImdbId !== "undefined" && pgImdbId) ? pgImdbId : id)
        .replace(/{id}/g, id)
        .replace(/{season}/g, season)
        .replace(/{episode}/g, episode)
        .replace(/{s}/g, season)
        .replace(/{e}/g, episode);

    window.open(resolvedUrl, "_blank");
}

function renderDocsDownloadServers() {
    const list = document.getElementById("docsDownloadServersList");
    if (!list) return;
    list.innerHTML = "";

    DOWNLOAD_SERVERS.forEach((server, idx) => {
        const li = document.createElement("li");
        li.style.marginBottom = "8px";
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";
        li.style.flexWrap = "wrap";
        li.style.gap = "6px";
        const queryVal = (server.cleanName || server.id).toString().toLowerCase();
        li.innerHTML = `
            <div>
                <strong style="color: #10b981;">${server.name || server.cleanName} (${server.badge || ('D' + (idx + 1))})</strong> 
                <span style="color: var(--text-muted); font-size: 12px; margin-left: 4px;">(${server.domain || 'Direct API'})</span>
            </div>
            <code style="font-size: 11px; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; color: var(--accent-cyan);">?server=${queryVal}</code>
        `;
        list.appendChild(li);
    });

    const badge = document.getElementById("docsDlCountBadge");
    if (badge) {
        badge.innerText = `${DOWNLOAD_SERVERS.length} Active DL`;
    }
}

function renderDocsServers() {
    const list = document.getElementById("docsServersList");
    if (!list) return;
    list.innerHTML = "";

    MOVIE_SERVERS.forEach((server, idx) => {
        const li = document.createElement("li");
        li.style.marginBottom = "6px";
        const badgeText = server.badge || ('S' + (idx + 1));
        li.innerHTML = `<strong style="color: var(--accent-purple);">${server.name} (${badgeText})</strong> - Live Cloudflare Route`;
        list.appendChild(li);
    });

    const badge = document.getElementById("docsServerCountBadge");
    if (badge) {
        badge.innerText = `${MOVIE_SERVERS.length} Active`;
    }
}

function triggerServerDownload(server) {
    if (!currentId) return;
    const isMovie = currentMediaType === "movie";
    const template = isMovie ? server.movie_url : server.tv_url;
    if (!template) {
        const fallbackUrl = isMovie
            ? "https://vidvault.to/movie/" + currentId
            : "https://vidvault.to/tv/" + currentId + "/" + (currentSeason || 1) + "/" + (currentEpisode || 1);
        window.open(fallbackUrl, "_blank");
        return;
    }
    const resolvedUrl = template
        .replace(/{tmdb_id}/g, currentId)
        .replace(/{imdb_id}/g, currentImdbId || currentId)
        .replace(/{id}/g, currentId)
        .replace(/{season}/g, currentSeason || 1)
        .replace(/{episode}/g, currentEpisode || 1)
        .replace(/{s}/g, currentSeason || 1)
        .replace(/{e}/g, currentEpisode || 1);
    window.open(resolvedUrl, "_blank");
}

function applyRemoteServers(serversList) {
    if (!Array.isArray(serversList) || serversList.length === 0) return;

    const newMovies = [];
    const newTvs = [];

    serversList.forEach((s, idx) => {
        const srvId = s.id || (idx + 1);
        const srvName = s.name || (srvId === 1 ? "Server Hindi" : ("Server " + (idx + 1)));
        const badge = s.badge || s.displayName || (srvId === 1 ? "Dual Audio" : ("Server " + (idx + 1)));
        const icon = s.icon || (srvId === 1 ? "mic-outline" : "videocam-outline");
        const movieUrl = s.movie_url || "";
        const tvUrl = s.tv_url || "";

        newMovies.push({
            id: srvId,
            name: srvName,
            badge: badge,
            icon: icon,
            url: (id, imdb) => {
                if (srvName.toLowerCase().includes("hindi") && srvId === 1 && !imdb) {
                    return "https://player.vidzee.wtf/embed/movie/" + id;
                }
                return movieUrl
                    .replace(/\{imdb_id\}/g, imdb || id)
                    .replace(/\{tmdb_id\}/g, id)
                    .replace(/\{id\}/g, id);
            }
        });

        newTvs.push({
            id: srvId,
            name: srvName,
            badge: badge,
            icon: icon,
            url: (id, imdb, season, episode) => {
                const sNum = season || 1;
                const eNum = episode || 1;
                if (srvName.toLowerCase().includes("hindi") && srvId === 1 && !imdb) {
                    return "https://player.vidzee.wtf/embed/tv/" + id + "/" + sNum + "/" + eNum;
                }
                return tvUrl
                    .replace(/\{imdb_id\}/g, imdb || id)
                    .replace(/\{tmdb_id\}/g, id)
                    .replace(/\{id\}/g, id)
                    .replace(/\{season\}/g, sNum)
                    .replace(/\{episode\}/g, eNum)
                    .replace(/\{s\}/g, sNum)
                    .replace(/\{e\}/g, eNum);
            }
        });
    });

    if (newMovies.length > 0) {
        MOVIE_SERVERS = newMovies;
        TV_SERVERS = newTvs;
        
        // Re-render UI elements if active
        if (typeof renderServers === "function") renderServers();
        if (typeof renderPlaygroundServers === "function") renderPlaygroundServers();
        if (typeof renderDocsServers === "function") renderDocsServers();
    }
}

function loadCachedServers() {
    try {
        const cached = localStorage.getItem(STORAGE_SERVERS_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0) {
                applyRemoteServers(parsed);
                return;
            }
        }
    } catch (e) {}
    if (typeof renderDocsServers === "function") renderDocsServers();
}

async function syncActiveServersFromOllyflix() {
    try {
        let data = null;
        try {
            const resp = await fetch("/api/servers", { cache: "no-cache" });
            if (resp.ok) {
                const json = await resp.json();
                if (json && (Array.isArray(json.servers) || Array.isArray(json.download_servers))) {
                    data = json;
                }
            }
        } catch (_) {}

        // Fallback or augment with direct OllyFlix embed-servers API
        if (!data || !data.servers || !data.download_servers) {
            try {
                const directResp = await fetch(OLLYFLIX_SERVERS_API, { credentials: "omit", cache: "no-cache" });
                if (directResp.ok) {
                    const directJson = await directResp.json();
                    if (!data) {
                        data = directJson;
                    } else {
                        if ((!data.servers || !Array.isArray(data.servers)) && directJson.servers) {
                            data.servers = directJson.servers;
                        }
                        if ((!data.download_servers || !Array.isArray(data.download_servers)) && directJson.download_servers) {
                            data.download_servers = directJson.download_servers;
                        }
                    }
                }
            } catch (_) {}
        }

        // Extra fallback: fetch /api/download-servers directly if download_servers is missing
        if (!data || !data.download_servers || !Array.isArray(data.download_servers) || data.download_servers.length === 0) {
            try {
                const dlResp = await fetch("https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/api/download-servers", { credentials: "omit", cache: "no-cache" });
                if (dlResp.ok) {
                    const dlJson = await dlResp.json();
                    if (dlJson && Array.isArray(dlJson.download_servers) && dlJson.download_servers.length > 0) {
                        if (!data) data = {};
                        data.download_servers = dlJson.download_servers;
                    }
                }
            } catch (_) {}
        }

        if (data && data.servers && Array.isArray(data.servers) && data.servers.length > 0) {
            applyRemoteServers(data.servers);
            try {
                localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify(data.servers));
            } catch (_) {}
            console.log("[OllyEmbed] Auto-detected " + data.servers.length + " active live streaming servers from OllyFlix Cloudflare.");
        }

        if (data && data.download_servers && Array.isArray(data.download_servers) && data.download_servers.length > 0) {
            applyRemoteDownloadServers(data.download_servers);
            try {
                localStorage.setItem(STORAGE_DOWNLOAD_SERVERS_KEY, JSON.stringify(data.download_servers));
            } catch (_) {}
            console.log("[OllyEmbed] Auto-detected " + data.download_servers.length + " active download servers from OllyFlix Cloudflare.");
        }
    } catch (err) {
        console.warn("[OllyEmbed] Using fallback servers config:", err);
    }
}


// Initialize on load
document.addEventListener("DOMContentLoaded", () => {
    initApp();
});

// App Router and Initializer
function initApp() {
    // 1. Immediately apply cached servers & download servers
    loadCachedServers();
    loadCachedDownloadServers();
    // 2. Auto-detect live active servers from OllyFlix Cloudflare in background
    syncActiveServersFromOllyflix();

    // Detect iframe embedding
    const isEmbedded = window.self !== window.top;
    if (isEmbedded) {
        let isPlayground = false;
        try {
            isPlayground = window.top.location.origin === window.location.origin;
        } catch (e) {}
        
        if (isPlayground) {
            document.body.classList.add("is-playground");
        } else {
            document.body.classList.add("is-embedded");
        }
    }

    window.addEventListener("hashchange", routePage);
    window.addEventListener("popstate", routePage);

    // Block right-click and inspector keyboard shortcuts
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("keydown", (e) => {
        if (
            e.key === "F12" || 
            (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "i" || e.key === "J" || e.key === "j" || e.key === "C" || e.key === "c")) ||
            (e.ctrlKey && (e.key === "U" || e.key === "u"))
        ) {
            e.preventDefault();
        }
    });
    
    // Bind navigation clicks
    document.getElementById("navHome").addEventListener("click", (e) => {
        e.preventDefault();
        window.location.hash = "";
        routePage();
    });
    
    document.getElementById("navDocs").addEventListener("click", (e) => {
        e.preventDefault();
        window.location.hash = "docs";
        routePage();
    });

    document.getElementById("navLogo").addEventListener("click", (e) => {
        e.preventDefault();
        window.location.hash = "";
        routePage();
    });

    // Back to home button in player overlay
    document.getElementById("playerHomeBtn").addEventListener("click", () => {
        window.location.hash = "";
        routePage();
    });

    // Toggle episodes drawer
    document.getElementById("toggleEpisodesBtn").addEventListener("click", () => {
        document.getElementById("episodePanel").classList.toggle("open");
        resetControlsTimer();
    });

    document.getElementById("closeEpisodesBtn").addEventListener("click", () => {
        document.getElementById("episodePanel").classList.remove("open");
        resetControlsTimer();
    });

    // Toggle Settings panel
    const settingsBtn = document.getElementById("playerSettingsBtn");
    const settingsPanel = document.getElementById("playerSettingsPanel");
    const closeSettingsBtn = document.getElementById("closeSettingsBtn");

    settingsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isVisible = settingsPanel.style.display === "flex";
        settingsPanel.style.display = isVisible ? "none" : "flex";
        resetControlsTimer();
    });

    closeSettingsBtn.addEventListener("click", () => {
        settingsPanel.style.display = "none";
        resetControlsTimer();
    });

    // Show menu controls when floating button is clicked/tapped
    const floatingShowMenuBtn = document.getElementById("floatingShowMenuBtn");
    if (floatingShowMenuBtn) {
        const handleShowMenu = (e) => {
            e.stopPropagation();
            resetControlsTimer();
        };
        floatingShowMenuBtn.addEventListener("click", handleShowMenu);
        floatingShowMenuBtn.addEventListener("touchstart", handleShowMenu);
    }

    // Close settings panel when clicking outside of it
    document.addEventListener("click", (e) => {
        if (settingsPanel.style.display === "flex") {
            if (!e.target.closest("#playerSettingsPanel") && !e.target.closest("#playerSettingsBtn")) {
                settingsPanel.style.display = "none";
                resetControlsTimer();
            }
        }
    });

    // Run router
    routePage();
    
    // Load category carousels on home
    loadAllCategories();
    
    // Setup search features
    setupSearch();
    
    // Setup Developer Playground
    setupPlayground();

    // Setup controls timer on player wrapper
    const playerWrapper = document.getElementById("playerWrapper");
    if (playerWrapper) {
        playerWrapper.addEventListener("mousemove", resetControlsTimer);
        playerWrapper.addEventListener("mousedown", resetControlsTimer);
        playerWrapper.addEventListener("touchstart", resetControlsTimer);
        playerWrapper.addEventListener("click", resetControlsTimer);
        resetControlsTimer();
    }
}

// Router Logic
function routePage() {
    const path = window.location.pathname;
    const hash = window.location.hash;
    const searchParams = new URLSearchParams(window.location.search);

    // Centralized download API routing
    const dlMovieMatch = path.match(/^\/dl\/movie\/(\d+)/) || hash.match(/^#\/dl\/movie\/(\d+)/);
    const dlTvMatch = path.match(/^\/dl\/tv\/(\d+)\/(\d+)\/(\d+)/) || hash.match(/^#\/dl\/tv\/(\d+)\/(\d+)\/(\d+)/);

    if (dlMovieMatch || dlTvMatch) {
        const isMovie = !!dlMovieMatch;
        const id = isMovie ? dlMovieMatch[1] : dlTvMatch[1];
        const s = isMovie ? null : dlTvMatch[2];
        const e = isMovie ? null : dlTvMatch[3];
        
        const site = searchParams.get("site") || getQueryParam("site") || "vidvault";
        let redirectUrl = "";
        
        const siteLow = (site || "vidvault").toLowerCase();
        const matchedServer = DOWNLOAD_SERVERS.find(srv => 
            (srv.domain && srv.domain.toLowerCase().includes(siteLow)) ||
            (srv.name && srv.name.toLowerCase().includes(siteLow)) ||
            (srv.cleanName && srv.cleanName.toLowerCase().includes(siteLow)) ||
            (srv.badge && srv.badge.toLowerCase() === siteLow) ||
            String(srv.id) === siteLow ||
            String(srv.serverIndex) === siteLow
        );

        if (matchedServer) {
            const tpl = isMovie ? matchedServer.movie_url : matchedServer.tv_url;
            if (tpl) {
                redirectUrl = tpl
                    .replace(/\{tmdb_id\}/g, id)
                    .replace(/\{imdb_id\}/g, id)
                    .replace(/\{id\}/g, id)
                    .replace(/\{season\}/g, s || 1)
                    .replace(/\{episode\}/g, e || 1)
                    .replace(/\{s\}/g, s || 1)
                    .replace(/\{e\}/g, e || 1);
            }
        }

        if (!redirectUrl) {
            if (siteLow === "o2movie" || siteLow === "02movie" || siteLow === "02downloader" || siteLow === "2" || siteLow === "d1") {
                redirectUrl = isMovie 
                    ? `https://02moviedownloader.site/api/download/movie/${id}`
                    : `https://02moviedownloader.site/api/download/tv/${id}/${s}/${e}`;
            } else if (siteLow === "nxsha" || siteLow === "3" || siteLow === "d2") {
                redirectUrl = isMovie 
                    ? `https://nxsha.space/dl/movie/${id}`
                    : `https://nxsha.space/dl/tv/${id}/${s}/${e}`;
            } else if (siteLow === "vidsync" || siteLow === "4" || siteLow === "d3") {
                redirectUrl = isMovie 
                    ? `https://vidsync.pro/embed/download/movie/${id}`
                    : `https://vidsync.pro/embed/download/tv/${id}/${s}/${e}`;
            } else {
                redirectUrl = isMovie 
                    ? `https://vidvault.to/movie/${id}`
                    : `https://vidvault.to/tv/${id}/${s}/${e}`;
            }
        }
        
        window.location.replace(redirectUrl);
        return;
    }

    // Hide all views first
    document.getElementById("viewHome").style.display = "none";
    document.getElementById("viewDocs").style.display = "none";
    document.getElementById("viewPlayer").style.display = "none";
    
    // De-activate nav links
    document.getElementById("navHome").classList.remove("active");
    document.getElementById("navDocs").classList.remove("active");

    // Close any open drawers
    document.getElementById("episodePanel").classList.remove("open");
    document.getElementById("episodePanel").style.display = "none";

    // Clear iframe to stop playback when navigating away
    const iframe = document.getElementById("streamIframe");
    if (iframe) iframe.src = "";

    // Toggle body class for fullscreen styling
    document.body.classList.remove("player-active");

    // 1. Path-based routing (Cloudflare Pages SPA rewrite support)
    const movieMatch = path.match(/^\/movie\/(\d+)/);
    const tvMatch = path.match(/^\/tv\/(\d+)\/(\d+)\/(\d+)/);
    
    // 2. Hash-based routing (Client SPA support)
    const hashMovieMatch = hash.match(/^#\/movie\/(\d+)/);
    const hashTvMatch = hash.match(/^#\/tv\/(\d+)\/(\d+)\/(\d+)/);

    // 3. Query-parameter routing (Fallback support)
    const queryMedia = searchParams.get("media");
    const queryId = searchParams.get("id");
    const querySeason = searchParams.get("s");
    const queryEpisode = searchParams.get("e");

    if (movieMatch || hashMovieMatch || (queryMedia === "movie" && queryId)) {
        // MOVIE PLAYER VIEW
        currentMediaType = "movie";
        currentId = movieMatch ? movieMatch[1] : (hashMovieMatch ? hashMovieMatch[1] : queryId);
        document.body.classList.add("player-active");
        document.getElementById("viewPlayer").style.display = "block";
        document.getElementById("toggleEpisodesBtn").style.display = "none";
        initPlayer();
    } else if (tvMatch || hashTvMatch || (queryMedia === "tv" && queryId)) {
        // TV PLAYER VIEW
        currentMediaType = "tv";
        currentId = tvMatch ? tvMatch[1] : (hashTvMatch ? hashTvMatch[1] : queryId);
        currentSeason = parseInt(tvMatch ? tvMatch[2] : (hashTvMatch ? hashTvMatch[2] : (querySeason || 1)));
        currentEpisode = parseInt(tvMatch ? tvMatch[3] : (hashTvMatch ? hashTvMatch[3] : (queryEpisode || 1)));
        document.body.classList.add("player-active");
        document.getElementById("viewPlayer").style.display = "block";
        document.getElementById("episodePanel").style.display = "flex";
        document.getElementById("toggleEpisodesBtn").style.display = "flex";
        initPlayer();
    } else if (hash === "#docs" || path === "/docs") {
        // DOCUMENTATION VIEW
        document.getElementById("viewDocs").style.display = "block";
        document.getElementById("navDocs").classList.add("active");
        setupDocCopy();
    } else {
        // HOME VIEW
        document.getElementById("viewHome").style.display = "block";
        document.getElementById("navHome").classList.add("active");
    }
}

// Get URL query param from path query or hash query
function getQueryParam(name) {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has(name)) {
        return urlParams.get(name);
    }
    const hash = window.location.hash;
    const queryIdx = hash.indexOf('?');
    if (queryIdx !== -1) {
        const hashParams = new URLSearchParams(hash.substring(queryIdx));
        if (hashParams.has(name)) {
            return hashParams.get(name);
        }
    }
    return null;
}

// Fetch Dynamic Details & Setup Player
async function initPlayer() {
    const serverParam = getQueryParam("server");
    const currentList = currentMediaType === "movie" ? MOVIE_SERVERS : TV_SERVERS;

    if (serverParam) {
        const sLower = serverParam.toLowerCase();
        let matchedIdx = -1;
        if (sLower === "hindi" || sLower === "hn" || sLower === "s1") {
            matchedIdx = 0;
        } else {
            // Check direct id match (e.g. server 13 or matching s.id)
            matchedIdx = currentList.findIndex(s => s.id && s.id.toString() === serverParam);
            if (matchedIdx === -1) {
                const parsedIdx = parseInt(serverParam, 10) - 1;
                if (!isNaN(parsedIdx) && parsedIdx >= 0 && parsedIdx < currentList.length) {
                    matchedIdx = parsedIdx;
                }
            }
        }
        activeServerIndex = matchedIdx !== -1 ? matchedIdx : 0;
    } else {
        const isPlayerVisible = document.getElementById("viewPlayer").style.display === "block";
        if (!isPlayerVisible) {
            activeServerIndex = 0;
        }
    }
    
    // Show loaders
    document.getElementById("playerLoader").style.opacity = "1";
    document.getElementById("playerLoader").style.display = "flex";
    document.getElementById("playerPlayOverlay").style.display = "none";
    
    document.getElementById("playerMediaTitle").innerText = "Loading Media...";
    
    try {
        const data = await fetchTMDB(`/${currentMediaType}/${currentId}`);
        currentMediaTitle = data.title || data.name;
        currentImdbId = data.imdb_id || (data.external_ids ? data.external_ids.imdb_id : "");
        
        // If series, fetch external IDs to try and retrieve imdb_id
        if (currentMediaType === "tv" && !currentImdbId) {
            const extIds = await fetchTMDB(`/tv/${currentId}/external_ids`);
            currentImdbId = extIds.imdb_id || "";
        }
        
        // Update Title Display in top deck controls
        const releaseYear = (data.release_date || data.first_air_date || "").substring(0, 4);
        if (currentMediaType === "tv") {
            document.getElementById("playerMediaTitle").innerText = `${currentMediaTitle} (S${currentSeason}:E${currentEpisode})`;
        } else {
            document.getElementById("playerMediaTitle").innerText = `${currentMediaTitle} (${releaseYear})`;
        }
        
        // Dynamically render download buttons inside settings panel and drawer
        renderDownloadButtons();

        // Render servers list
        renderServers();

        updateUrlState(true);

        // If TV show, setup Seasons and Episodes Selector inside drawer
        if (currentMediaType === "tv") {
            await setupTVSelector(data);
        }

        // Show click-to-play overlay
        document.getElementById("overlayTitle").innerText = currentMediaTitle;
        if (currentMediaType === "tv") {
            document.getElementById("overlaySubtitle").innerText = `Season ${currentSeason}, Episode ${currentEpisode} • Click to play`;
        } else {
            document.getElementById("overlaySubtitle").innerText = "Click to play movie in high quality";
        }
        
        document.getElementById("playerLoader").style.display = "none";
        
        // Set backdrop of overlay
        const backdropUrl = data.backdrop_path ? `https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/tmdb-image/t/p/original${data.backdrop_path}` : "";
        const playOverlay = document.getElementById("playerPlayOverlay");
        if (backdropUrl) {
            playOverlay.style.backgroundImage = `url(${backdropUrl})`;
        } else {
            playOverlay.style.backgroundImage = "none";
        }
        if (document.body.classList.contains("is-playground") || document.body.classList.contains("is-embedded")) {
            playOverlay.style.display = "none";
            loadActiveServer();
        } else {
            playOverlay.style.display = "flex";
            // Intercept initial click to block popups
            playOverlay.onclick = () => {
                playOverlay.style.display = "none";
                loadActiveServer();
                resetControlsTimer();
            };
        }

    } catch (err) {
        console.error("Failed to load player details:", err);
        document.getElementById("playerMediaTitle").innerText = "Playback Failed";
        document.getElementById("playerLoader").style.display = "none";
        renderServers();
    }
}

// Generate Server Buttons in Settings Panel
function renderServers() {
    const serverList = document.getElementById("settingsServerList");
    if (!serverList) return;
    serverList.innerHTML = "";
    
    const servers = currentMediaType === "movie" ? MOVIE_SERVERS : TV_SERVERS;
    
    servers.forEach((server, index) => {
        // Skip Hindi server if we don't have imdb ID and media is TV
        if ((server.name === "Server Hindi" || server.name === "Hindi Server") && currentMediaType === "tv" && !currentImdbId) return;
        
        // Settings Panel Server Item
        const itemBtn = document.createElement("div");
        itemBtn.className = `settings-server-item ${index === activeServerIndex ? 'active' : ''}`;
        itemBtn.setAttribute("data-server-idx", index);
        
        let label = "";
        if (server.name.toLowerCase().includes("hindi")) {
            label = "HN";
        } else {
            const numMatch = server.name.match(/\d+/);
            label = numMatch ? "S" + numMatch[0] : "S" + index;
        }
        itemBtn.innerText = label;
        
        itemBtn.addEventListener("click", () => {
            selectServer(index);
            // Close settings panel after selection
            const settingsPanel = document.getElementById("playerSettingsPanel");
            if (settingsPanel) {
                settingsPanel.style.display = "none";
            }
        });
        
        serverList.appendChild(itemBtn);
    });
}

// Synchronize server buttons selection state
function selectServer(index) {
    activeServerIndex = index;
    
    // Sync settings list active states
    const items = document.querySelectorAll(".settings-server-item");
    items.forEach((item) => {
        const idx = parseInt(item.getAttribute("data-server-idx"));
        if (idx === index) item.classList.add("active");
        else item.classList.remove("active");
    });
    
    // Hide play overlay if it was visible
    document.getElementById("playerPlayOverlay").style.display = "none";
    
    // Update URL query parameter
    updateUrlState(true);
    
    loadActiveServer();
}

// Set Active Server Source URL to Iframe
function loadActiveServer() {
    const iframe = document.getElementById("streamIframe");
    const loader = document.getElementById("playerLoader");
    
    // Display loading state inside player
    loader.style.display = "flex";
    loader.style.opacity = "1";
    
    const servers = currentMediaType === "movie" ? MOVIE_SERVERS : TV_SERVERS;
    const server = servers[activeServerIndex] || servers[0];
    
    let playUrl = "";
    if (currentMediaType === "movie") {
        playUrl = server.url(currentId, currentImdbId);
    } else {
        playUrl = server.url(currentId, currentImdbId, currentSeason, currentEpisode);
    }
    
    iframe.src = playUrl;
    
    iframe.onload = () => {
        // Fade out loader smoothly
        setTimeout(() => {
            loader.style.opacity = "0";
            setTimeout(() => { 
                loader.style.display = "none"; 
                resetControlsTimer();
            }, 500);
        }, 300);
    };
}

// Setup seasons & episodes lists for Series
async function setupTVSelector(seriesData) {
    const seasonSelect = document.getElementById("seasonSelect");
    seasonSelect.innerHTML = "";
    
    // Add Seasons
    seriesData.seasons.forEach((season) => {
        // Skip specials if needed, or include them
        if (season.season_number === 0) return;
        
        const opt = document.createElement("option");
        opt.value = season.season_number;
        opt.innerText = season.name;
        if (season.season_number === currentSeason) {
            opt.selected = true;
        }
        seasonSelect.appendChild(opt);
    });

    // Handle season change event
    seasonSelect.onchange = async () => {
        currentSeason = parseInt(seasonSelect.value);
        currentEpisode = 1;
        await loadEpisodesList();
        
        // Update URL to match selected episode
        updateUrlState();
        initPlayer();
    };

    await loadEpisodesList();
}

async function loadEpisodesList() {
    const listContainer = document.getElementById("episodeList");
    listContainer.innerHTML = "<div class='loader-text'>Loading episodes...</div>";
    
    try {
        const data = await fetchTMDB(`/tv/${currentId}/season/${currentSeason}`);
        listContainer.innerHTML = "";
        
        data.episodes.forEach((ep) => {
            const item = document.createElement("div");
            item.className = `episode-item ${ep.episode_number === currentEpisode ? 'active' : ''}`;
            
            const thumb = ep.still_path ? `https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/tmdb-image/t/p/w185${ep.still_path}` : "https://via.placeholder.com/185x104?text=No+Thumb";
            
            item.innerHTML = `
                <img src="${thumb}" class="episode-thumb" alt="EP ${ep.episode_number}">
                <div class="episode-info">
                    <div class="episode-title">${ep.episode_number}. ${ep.name}</div>
                    <div class="episode-meta">EP ${ep.episode_number} • Season ${currentSeason}</div>
                </div>
            `;
            
            item.addEventListener("click", () => {
                document.querySelectorAll(".episode-item").forEach(i => i.classList.remove("active"));
                item.classList.add("active");
                
                currentEpisode = ep.episode_number;
                updateUrlState();
                initPlayer();
                
                // Auto close drawer to show playback immediately
                document.getElementById("episodePanel").classList.remove("open");
            });
            
            listContainer.appendChild(item);
        });
    } catch (err) {
        console.error("Failed to load episodes list:", err);
        listContainer.innerHTML = "<div class='loader-text' style='color: var(--accent-red);'>Failed to load episodes.</div>";
    }
}

// Update URL dynamically without full refresh
function updateUrlState(replace = false) {
    const path = window.location.pathname;
    const hash = window.location.hash;
    
    // Detect if the path itself is /movie/:id or /tv/:id/:s/:e
    const isPathBased = path.startsWith("/movie/") || path.startsWith("/tv/");
    
    let newUrl = "";
    if (isPathBased) {
        if (currentMediaType === "movie") {
            newUrl = `/movie/${currentId}`;
        } else {
            newUrl = `/tv/${currentId}/${currentSeason}/${currentEpisode}`;
        }
    } else {
        // Strip existing queries from hash before reconstruction
        const cleanHash = hash.split('?')[0];
        if (currentMediaType === "movie") {
            newUrl = `#/movie/${currentId}`;
        } else {
            newUrl = `#/tv/${currentId}/${currentSeason}/${currentEpisode}`;
        }
    }
    
    // Append server query parameter (1-based index)
    const serverVal = activeServerIndex + 1;
    newUrl += `?server=${serverVal}`;
    
    if (replace) {
        window.history.replaceState(null, "", newUrl);
    } else {
        window.history.pushState(null, "", newUrl);
    }
}

// General TMDB Fetch Helper
async function fetchTMDB(endpoint, extraParams = "") {
    const url = `${TMDB_BASE_URL}${endpoint}?api_key=${TMDB_API_KEY}&language=en-US${extraParams}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    return await res.json();
}

// Load all categories on home view (stacked carousels)
async function loadAllCategories() {
    const container = document.getElementById("browseSectionsContainer");
    if (!container) return;
    container.innerHTML = "";

    const categories = [
        { 
            id: "trending", 
            name: "Trending Now", 
            icon: "flame-outline", 
            fetch: async () => {
                const movies = await fetchTMDB("/trending/movie/week");
                const shows = await fetchTMDB("/trending/tv/week");
                const results = [...movies.results.slice(0, 10), ...shows.results.slice(0, 10)];
                results.sort((a, b) => b.popularity - a.popularity);
                return results;
            } 
        },
        { id: "bollywood", name: "Bollywood Hits", icon: "film-outline", fetch: () => fetchTMDB("/discover/movie", "&sort_by=popularity.desc&with_original_language=hi").then(d => d.results) },
        { id: "hollywood", name: "Hollywood Blockbusters", icon: "film-outline", fetch: () => fetchTMDB("/discover/movie", "&sort_by=popularity.desc&with_original_language=en").then(d => d.results) },
        { id: "south", name: "South Indian Cinema", icon: "film-outline", fetch: () => fetchTMDB("/discover/movie", "&sort_by=popularity.desc&with_original_language=te|ta|ml|kn").then(d => d.results) },
        { id: "action", name: "Action & Adventure", icon: "sparkles-outline", fetch: () => fetchTMDB("/discover/movie", "&sort_by=popularity.desc&with_genres=28").then(d => d.results) },
        { id: "comedy", name: "Comedy Stars", icon: "happy-outline", fetch: () => fetchTMDB("/discover/movie", "&sort_by=popularity.desc&with_genres=35").then(d => d.results) },
        { id: "scifi", name: "Sci-Fi & Fantasy", icon: "rocket-outline", fetch: () => fetchTMDB("/discover/movie", "&sort_by=popularity.desc&with_genres=878").then(d => d.results) }
    ];

    for (const cat of categories) {
        // Create Section layout
        const section = document.createElement("div");
        section.className = "browse-section";
        section.innerHTML = `
            <h2 class="section-title" style="margin-bottom: 16px;">
                <ion-icon name="${cat.icon}" style="color: var(--accent-cyan); margin-right: 10px;"></ion-icon>
                ${cat.name}
            </h2>
            <div class="grid-layout" id="${cat.id}Grid">
                <div class="loader-text">Loading items...</div>
            </div>
        `;
        container.appendChild(section);

        // Fetch data for this specific category asynchronously
        cat.fetch().then(items => {
            renderCategoryGrid(cat.id, items);
        }).catch(err => {
            console.error(`Failed to load ${cat.name}:`, err);
            const grid = document.getElementById(`${cat.id}Grid`);
            if (grid) grid.innerHTML = "<div class='loader-text' style='color: var(--accent-red);'>Failed to load media.</div>";
        });
    }
}

// Render dynamic elements inside specific category grid
function renderCategoryGrid(catId, items) {
    const grid = document.getElementById(`${catId}Grid`);
    if (!grid) return;
    grid.innerHTML = "";

    if (!items || items.length === 0) {
        grid.innerHTML = "<div class='loader-text'>No items found.</div>";
        return;
    }

    items.forEach((item) => {
        const card = document.createElement("div");
        card.className = "media-card";
        
        const mediaType = item.media_type || "movie";
        const isMovie = mediaType === "movie";
        const title = item.title || item.name;
        const year = (item.release_date || item.first_air_date || "").substring(0, 4) || "N/A";
        const poster = item.poster_path ? `https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/tmdb-image/t/p/w342${item.poster_path}` : "https://via.placeholder.com/342x513?text=No+Poster";
        const rating = item.vote_average ? item.vote_average.toFixed(1) : "0.0";
        
        card.innerHTML = `
            <div class="card-poster-wrapper">
                <img src="${poster}" class="card-poster" alt="${title}" loading="lazy">
                <div class="card-overlay">
                    <div class="card-play-btn">
                        <ion-icon name="play-sharp"></ion-icon>
                    </div>
                </div>
                <div class="card-badge rating">
                    <ion-icon name="star"></ion-icon> ${rating}
                </div>
            </div>
            <div class="card-info">
                <div class="card-title">${title}</div>
                <div class="card-meta">
                    <span>${year}</span>
                    <span class="result-type ${mediaType}">${mediaType}</span>
                </div>
            </div>
        `;
        
        card.addEventListener("click", () => {
            if (mediaType === "movie") {
                window.location.hash = `#/movie/${item.id}`;
            } else {
                window.location.hash = `#/tv/${item.id}/1/1`;
            }
        });
        
        grid.appendChild(card);
    });
}

// Search Suggestions Autocomplete logic
function setupSearch() {
    const input = document.getElementById("searchInput");
    const dropdown = document.getElementById("searchResultsDropdown");
    const clearBtn = document.getElementById("searchClearBtn");
    
    let debounceTimer;
    
    input.addEventListener("input", () => {
        const query = input.value.trim();
        
        if (query) {
            clearBtn.style.display = "flex";
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                try {
                    const data = await fetchTMDB(`/search/multi`, `&query=${encodeURIComponent(query)}`);
                    renderSearchResults(data.results);
                } catch (err) {
                    console.error("Search failed:", err);
                }
            }, 300);
        } else {
            clearBtn.style.display = "none";
            dropdown.style.display = "none";
        }
    });
    
    clearBtn.addEventListener("click", () => {
        input.value = "";
        clearBtn.style.display = "none";
        dropdown.style.display = "none";
        input.focus();
    });

    // Close suggestions dropdown when clicking outside
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".search-box-container")) {
            dropdown.style.display = "none";
        }
    });
}

function renderSearchResults(results) {
    const dropdown = document.getElementById("searchResultsDropdown");
    dropdown.innerHTML = "";
    
    // Filter results to only movies and tv shows
    const filtered = results.filter(item => item.media_type === "movie" || item.media_type === "tv");
    
    if (filtered.length === 0) {
        dropdown.innerHTML = "<div style='padding: 15px; text-align: center; color: var(--text-muted); font-size: 14px;'>No movies or TV shows found.</div>";
        dropdown.style.display = "block";
        return;
    }
    
    filtered.slice(0, 7).forEach((item) => {
        const el = document.createElement("div");
        el.className = "search-result-item";
        
        const isMovie = item.media_type === "movie";
        const title = item.title || item.name;
        const year = (item.release_date || item.first_air_date || "").substring(0, 4) || "N/A";
        const poster = item.poster_path ? `https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/tmdb-image/t/p/w92${item.poster_path}` : "https://via.placeholder.com/92x138?text=No+Poster";
        
        el.innerHTML = `
            <img src="${poster}" class="result-poster" alt="${title}">
            <div class="result-info">
                <div class="result-title">${title}</div>
                <div class="result-meta">
                    <span>${year}</span>
                    <span class="result-type ${item.media_type}">${item.media_type}</span>
                </div>
            </div>
        `;
        
        el.addEventListener("click", () => {
            dropdown.style.display = "none";
            document.getElementById("searchInput").value = "";
            document.getElementById("searchClearBtn").style.display = "none";
            
            if (item.media_type === "movie") {
                window.location.hash = `#/movie/${item.id}`;
            } else {
                window.location.hash = `#/tv/${item.id}/1/1`;
            }
        });
        
        dropdown.appendChild(el);
    });
    
    dropdown.style.display = "block";
}

// Playground State variables
let pgMediaType = "movie";
let pgId = "299534";
let pgSeason = 1;
let pgEpisode = 1;
let pgActiveServerIndex = 0;
let pgImdbId = "";
let pgMediaTitle = "";

function getActiveCodeTab() {
    const activeTab = document.querySelector(".code-tabs .code-tab-btn.active");
    return activeTab ? activeTab.getAttribute("data-tab") : "html";
}

// Load media metadata into playground preview and update input fields
async function loadMediaIntoPlayground(mediaType, id, season = 1, episode = 1) {
    pgMediaType = mediaType;
    pgId = id.toString();
    pgSeason = parseInt(season) || 1;
    pgEpisode = parseInt(episode) || 1;
    pgActiveServerIndex = 0; // Reset active server for playground
    
    // Update playground input values
    const typeSelect = document.getElementById("pgMediaType");
    const idInput = document.getElementById("pgTmdbId");
    const seasonInput = document.getElementById("pgSeason");
    const episodeInput = document.getElementById("pgEpisode");
    
    if (typeSelect) typeSelect.value = mediaType;
    if (idInput) idInput.value = id;
    if (seasonInput) seasonInput.value = pgSeason;
    if (episodeInput) episodeInput.value = pgEpisode;
    
    // Toggle season/episode display
    const isTV = mediaType === "tv";
    const tvInputs = document.getElementById("pgTvInputs");
    if (tvInputs) tvInputs.style.display = isTV ? "flex" : "none";
    
    // Reset player state to placeholder card
    const iframe = document.getElementById("pgStreamIframe");
    const placeholder = document.getElementById("pgPlayerPlaceholder");
    if (iframe) {
        iframe.style.display = "none";
        iframe.src = "";
    }
    if (placeholder) {
        placeholder.style.display = "block";
        placeholder.style.backgroundImage = "none";
    }
    
    const pgTitle = document.getElementById("pgPlaceholderTitle");
    const pgSub = document.getElementById("pgPlaceholderSubtitle");
    if (pgTitle) pgTitle.innerText = "Loading Media Details...";
    if (pgSub) pgSub.innerText = "";
    


    try {
        const data = await fetchTMDB(`/${mediaType}/${id}`);
        pgMediaTitle = data.title || data.name;
        pgImdbId = data.imdb_id || (data.external_ids ? data.external_ids.imdb_id : "");
        
        if (mediaType === "tv" && !pgImdbId) {
            try {
                const extIds = await fetchTMDB(`/tv/${id}/external_ids`);
                pgImdbId = extIds.imdb_id || "";
            } catch (e) {
                console.error("Failed to load TV imdb id for playground:", e);
            }
        }
        
        const releaseYear = (data.release_date || data.first_air_date || "").substring(0, 4);
        let displayName = pgMediaTitle;
        if (releaseYear) displayName += ` (${releaseYear})`;
        
        if (pgTitle) pgTitle.innerText = displayName;
        if (pgSub) pgSub.innerText = "Click to play live stream preview";
        
        const backdropUrl = data.backdrop_path ? `https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/tmdb-image/t/p/w780${data.backdrop_path}` : "";
        if (placeholder && backdropUrl) {
            placeholder.style.backgroundImage = `url(${backdropUrl})`;
        }
        
        // Render playground servers
        renderPlaygroundServers();
        
        // Update code snippets
        updatePlaygroundCode(pgMediaType, pgId, pgSeason, pgEpisode, getActiveCodeTab());
        
    } catch (err) {
        console.error("Failed to fetch playground media info:", err);
        if (pgTitle) pgTitle.innerText = "Custom Stream Ready";
        if (pgSub) pgSub.innerText = "Click to play live stream preview";
        
        renderPlaygroundServers();
        updatePlaygroundCode(pgMediaType, pgId, pgSeason, pgEpisode, getActiveCodeTab());
    }
}

// Render available generic servers inside playground selector pills
function renderPlaygroundServers() {
    const container = document.getElementById("pgServerPills");
    if (!container) return;
    container.innerHTML = "";
    
    const servers = pgMediaType === "movie" ? MOVIE_SERVERS : TV_SERVERS;
    
    servers.forEach((server, index) => {
        // Skip Hindi Server if we do not have IMDB ID on TV show
        if (server.name === "Server Hindi" && pgMediaType === "tv" && !pgImdbId) return;
        
        const pill = document.createElement("button");
        pill.className = `pg-server-pill ${index === pgActiveServerIndex ? 'active' : ''}`;
        pill.innerText = `${server.name} (${server.badge})`;
        
        pill.addEventListener("click", () => {
            pgActiveServerIndex = index;
            document.querySelectorAll(".pg-server-pill").forEach((btn, idx) => {
                btn.classList.toggle("active", idx === index);
            });
            
            // Update code snippet output
            updatePlaygroundCode(pgMediaType, pgId, pgSeason, pgEpisode, getActiveCodeTab());
            
            // If iframe is currently active, reload it with the selected server stream instantly
            const iframe = document.getElementById("pgStreamIframe");
            if (iframe && iframe.style.display !== "none") {
                playPlaygroundMedia();
            }
        });
        
        container.appendChild(pill);
    });
}

// Play media in the inline playground player iframe
// Play media in the inline playground player iframe using our custom player routing
function playPlaygroundMedia() {
    const iframe = document.getElementById("pgStreamIframe");
    const placeholder = document.getElementById("pgPlayerPlaceholder");
    if (!iframe) return;
    
    const originUrl = window.location.href.split('#')[0].split('?')[0];
    const serverParam = pgActiveServerIndex + 1;
    
    let playUrl = "";
    if (pgMediaType === "movie") {
        playUrl = `${originUrl}#/movie/${pgId}?server=${serverParam}`;
    } else {
        playUrl = `${originUrl}#/tv/${pgId}/${pgSeason}/${pgEpisode}?server=${serverParam}`;
    }
    
    if (placeholder) placeholder.style.display = "none";
    iframe.style.display = "block";
    iframe.src = playUrl;
}

// Developer Embed Generator Playground
function setupPlayground() {
    const typeSelect = document.getElementById("pgMediaType");
    const idInput = document.getElementById("pgTmdbId");
    const seasonInput = document.getElementById("pgSeason");
    const episodeInput = document.getElementById("pgEpisode");
    
    // Initial Load default media details into playground
    loadMediaIntoPlayground("movie", "299534");
    
    // Input change handler
    let pgDebounceTimer;
    const onInputChange = () => {
        pgMediaType = typeSelect.value;
        pgId = idInput.value.trim();
        pgSeason = parseInt(seasonInput.value) || 1;
        pgEpisode = parseInt(episodeInput.value) || 1;
        
        // Toggle season/episode display
        const isTV = pgMediaType === "tv";
        const tvInputs = document.getElementById("pgTvInputs");
        if (tvInputs) tvInputs.style.display = isTV ? "flex" : "none";
        
        // Update code and servers list
        updatePlaygroundCode(pgMediaType, pgId, pgSeason, pgEpisode, getActiveCodeTab());
        renderPlaygroundServers();
        
        // Reset player iframe
        const iframe = document.getElementById("pgStreamIframe");
        const placeholder = document.getElementById("pgPlayerPlaceholder");
        if (iframe) {
            iframe.style.display = "none";
            iframe.src = "";
        }
        if (placeholder) {
            placeholder.style.display = "block";
            placeholder.style.backgroundImage = "none";
        }
        
        const pgTitle = document.getElementById("pgPlaceholderTitle");
        const pgSub = document.getElementById("pgPlaceholderSubtitle");
        if (pgTitle) pgTitle.innerText = "Loading Media Details...";
        if (pgSub) pgSub.innerText = "";
        
        clearTimeout(pgDebounceTimer);
        pgDebounceTimer = setTimeout(async () => {
            if (!pgId) return;
            try {
                const data = await fetchTMDB(`/${pgMediaType}/${pgId}`);
                pgMediaTitle = data.title || data.name;
                pgImdbId = data.imdb_id || (data.external_ids ? data.external_ids.imdb_id : "");
                
                if (pgMediaType === "tv" && !pgImdbId) {
                    try {
                        const extIds = await fetchTMDB(`/tv/${pgId}/external_ids`);
                        pgImdbId = extIds.imdb_id || "";
                    } catch (e) {}
                }
                
                const releaseYear = (data.release_date || data.first_air_date || "").substring(0, 4);
                let displayName = pgMediaTitle;
                if (releaseYear) displayName += ` (${releaseYear})`;
                if (pgTitle) pgTitle.innerText = displayName;
                if (pgSub) pgSub.innerText = "Click to play live stream preview";
                
                const backdropUrl = data.backdrop_path ? `https://ollyflix-cloudflare-proxy.rameshkumarsahutmr.workers.dev/tmdb-image/t/p/w780${data.backdrop_path}` : "";
                if (placeholder && backdropUrl) {
                    placeholder.style.backgroundImage = `url(${backdropUrl})`;
                }
                
                // Re-render servers list in case IMDB status changed for TV Hindi server
                renderPlaygroundServers();
            } catch (err) {
                if (pgTitle) pgTitle.innerText = "Custom Stream Ready";
                if (pgSub) pgSub.innerText = "Click to play live stream preview";
            }
        }, 500);
    };
    
    if (typeSelect) {
        typeSelect.addEventListener("change", () => {
            const isTV = typeSelect.value === "tv";
            if (idInput) idInput.value = isTV ? "1399" : "299534";
            if (seasonInput) seasonInput.value = "1";
            if (episodeInput) episodeInput.value = "1";
            onInputChange();
        });
    }
    
    if (idInput) idInput.addEventListener("input", onInputChange);
    if (seasonInput) seasonInput.addEventListener("input", onInputChange);
    if (episodeInput) episodeInput.addEventListener("input", onInputChange);
    
    // Code tabs click binding
    const tabs = document.querySelectorAll("[data-tab]");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            const currentTab = tab.getAttribute("data-tab");
            updatePlaygroundCode(pgMediaType, pgId, pgSeason, pgEpisode, currentTab);
        });
    });

    // Play Buttons
    const pgPlayBtn = document.getElementById("pgPlayBtn");
    const pgBigPlayBtn = document.getElementById("pgBigPlayBtn");
    
    if (pgPlayBtn) pgPlayBtn.addEventListener("click", playPlaygroundMedia);
    if (pgBigPlayBtn) pgBigPlayBtn.addEventListener("click", playPlaygroundMedia);

    // Download Demo Button
    const pgDownloadBtn = document.getElementById("pgDownloadBtn");
    if (pgDownloadBtn) {
        pgDownloadBtn.addEventListener("click", () => {
            downloadPlaygroundMedia();
        });
    }
    
    // Fullscreen button
    const fullscreenBtn = document.getElementById("pgFullscreenBtn");
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener("click", () => {
            if (!pgId) return;
            if (pgMediaType === "movie") {
                window.location.hash = `#/movie/${pgId}?server=${pgActiveServerIndex + 1}`;
            } else {
                window.location.hash = `#/tv/${pgId}/${pgSeason}/${pgEpisode}?server=${pgActiveServerIndex + 1}`;
            }
        });
    }

    // Copy to Clipboard feature inside playground
    const copyBtn = document.getElementById("copyCodeBtn");
    if (copyBtn) {
        copyBtn.addEventListener("click", () => {
            const display = document.getElementById("codeDisplay");
            const text = display ? display.textContent : "";
            navigator.clipboard.writeText(text).then(() => {
                const oldIcon = copyBtn.innerHTML;
                copyBtn.innerHTML = "<ion-icon name='checkmark-outline' style='color: #4ade80'></ion-icon>";
                setTimeout(() => { copyBtn.innerHTML = oldIcon; }, 2000);
            });
        });
    }

    // Toggle Embed Code block visibility
    const toggleCodeBtn = document.getElementById("pgToggleCodeBtn");
    const codeBlock = document.getElementById("pgCodeBlock");
    if (toggleCodeBtn && codeBlock) {
        toggleCodeBtn.addEventListener("click", () => {
            const isHidden = codeBlock.style.display === "none" || codeBlock.style.display === "";
            codeBlock.style.display = isHidden ? "block" : "none";
            toggleCodeBtn.innerHTML = isHidden 
                ? "<ion-icon name='code-working-outline'></ion-icon> Hide Embed Code"
                : "<ion-icon name='code-working-outline'></ion-icon> Show Embed Code";
        });
    }
}

function updatePlaygroundCode(type, id, season, episode, tab) {
    const codeDisplay = document.getElementById("codeDisplay");
    if (!codeDisplay) return;
    const domain = window.location.origin;
    
    const serverParam = pgActiveServerIndex + 1;
    const embedUrl = type === "movie" 
        ? `${domain}/movie/${id}?server=${serverParam}`
        : `${domain}/tv/${id}/${season}/${episode}?server=${serverParam}`;

    const activeDl = (DOWNLOAD_SERVERS && DOWNLOAD_SERVERS[pgActiveDownloadServerIndex]) ? DOWNLOAD_SERVERS[pgActiveDownloadServerIndex] : (DOWNLOAD_SERVERS ? DOWNLOAD_SERVERS[0] : null);
    const dlServerParam = activeDl ? (activeDl.cleanName || activeDl.id).toString().toLowerCase() : "1";
    const downloadUrl = type === "movie"
        ? `${domain}/dl/movie/${id}?server=${dlServerParam}`
        : `${domain}/dl/tv/${id}/${season}/${episode}?server=${dlServerParam}`;
        
    let snippet = "";
    if (tab === "html") {
        snippet = `<iframe src="${embedUrl}" width="100%" height="500" allowfullscreen frameborder="0"></iframe>`;
    } else if (tab === "react") {
        snippet = `import React from 'react';\n\nexport const MoviePlayer = () => {\n  return (\n    <iframe \n      src="${embedUrl}" \n      width="100%" \n      height="500" \n      allowFullScreen \n      frameBorder="0"\n    />\n  );\n};`;
    } else if (tab === "vue") {
        snippet = `<template>\n  <iframe :src="embedUrl" width="100%" height="500" allowfullscreen frameborder="0"></iframe>\n</template>\n\n<script>\nexport default {\n  data() {\n    return {\n      embedUrl: "${embedUrl}"\n    };\n  }\n};\n</script>`;
    } else if (tab === "download") {
        snippet = `<!-- High-Speed Direct Download Link -->\n<a href="${downloadUrl}" target="_blank" rel="noopener noreferrer" class="download-btn">\n  📥 Download ${type === 'movie' ? 'Movie' : 'Episode'} (${activeDl ? (activeDl.cleanName || activeDl.name) : 'Download Server'})\n</a>\n\n// Direct Download API Endpoint (Auto-Redirects to High-Speed Stream):\n// GET ${downloadUrl}`;
    }
    
    codeDisplay.textContent = snippet;
}

// Setup Copy Buttons inside main Developer Docs
function setupDocCopy() {
    const copyBtn = document.getElementById("copyDocCodeBtn");
    const display = document.getElementById("docCodeDisplay");
    
    if (copyBtn) {
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(display.textContent).then(() => {
                const oldIcon = copyBtn.innerHTML;
                copyBtn.innerHTML = "<ion-icon name='checkmark-outline' style='color: #4ade80'></ion-icon>";
                setTimeout(() => { copyBtn.innerHTML = oldIcon; }, 2000);
            });
        };
    }

    // Handle code tab buttons in docs section
    const tabs = document.querySelectorAll("[data-doc-tab]");
    tabs.forEach(tab => {
        tab.onclick = () => {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            
            const tabName = tab.getAttribute("data-doc-tab");
            const domain = window.location.origin;
            
            if (tabName === "html") {
                display.textContent = `<!-- Embed Movie -->\n<iframe src="${domain}/movie/299534" \n        width="100%" \n        height="500" \n        allowfullscreen \n        frameborder="0">\n</iframe>`;
            } else {
                display.textContent = `// Dynamic route loader script\nfunction loadEmbed(mediaType, id, s = 1, e = 1) {\n    const domain = "${domain}";\n    const url = mediaType === "movie" \n        ? \`\${domain}/movie/\${id}\` \n        : \`\${domain}/tv/\${id}/\${s}/\${e}\`;\n    \n    document.getElementById("myIframe").src = url;\n}`;
            }
        };
    });
}

// Global controls hide timer state
let controlsTimeout;
function resetControlsTimer() {
    const playerWrapper = document.getElementById("playerWrapper");
    if (!playerWrapper) return;
    
    playerWrapper.classList.remove("hide-controls");
    clearTimeout(controlsTimeout);
    
    controlsTimeout = setTimeout(() => {
        const isLandscape = window.matchMedia("(orientation: landscape)").matches;
        const iframe = document.getElementById("streamIframe");
        const settingsPanel = document.getElementById("playerSettingsPanel");
        const episodePanel = document.getElementById("episodePanel");
        
        const isSettingsOpen = settingsPanel && settingsPanel.style.display === "flex";
        const isEpisodesOpen = episodePanel && episodePanel.classList.contains("open");
        
        // Only hide controls in landscape orientation when playing and no drawers/settings are open
        if (isLandscape && iframe && iframe.src !== "" && !isSettingsOpen && !isEpisodesOpen) {
            playerWrapper.classList.add("hide-controls");
        }
    }, 3000);
}
