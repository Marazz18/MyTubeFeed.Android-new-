/* MyTube Feed – sdílené utility + Android/Web kompatibilní vrstva (polyfill pro chrome.*) */
(function initEnvPolyfill() {
  const isExt = typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local && !!chrome.runtime?.id;
  window.IS_EXTENSION = isExt;
  window.IS_ANDROID_APP = typeof window.AndroidBridge !== 'undefined' || /Android/i.test(navigator.userAgent) && !isExt;

  if (isExt) return;

  // Polyfill pro chrome.storage.local nad localStorage
  const PREFIX = 'pt_store_';
  const listeners = new Set();

  function readKey(k) {
    try {
      const raw = localStorage.getItem(PREFIX + k);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }

  function writeKey(k, val) {
    try {
      if (val === undefined) localStorage.removeItem(PREFIX + k);
      else localStorage.setItem(PREFIX + k, JSON.stringify(val));
    } catch (e) {
      console.error('Chyba zápisu do localStorage:', e);
    }
  }

  const storageLocal = {
    async get(keys) {
      const out = {};
      if (typeof keys === 'string') {
        const v = readKey(keys);
        if (v !== undefined) out[keys] = v;
      } else if (Array.isArray(keys)) {
        for (const k of keys) {
          const v = readKey(k);
          if (v !== undefined) out[k] = v;
        }
      } else if (keys && typeof keys === 'object') {
        for (const [k, def] of Object.entries(keys)) {
          const v = readKey(k);
          out[k] = v !== undefined ? v : def;
        }
      }
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, newVal] of Object.entries(obj)) {
        const oldVal = readKey(k);
        writeKey(k, newVal);
        changes[k] = { oldValue: oldVal, newValue: newVal };
      }
      if (Object.keys(changes).length) {
        setTimeout(() => {
          listeners.forEach(fn => {
            try { fn(changes, 'local'); } catch (e) { console.error(e); }
          });
        }, 0);
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const k of list) {
        const oldVal = readKey(k);
        localStorage.removeItem(PREFIX + k);
        if (oldVal !== undefined) changes[k] = { oldValue: oldVal };
      }
      if (Object.keys(changes).length) {
        setTimeout(() => {
          listeners.forEach(fn => {
            try { fn(changes, 'local'); } catch (e) { console.error(e); }
          });
        }, 0);
      }
    }
  };

  // Polyfill pro chrome.alarms
  const alarms = new Map();
  const alarmListeners = new Set();
  const alarmsApi = {
    create(name, info = {}) {
      this.clear(name);
      const fire = () => {
        alarmListeners.forEach(fn => {
          try { fn({ name }); } catch (e) { console.error(e); }
        });
      };
      if (info.periodInMinutes) {
        const ms = Math.max(10000, info.periodInMinutes * 60000);
        const timer = setInterval(fire, ms);
        alarms.set(name, { name, type: 'interval', timer });
      } else if (info.delayInMinutes !== undefined) {
        const ms = Math.max(1000, info.delayInMinutes * 60000);
        const timer = setTimeout(() => { alarms.delete(name); fire(); }, ms);
        alarms.set(name, { name, type: 'timeout', timer });
      }
    },
    async get(name, cb) {
      const a = alarms.get(name) || null;
      if (typeof cb === 'function') cb(a);
      return a;
    },
    async clear(name) {
      const a = alarms.get(name);
      if (a) {
        if (a.type === 'interval') clearInterval(a.timer);
        else clearTimeout(a.timer);
        alarms.delete(name);
      }
    },
    onAlarm: {
      addListener(fn) { alarmListeners.add(fn); }
    }
  };

  // Polyfill pro chrome.runtime (volá přímo PTSync v standalone/Android režimu)
  const runtimeApi = {
    id: 'mytube-android-standalone',
    getURL: path => path,
    getManifest: () => ({ version: '0.9.4' }),
    onInstalled: { addListener() {} },
    onStartup: { addListener(fn) { window.addEventListener('load', fn); } },
    onMessage: { addListener() {} },
    async sendMessage(msg) {
      if (!msg || typeof msg.type !== 'string') return {};
      if (msg.type.startsWith('sync-') && typeof PTSync !== 'undefined') {
        if (msg.type === 'sync-status') return await PTSync.status();
        if (msg.type === 'sync-setup') { await PTSync.configure(msg); await PTSync.syncNow(); return await PTSync.status(); }
        if (msg.type === 'sync-now') { await PTSync.syncNow(!!msg.soft); return await PTSync.status(); }
        if (msg.type === 'sync-reveal') return { nsec: await PTSync.revealSecret() };
        if (msg.type === 'sync-disable') { await PTSync.disable(); return await PTSync.status(); }
      }
      return {};
    }
  };

  window.chrome = window.chrome || {};
  window.chrome.storage = {
    local: storageLocal,
    onChanged: {
      addListener(fn) { listeners.add(fn); }
    }
  };
  window.chrome.alarms = alarmsApi;
  window.chrome.runtime = runtimeApi;

  // Napojení automatické Nostr synchronizace v Android/Web režimu
  window.addEventListener('DOMContentLoaded', () => {
    if (typeof PTSync === 'undefined') return;
    chrome.alarms.create('pt-sync-pull', { periodInMinutes: 5 });
    chrome.alarms.onAlarm.addListener(a => {
      if (a.name === 'pt-sync-pull' || a.name === 'pt-sync-push') PTSync.syncNow();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && (ch.db || ch.wl || ch.watched || ch.settings)) PTSync.onLocalChange();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') PTSync.syncNow(true);
    });
  });
})();

var PT = {
  NEW_DAYS: 14,      // video je "nové", pokud je mladší než tolik dní a nezhlédnuté
  SEEN_SECONDS: 5,   // kolik sekund přehrávání stačí k označení jako zhlédnuté

  // Předdefinované prohlížeče a přehrávače pro Android
  KNOWN_BROWSERS: [
    { id: 'chooser', label: 'Systémový výběr (vždy se zeptat)', hint: 'Zobrazí nabídku všech nainstalovaných prohlížečů' },
    { id: 'com.brave.browser', label: 'Brave Browser', hint: 'Blokování reklam + přehrávání na pozadí' },
    { id: 'org.mozilla.firefox', label: 'Mozilla Firefox', hint: 'Podpora uBlock Origin a doplňků' },
    { id: 'org.mozilla.fennec_fdroid', label: 'Fennec F-Droid', hint: 'Open-source Firefox z F-Droidu' },
    { id: 'us.spotco.fennec_dos', label: 'Mull / IronFox', hint: 'Hardened Firefox fork' },
    { id: 'org.cromite.cromite', label: 'Cromite', hint: 'Odlehčený Chromium s adblockem' },
    { id: 'com.vivaldi.browser', label: 'Vivaldi', hint: 'Vivaldi Browser' },
    { id: 'com.kiwibrowser.browser', label: 'Kiwi Browser', hint: 'Podpora Chrome rozšíření' },
    { id: 'com.duckduckgo.mobile.android', label: 'DuckDuckGo Browser', hint: 'DuckDuckGo Privacy Browser' },
    { id: 'org.torproject.torbrowser', label: 'Tor Browser', hint: 'Maximální soukromí' },
    { id: 'com.android.chrome', label: 'Google Chrome', hint: 'Standardní Chrome' },
    { id: 'org.schabi.newpipe', label: 'NewPipe', hint: 'Alternativní YouTube klient' },
    { id: 'InfinityLoop1309.NewPipeEnhanced', label: 'PipePipe', hint: 'NewPipe fork se SponsorBlockem' },
    { id: 'com.futo.platformplayer', label: 'Grayjay', hint: 'FUTO multimediální přehrávač' },
    { id: 'com.github.libretube', label: 'LibreTube', hint: 'Piped klient pro Android' },
    { id: 'default', label: 'Výchozí otevírání (standardní odkaz)', hint: 'Běžné chování prohlížeče / systému' }
  ],

  async getAll() {
    const d = await chrome.storage.local.get(['db', 'cache', 'watched', 'wl', 'settings']);
    const s = {
      db: d.db || { folders: {}, channels: {} },
      cache: d.cache || {},
      watched: d.watched || {},
      wl: d.wl || [],
      settings: d.settings || {}
    };
    s.db.folders = s.db.folders || {};
    s.db.channels = s.db.channels || {};
    s.settings.open = s.settings.open || [];
    if (!s.settings.targetBrowser) {
      s.settings.targetBrowser = window.IS_ANDROID_APP ? 'chooser' : 'default';
    }
    if (s.settings.markSeenOnExternal === undefined) {
      s.settings.markSeenOnExternal = !!window.IS_ANDROID_APP;
    }
    return s;
  },

  isSeen(watched, id) {
    const r = watched[id];
    return !!r && (r.t || 0) >= PT.SEEN_SECONDS;
  },

  isNew(item, watched) {
    return !PT.isSeen(watched, item.id) &&
      Date.now() - new Date(item.published).getTime() < PT.NEW_DAYS * 86400000;
  },

  videoIdFromUrl(u) {
    const ok = x => (/^[\w-]{11}$/.test(x || '') ? x : null);
    if (ok(u)) return u;
    try {
      let url = new URL(u);
      if (/(^|\.)facebook\.com$/.test(url.hostname) && url.pathname.startsWith('/l.php')) {
        url = new URL(url.searchParams.get('u'));
      }
      if (url.hostname === 'youtu.be') return ok(url.pathname.slice(1, 12));
      if (/(^|\.)youtube\.com$/.test(url.hostname)) {
        if (url.pathname === '/watch') return ok(url.searchParams.get('v'));
        const m = url.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
        if (m) return ok(m[2]);
      }
    } catch (e) { /* neplatná URL */ }
    return null;
  },

  // Vrátí seznam detekovaných prohlížečů z nativního AndroidBridge + známé předvolby
  getBrowserChoices() {
    let detected = [];
    if (window.AndroidBridge && typeof window.AndroidBridge.getInstalledBrowsers === 'function') {
      try {
        detected = JSON.parse(window.AndroidBridge.getInstalledBrowsers() || '[]');
      } catch (e) {
        console.warn('Nelze načíst seznam prohlížečů z AndroidBridge:', e);
      }
    }
    const map = new Map();
    map.set('chooser', { id: 'chooser', label: '📲 Vždy se zeptat (výběr nainstalovaných prohlížečů)', installed: true });
    for (const b of detected) {
      if (b.packageName && !map.has(b.packageName)) {
        map.set(b.packageName, {
          id: b.packageName,
          label: `✅ ${b.label} (${b.packageName})`,
          installed: true
        });
      }
    }
    for (const k of PT.KNOWN_BROWSERS) {
      if (!map.has(k.id)) {
        map.set(k.id, {
          id: k.id,
          label: k.label + (k.id !== 'default' && k.id !== 'chooser' ? ` (${k.id})` : ''),
          hint: k.hint,
          installed: false
        });
      }
    }
    return [...map.values()];
  },

  // Otevře URL ve zvoleném prohlížeči (Brave, Firefox, NewPipe, systémový chooser...)
  openExternalUrl(url, settings = {}, embed = false) {
    const pkg = settings.targetBrowser || 'default';

    // 1. Nativní Android APK Bridge (nejspolehlivější – obejde YouTube App Links)
    if (window.AndroidBridge && typeof window.AndroidBridge.openUrl === 'function' && pkg !== 'default') {
      try {
        const ok = window.AndroidBridge.openUrl(url, pkg);
        if (ok !== false) return true;
      } catch (e) {
        console.warn('AndroidBridge.openUrl selhal, zkouším intent:// fallback:', e);
      }
    }

    // 2. Android intent:// URI fallback (pokud běží v mobilním prohlížeči bez nativního bridge)
    if (/Android/i.test(navigator.userAgent) && pkg && pkg !== 'default') {
      try {
        const parsed = new URL(url);
        const cleanUrl = parsed.host + parsed.pathname + parsed.search + parsed.hash;
        if (pkg === 'chooser') {
          location.href = `intent://${cleanUrl}#Intent;scheme=${parsed.protocol.replace(':', '')};action=android.intent.action.VIEW;end`;
          return true;
        } else {
          const fallback = encodeURIComponent(url);
          location.href = `intent://${cleanUrl}#Intent;scheme=${parsed.protocol.replace(':', '')};action=android.intent.action.VIEW;package=${encodeURIComponent(pkg)};S.browser_fallback_url=${fallback};end`;
          return true;
        }
      } catch (e) {
        console.warn('Intent URI selhal:', e);
      }
    }

    // 3. Klasický desktop / výchozí prohlížeč
    window.open(url, embed ? '_top' : '_blank', 'noopener,noreferrer');
    return true;
  }
};
