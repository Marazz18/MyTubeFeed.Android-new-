const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

const EMBED = new URLSearchParams(location.search).has('embed');
document.body.classList.add(EMBED ? 'embed' : 'tab');

const WL = '__wl', ALL = '__all';
const TTL = 15 * 60 * 1000;
const rtf = new Intl.RelativeTimeFormat('cs', { numeric: 'auto' });
const DEF = { db: () => ({ folders: {}, channels: {} }), watched: () => ({}), wl: () => [], settings: () => ({ open: [] }) };

let S = { db: DEF.db(), cache: {}, watched: {}, wl: [], settings: { open: [] } };
const pending = new Set();
const chFilter = {};
const managing = new Set();

/* složky v „Můj feed“: výchozí stav po každém otevření feedu (false = sbalené, true = rozbalené).
   Ruční sbalení/rozbalení platí jen do dalšího otevření feedu. */
const START_OPEN = false;
const flipped = new Set();
const isOpen = n => START_OPEN !== flipped.has(n);
function setOpen(n, v) {
  if (isOpen(n) !== v) { if (flipped.has(n)) flipped.delete(n); else flipped.add(n); }
}

/* tagy: filtry jsou jen v paměti (Watch later a Subscribe list mají každý svůj) */
const wlTagSel = new Set(), subTagSel = new Set();
const normTag = t => t.trim().toLowerCase().replace(/\s+/g, ' ');
const countTags = lists => {
  const m = new Map();
  lists.forEach(l => (l || []).forEach(t => m.set(t, (m.get(t) || 0) + 1)));
  return m;
};
function askTags(known) {
  const r = prompt('Přidat tagy (více oddělených čárkou):' + (known.length ? '\nExistující: ' + known.join(', ') : ''));
  return r ? [...new Set(r.split(',').map(normTag).filter(Boolean))] : [];
}
const isSeenItem = i => (i.wl ? !!i.opened : PT.isSeen(S.watched, i.id));

const saveDb = () => chrome.storage.local.set({ db: S.db });
const saveSettings = () => chrome.storage.local.set({ settings: S.settings });
const saveCache = () => chrome.storage.local.set({ cache: S.cache });

function ago(iso) {
  const s = (new Date(iso) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
  return 'právě teď';
}

/* ---------- data ---------- */
const idsOf = name => name === ALL
  ? [...new Set(Object.values(S.db.folders).flat())]
  : (S.db.folders[name] || []);

function mergeCache(n) {
  for (const id in n) if (!S.cache[id] || n[id].t >= S.cache[id].t) S.cache[id] = n[id];
}

async function fetchChannel(id, force) {
  const c = S.cache[id];
  if (pending.has(id) || (c && !force && Date.now() - c.t < TTL)) return false;
  pending.add(id);
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { credentials: 'omit', cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const items = [...xml.getElementsByTagName('entry')].map(e => ({
      id: e.getElementsByTagName('yt:videoId')[0]?.textContent,
      title: e.getElementsByTagName('title')[0]?.textContent,
      published: e.getElementsByTagName('published')[0]?.textContent,
      channel: e.getElementsByTagName('name')[0]?.textContent,
      short: /\/shorts\//.test(e.getElementsByTagName('link')[0]?.getAttribute('href') || '')
        || /#shorts?\b/i.test(e.getElementsByTagName('title')[0]?.textContent || ''),
      cid: id
    })).filter(i => i.id);
    S.cache[id] = { t: Date.now(), items };
  } catch (err) {
    S.cache[id] = { t: c?.t || 0, items: c?.items || [], error: String(err) };
  } finally {
    pending.delete(id);
  }
  return true;
}

let raf, dragging = null, pendingRender = false, filterOpen = false;
const scheduleRender = () => {
  if (dragging) { pendingRender = true; return; }
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(render);
};

async function refreshAll(force) {
  const ids = idsOf(ALL);
  let i = 0, fetched = false;
  const worker = async () => {
    while (i < ids.length) {
      if (await fetchChannel(ids[i++], force)) { fetched = true; scheduleRender(); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (fetched) await saveCache();
}

/* ---------- výpočty ---------- */
function newCounts(ids) {
  const out = {};
  ids.forEach(id => { out[id] = (S.cache[id]?.items || []).filter(i => PT.isNew(i, S.watched) && !(S.settings.hideShorts && i.short)).length; });
  return out;
}

function itemsOf(name) {
  if (name === WL) return S.wl.map(v => ({ id: v.id, title: v.title, channel: v.channel || '', published: v.added, wl: true, opened: v.opened, tags: v.tags || [] }));
  let ids = idsOf(name);
  if (chFilter[name]) ids = ids.filter(id => id === chFilter[name]);
  let items = ids.flatMap(id => S.cache[id]?.items || []);
  if (S.settings.hideShorts) items = items.filter(i => !i.short);
  return items.sort((a, b) => new Date(b.published) - new Date(a.published));
}

/* ---------- akce ---------- */
async function toggleSeen(id, isWl) {
  if (isWl) {
    // Watch later: „zhlédnuté“ = z feedu jsem na video klikl
    const v = S.wl.find(x => x.id === id);
    if (!v) return;
    if (v.opened) delete v.opened; else v.opened = Date.now();
    await chrome.storage.local.set({ wl: S.wl });
    render();
    return;
  }
  const w = (await chrome.storage.local.get('watched')).watched || {};
  if (PT.isSeen(w, id)) delete w[id];
  else w[id] = { t: PT.SEEN_SECONDS, d: 0, ts: Date.now(), manual: true };
  S.watched = w;
  await chrome.storage.local.set({ watched: w });
  render();
}

async function markOpened(id) {
  const v = S.wl.find(x => x.id === id);
  if (!v || v.opened) return;
  v.opened = Date.now();
  await chrome.storage.local.set({ wl: S.wl });
  scheduleRender();
}

async function addWlTags(id) {
  const v = S.wl.find(x => x.id === id);
  if (!v) return;
  const add = askTags([...countTags(S.wl.map(x => x.tags)).keys()]);
  if (!add.length) return;
  v.tags = [...new Set([...(v.tags || []), ...add])];
  await chrome.storage.local.set({ wl: S.wl });
  render();
}

async function removeWlTag(id, t) {
  const v = S.wl.find(x => x.id === id);
  if (!v) return;
  v.tags = (v.tags || []).filter(x => x !== t);
  await chrome.storage.local.set({ wl: S.wl });
  render();
}

async function addChTags(id) {
  const add = askTags([...countTags(Object.values(S.db.channels).map(c => c.tags)).keys()]);
  if (!add.length) return;
  const c = S.db.channels[id] = S.db.channels[id] || {};
  c.tags = [...new Set([...(c.tags || []), ...add])];
  await saveDb();
  render();
}

async function removeChTag(id, t) {
  const c = S.db.channels[id];
  if (!c) return;
  c.tags = (c.tags || []).filter(x => x !== t);
  await saveDb();
  render();
}

async function removeWl(id) {
  S.wl = S.wl.filter(v => v.id !== id);
  await chrome.storage.local.set({ wl: S.wl });
  render();
}

async function removeChannel(name, id) {
  const targets = name === ALL ? Object.keys(S.db.folders) : [name];
  targets.forEach(k => { S.db.folders[k] = (S.db.folders[k] || []).filter(x => x !== id); });
  await saveDb();
  render();
}

function toggleOpen(name) {
  setOpen(name, !isOpen(name));
  render();
}

/* ---------- pořadí, záložky, filtr ---------- */
const titleOf = n => (n === WL ? 'Watch later' : n === ALL ? '★ Subscribed' : n);
const TABS = ['my', 'all', 'subs', 'wl'];
const tab = () => (TABS.includes(S.settings.tab) ? S.settings.tab : 'my');
const myOff = () => S.settings.myOff ?? [];

function orderedNames() {
  const all = Object.keys(S.db.folders);
  const order = (S.settings.order || []).filter(n => all.includes(n));
  return [...order, ...all.filter(n => !order.includes(n))];
}
const visibleNames = () => orderedNames().filter(n => !myOff().includes(n));

function reorder(from, to, after) {
  const list = orderedNames().filter(n => n !== from);
  list.splice(list.indexOf(to) + (after ? 1 : 0), 0, from);
  S.settings.order = list;
  saveSettings();
  render();
}

function renderChrome() {
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab()));
  $('#filterBtn').hidden = tab() !== 'my';
  const f = $('#filter');
  f.hidden = tab() !== 'my' || !filterOpen;
  f.replaceChildren();
  if (f.hidden) return;
  const off = myOff();
  orderedNames().forEach(n => {
    const cb = h('input', { type: 'checkbox', checked: !off.includes(n), onchange: e => {
      const o = new Set(myOff());
      if (e.target.checked) o.delete(n); else o.add(n);
      S.settings.myOff = [...o];
      saveSettings();
      render();
    } });
    f.append(h('label', { className: 'chip' }, cb, ' ' + titleOf(n)));
  });
}

/* ---------- vykreslení ---------- */
function avatar(id, count, name) {
  const c = S.db.channels[id] || {};
  const el = h('div', {
    className: 'av' + (count ? '' : ' dim') + (chFilter[name] === id ? ' sel' : ''),
    title: `${c.name || id}${count ? ` · ${count} nových` : ''}`,
    onclick: () => {
      chFilter[name] = chFilter[name] === id ? null : id;
      setOpen(name, true);
      render();
    }
  });
  el.append(c.avatar
    ? h('img', { src: c.avatar, alt: '', referrerPolicy: 'no-referrer' })
    : h('span', { textContent: (c.name || '?')[0].toUpperCase() }));
  if (count) el.append(h('b', { textContent: count > 9 ? '9+' : String(count) }));
  return el;
}

/* řádek s tagy: klik na tag = filtr, ✕ = odebrat tag, „+ tag“ = přidat */
function tagRow(tags, sel, onAdd, onRemove) {
  const stop = fn => e => { e.preventDefault(); e.stopPropagation(); fn(); };
  const row = h('div', { className: 'tagrow' });
  tags.forEach(t => row.append(h('span', {
    className: 'ctag' + (sel.has(t) ? ' on' : ''), title: 'Filtrovat podle tagu',
    onclick: stop(() => { if (sel.has(t)) sel.delete(t); else sel.add(t); render(); })
  }, t, h('span', { className: 'x', textContent: '✕', title: 'Odebrat tag', onclick: stop(() => onRemove(t)) }))));
  row.append(h('button', { className: 'addtag', textContent: '+ tag', title: 'Přidat tag', onclick: stop(onAdd) }));
  return row;
}

function tagBar(all, sel) {
  [...sel].forEach(t => { if (!all.has(t)) sel.delete(t); });
  if (!all.size) return null;
  const bar = h('div', { className: 'tagbar' });
  [...all.entries()].sort((a, b) => a[0].localeCompare(b[0], 'cs')).forEach(([t, n]) => bar.append(h('span', {
    className: 'chip' + (sel.has(t) ? ' on' : ''), textContent: `${t} (${n})`,
    onclick: () => { if (sel.has(t)) sel.delete(t); else sel.add(t); render(); }
  })));
  if (sel.size) bar.append(h('button', { textContent: '✕ zrušit filtr', onclick: () => { sel.clear(); render(); } }));
  return bar;
}

function card(i, grid) {
  const seen = isSeenItem(i);
  const seenTitle = i.wl
    ? (seen ? 'Označit jako neotevřené' : 'Označit jako otevřené')
    : (seen ? 'Označit jako nezhlédnuté' : 'Označit jako zhlédnuté');
  const thumb = h('div', { className: 'thumb' },
    h('img', { src: `https://i.ytimg.com/vi/${i.id}/mqdefault.jpg`, loading: 'lazy', alt: '' }),
    h('button', { className: 'seenbtn', textContent: seen ? '↺' : '✓', title: seenTitle,
      onclick: e => { e.preventDefault(); e.stopPropagation(); toggleSeen(i.id, i.wl); } }));
  if (i.wl) thumb.append(h('button', { className: 'rmbtn', textContent: '✕', title: 'Odebrat z Watch later',
    onclick: e => { e.preventDefault(); e.stopPropagation(); removeWl(i.id); } }));
  const body = h('div', {},
    h('div', { className: 'title', textContent: i.title }),
    h('div', { className: 'sub', textContent: `${i.channel ? i.channel + ' · ' : ''}${i.wl ? 'přidáno ' : ''}${ago(i.published)}` }));
  if (i.wl) body.append(tagRow(i.tags, wlTagSel, () => addWlTags(i.id), t => removeWlTag(i.id, t)));
  const videoUrl = `https://www.youtube.com/watch?v=${i.id}`;
  const onOpen = async () => {
    if (i.wl) await markOpened(i.id);
    if (!i.wl && S.settings.markSeenOnExternal && (window.IS_ANDROID_APP || (S.settings.targetBrowser && S.settings.targetBrowser !== 'default'))) {
      const w = (await chrome.storage.local.get('watched')).watched || {};
      if (!PT.isSeen(w, i.id)) {
        w[i.id] = { t: PT.SEEN_SECONDS, d: 0, ts: Date.now(), manual: true };
        S.watched = w;
        await chrome.storage.local.set({ watched: w });
        scheduleRender();
      }
    }
  };
  return h('a', {
    className: 'card' + (grid ? ' gcard' : '') + (seen ? ' seen' : ''),
    href: videoUrl,
    target: EMBED ? '_top' : '_blank',
    rel: 'noopener noreferrer',
    onclick: e => {
      onOpen();
      if (window.IS_ANDROID_APP || (S.settings.targetBrowser && S.settings.targetBrowser !== 'default')) {
        e.preventDefault();
        PT.openExternalUrl(videoUrl, S.settings, EMBED);
      }
    },
    onauxclick: e => { if (e.button === 1) onOpen(); }
  }, thumb, body);
}

function folder(name) {
  const open = isOpen(name);
  const title = titleOf(name);
  const ids = name === WL ? [] : idsOf(name);
  const counts = newCounts(ids);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const btn = (t, tt, fn) => h('button', { textContent: t, title: tt, onclick: e => { e.stopPropagation(); fn(); } });

  const head = h('div', { className: 'fhead', onclick: () => toggleOpen(name) },
    h('span', { className: 'chev', textContent: open ? '▾' : '▸' }),
    h('h2', { textContent: title }),
    h('span', { className: 'info', textContent: name === WL ? String(S.wl.length) : `${ids.length} kanálů` }),
    total ? h('span', { className: 'new', textContent: `${total} nových` }) : '',
    h('span', { className: 'sp' }));
  if (name !== WL) head.append(btn('⚙', 'Spravovat kanály', () => { managing.has(name) ? managing.delete(name) : managing.add(name); setOpen(name, true); render(); }));
  if (name !== WL && name !== ALL) {
    head.append(
      btn('✎', 'Přejmenovat', async () => {
        const n = prompt('Nový název:', name);
        if (!n || n === name || S.db.folders[n]) return;
        S.db.folders = Object.fromEntries(Object.entries(S.db.folders).map(([k, v]) => [k === name ? n : k, v]));
        if (flipped.has(name)) { flipped.delete(name); flipped.add(n); }
        S.settings.order = (S.settings.order || []).map(x => (x === name ? n : x));
        if (S.settings.myOff) S.settings.myOff = S.settings.myOff.map(x => (x === name ? n : x));
        await saveDb(); saveSettings(); render();
      }),
      btn('🗑', 'Smazat složku', async () => {
        if (!confirm(`Smazat složku „${name}“?`)) return;
        delete S.db.folders[name];
        flipped.delete(name);
        await saveDb(); saveSettings(); render();
      }));
  }

  const el = h('section', { className: 'folder' + (open ? ' open' : '') }, head);

  const grip = h('span', { className: 'grip', textContent: '⠿', title: 'Přetáhni pro změnu pořadí' });
  head.prepend(grip);
  head.draggable = true;
  head.addEventListener('dragstart', e => {
    dragging = name;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', name);
    e.dataTransfer.setDragImage(el, 20, 20);
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  head.addEventListener('dragend', () => {
    dragging = null;
    document.querySelectorAll('.dragging, .drop-before, .drop-after').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-after'));
    if (pendingRender) { pendingRender = false; render(); }
  });
  const isAfter = e => {
    const r = el.getBoundingClientRect();
    return EMBED ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
  };
  el.addEventListener('dragover', e => {
    if (!dragging || dragging === name) return;
    e.preventDefault();
    const after = isAfter(e);
    el.classList.toggle('drop-before', !after);
    el.classList.toggle('drop-after', after);
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('drop', e => {
    if (!dragging || dragging === name) return;
    e.preventDefault();
    const from = dragging, after = isAfter(e);
    dragging = null;
    pendingRender = false;
    reorder(from, name, after);
  });

  if (name !== WL) {
    const shown = open ? ids : ids.filter(id => counts[id] > 0);
    if (shown.length) el.append(h('div', { className: 'dash' }, ...shown.map(id => avatar(id, counts[id], name))));
  }

  if (open && managing.has(name)) {
    const m = h('div', { className: 'manage' });
    if (!ids.length) m.append(h('div', { className: 'none', textContent: 'Složka je prázdná.' }));
    ids.forEach(id => m.append(h('div', { className: 'mrow' },
      h('span', { textContent: S.db.channels[id]?.name || id }),
      h('button', { textContent: '✕', title: name === ALL ? 'Odebrat ze všech složek' : 'Odebrat ze složky', onclick: () => removeChannel(name, id) }))));
    el.append(m);
  }

  if (open) {
    let items = itemsOf(name);
    if (S.settings.hideSeen) items = items.filter(i => !PT.isSeen(S.watched, i.id));
    items = items.slice(0, name === WL ? 100 : 50);
    const list = h('div', { className: 'list' });
    list.dataset.f = name;
    if (!items.length) {
      list.append(h('div', { className: 'none', textContent: name === WL
        ? 'Zatím nic. Klikni na „Později“ pod videem nebo na odkaz pravým tlačítkem.'
        : (S.settings.hideSeen ? 'Žádná nezhlédnutá videa.' : 'Zatím žádná videa.') }));
    } else items.forEach(i => list.append(card(i)));
    el.append(list);
  }
  return el;
}

/* ---------- záložky: Vše / Subscribe list / Watch later ---------- */
let allLimit = 60;
const foldersOf = id => Object.keys(S.db.folders).filter(k => S.db.folders[k].includes(id));
const empty = text => h('p', { className: 'empty', textContent: text });

function renderAllTab(main) {
  const ids = idsOf(ALL);
  if (!ids.length) { main.append(empty('Zatím nemáš žádné uložené kanály. Otevři video na YouTube a klikni na ＋ vedle názvu kanálu.')); return; }
  let items = itemsOf(ALL);
  if (S.settings.hideSeen) items = items.filter(i => !PT.isSeen(S.watched, i.id));
  main.append(h('div', { className: 'vhead', textContent: `Videa ze všech složek (${items.length})` }));
  if (!items.length) {
    main.append(h('div', { className: 'none', textContent: S.settings.hideSeen ? 'Žádná nezhlédnutá videa.' : 'Zatím žádná videa.' }));
    return;
  }
  main.append(h('div', { className: 'vgrid' }, ...items.slice(0, allLimit).map(i => card(i, true))));
  if (items.length > allLimit) {
    main.append(h('button', { className: 'more', textContent: `Zobrazit další (${items.length - allLimit})`,
      onclick: () => { allLimit += 60; render(); } }));
  }
}

function renderSubsTab(main) {
  const nameOfCh = id => S.db.channels[id]?.name || id;
  const allIds = idsOf(ALL).sort((a, b) => nameOfCh(a).localeCompare(nameOfCh(b), 'cs'));
  if (!allIds.length) {
    main.append(h('div', { className: 'vhead', textContent: 'Uložené kanály (0)' }));
    main.append(empty('Zatím nemáš žádné uložené kanály. Otevři video na YouTube a klikni na ＋ vedle názvu kanálu.'));
    return;
  }
  const bar = tagBar(countTags(allIds.map(id => S.db.channels[id]?.tags)), subTagSel);
  const ids = subTagSel.size
    ? allIds.filter(id => [...subTagSel].every(t => (S.db.channels[id]?.tags || []).includes(t)))
    : allIds;
  main.append(h('div', { className: 'vhead', textContent: `Uložené kanály (${ids.length}${ids.length !== allIds.length ? ' z ' + allIds.length : ''})` }));
  if (bar) main.append(bar);
  const list = h('div', { className: 'sublist' });
  ids.forEach(id => {
    const c = S.db.channels[id] || {};
    const name = nameOfCh(id);
    const av = h('div', { className: 'av' }, c.avatar
      ? h('img', { src: c.avatar, alt: '', referrerPolicy: 'no-referrer' })
      : h('span', { textContent: name[0].toUpperCase() }));
    const chUrl = `https://www.youtube.com/channel/${id}`;
    const link = h('a', { className: 'subname', textContent: name, href: chUrl,
      target: EMBED ? '_top' : '_blank', rel: 'noopener noreferrer',
      onclick: e => {
        if (window.IS_ANDROID_APP || (S.settings.targetBrowser && S.settings.targetBrowser !== 'default')) {
          e.preventDefault();
          PT.openExternalUrl(chUrl, S.settings, EMBED);
        }
      }
    });
    const tags = h('div', { className: 'subtags' }, ...foldersOf(id).map(f => h('span', { className: 'subtag', textContent: f })));
    tags.append(...(c.tags || []).map(t => h('span', {
      className: 'ctag' + (subTagSel.has(t) ? ' on' : ''), title: 'Filtrovat podle tagu',
      onclick: () => { if (subTagSel.has(t)) subTagSel.delete(t); else subTagSel.add(t); render(); }
    }, t, h('span', { className: 'x', textContent: '✕', title: 'Odebrat tag',
      onclick: e => { e.stopPropagation(); removeChTag(id, t); } }))));
    tags.append(h('button', { className: 'addtag', textContent: '+ tag', title: 'Přidat tag kanálu', onclick: () => addChTags(id) }));
    const rm = h('button', { textContent: '✕', title: 'Odebrat ze všech složek',
      onclick: async () => { if (confirm(`Odebrat „${name}“ ze všech složek?`)) await removeChannel(ALL, id); } });
    list.append(h('div', { className: 'subrow' }, av, link, tags, rm));
  });
  main.append(list);
}

function renderWlTab(main) {
  const all = itemsOf(WL);
  if (!all.length) {
    main.append(h('div', { className: 'vhead', textContent: 'Watch later (0)' }));
    main.append(h('div', { className: 'none', textContent: 'Zatím nic. Klikni na „Později“ pod videem nebo na odkaz pravým tlačítkem.' }));
    return;
  }
  const bar = tagBar(countTags(all.map(i => i.tags)), wlTagSel);
  let items = all;
  if (wlTagSel.size) items = items.filter(i => [...wlTagSel].every(t => i.tags.includes(t)));
  if (S.settings.hideSeen) items = items.filter(i => !isSeenItem(i));
  main.append(h('div', { className: 'vhead', textContent: `Watch later (${items.length}${items.length !== all.length ? ' z ' + all.length : ''})` }));
  if (bar) main.append(bar);
  if (!items.length) {
    main.append(h('div', { className: 'none', textContent: 'Žádné video neodpovídá filtru.' }));
    return;
  }
  main.append(h('div', { className: 'vgrid' }, ...items.map(i => card(i, true))));
}

function render() {
  const main = $('#cols');
  const sl = main.scrollLeft, st = main.scrollTop;
  const tops = {};
  main.querySelectorAll('.list').forEach(l => { tops[l.dataset.f] = l.scrollTop; });
  main.replaceChildren();
  $('#hideSeen').checked = !!S.settings.hideSeen;
  $('#hideShorts').checked = !!S.settings.hideShorts;
  renderChrome();
  const t = tab();
  document.body.dataset.view = t;
  if (t === 'all') renderAllTab(main);
  else if (t === 'subs') renderSubsTab(main);
  else if (t === 'wl') renderWlTab(main);
  else {
    const names = visibleNames();
    names.forEach(n => main.append(folder(n)));
    if (!names.length) {
      main.append(h('p', { className: 'empty', textContent: Object.keys(S.db.folders).length
        ? 'V záložce „Můj feed“ nejsou vybrané žádné složky. Vyber je tlačítkem „Složky ▾“ nahoře.'
        : 'Zatím nemáš žádné složky. Otevři video na YouTube a klikni na ＋ vedle názvu kanálu, nebo vytvoř složku tlačítkem nahoře.' }));
    }
  }
  main.scrollLeft = sl;
  main.scrollTop = st;
  main.querySelectorAll('.list').forEach(l => { l.scrollTop = tops[l.dataset.f] || 0; });
}

/* ---------- ovládání ---------- */
document.querySelectorAll('.tabs [data-tab]').forEach(b => {
  b.onclick = () => { S.settings.tab = b.dataset.tab; saveSettings(); render(); };
});
$('#filterBtn').onclick = () => { filterOpen = !filterOpen; render(); };
$('#refresh').onclick = () => refreshAll(true);
$('#hideSeen').onchange = e => { S.settings.hideSeen = e.target.checked; saveSettings(); render(); };
$('#hideShorts').onchange = e => {
  S.settings.hideShorts = e.target.checked;
  saveSettings();
  render();
  // starší záznamy v cache ještě nemají příznak shorts – jednorázově je načti znovu
  if (e.target.checked && idsOf(ALL).some(id => (S.cache[id]?.items || []).some(i => i.short === undefined))) refreshAll(true);
};
$('#popout').onclick = () => window.open('feed.html', '_blank');

/* ozubené kolečko: vyjížděcí menu (obnovit, celá stránka, sync, export, import) */
const menu = $('#menu'), menuBtn = $('#menuBtn');
const setMenu = open => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
menuBtn.onclick = e => { e.stopPropagation(); setMenu(menu.hidden); };
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
menu.addEventListener('click', () => setTimeout(() => setMenu(false), 0));
$('#newFolder').onclick = async () => {
  const n = prompt('Název složky:');
  if (n && !S.db.folders[n]) { S.db.folders[n] = []; await saveDb(); render(); }
};
$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ db: S.db, wl: S.wl, watched: S.watched }, null, 2)], { type: 'application/json' });
  h('a', { href: URL.createObjectURL(blob), download: 'mytube-zaloha.json' }).click();
};
$('#import').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const n = JSON.parse(await f.text());
    const d = n.db || n;
    for (const [k, v] of Object.entries(d.folders || {})) S.db.folders[k] = [...new Set([...(S.db.folders[k] || []), ...v])];
    Object.assign(S.db.channels, d.channels || {});
    const ids = new Set(S.wl.map(v => v.id));
    (n.wl || []).forEach(v => { if (!ids.has(v.id)) S.wl.push(v); });
    Object.assign(S.watched, n.watched || {});
    await chrome.storage.local.set({ db: S.db, wl: S.wl, watched: S.watched });
    render(); refreshAll(false);
  } catch (err) { alert('Neplatný soubor.'); }
  e.target.value = '';
};

chrome.storage.onChanged.addListener(ch => {
  let refresh = false;
  for (const k of ['db', 'watched', 'wl', 'settings']) {
    if (ch[k]) { S[k] = ch[k].newValue ?? DEF[k](); if (k === 'db') refresh = true; }
  }
  S.settings.open = S.settings.open || [];
  if (ch.cache) mergeCache(ch.cache.newValue || {});
  scheduleRender();
  if (refresh) refreshAll(false);
});

const syncSoft = () => chrome.runtime.sendMessage({ type: 'sync-now', soft: true }).catch(() => {});
window.addEventListener('message', e => { if (e.data === 'pt-open') { flipped.clear(); render(); refreshAll(false); syncSoft(); } });

(async () => {
  S = await PT.getAll();
  const upd = await chrome.storage.local.get(['updateAvailable', 'updateVersion']);
  if (upd.updateAvailable) {
    const ub = $('#updateBanner');
    if (ub) { 
      ub.href = upd.updateAvailable; 
      if (upd.updateVersion) ub.title = 'Nová verze ' + upd.updateVersion + ' – stáhne MyTubeFeed-Update.bat';
      ub.hidden = false; 
    }
  }

  render();
  refreshAll(false);
  syncSoft();
  setInterval(() => refreshAll(false), TTL);
})();

/* ---------- synchronizace přes Nostr (UI) ---------- */
const SYNC = { dlg: $('#syncDlg'), body: $('#syncBody'), msg: '', msgErr: false, reveal: '' };
const sendSync = msg => chrome.runtime.sendMessage(msg).then(r => { if (r?.error) throw new Error(r.error); return r; });
const fmtTs = ts => (ts ? new Date(ts).toLocaleString('cs') : 'nikdy');

async function syncPaint() {
  let st;
  try { st = await sendSync({ type: 'sync-status' }); } catch (e) { st = { enabled: false, relays: [] }; }
  { $('#syncBtn').classList.toggle('on', !!st.enabled); $('#menuBtn').classList.toggle('on', !!st.enabled); }
  const b = SYNC.body;
  b.replaceChildren();
  const say = (t, cls) => b.append(h('p', { textContent: t, className: cls || '' }));
  if (SYNC.msg) say(SYNC.msg, SYNC.msgErr ? 'err' : 'ok');

  const relayBox = h('textarea', { value: (st.relays || []).join('\n'), spellcheck: false });
  const relayRow = () => { b.append(h('label', { textContent: 'Relaye (jeden na řádek, wss://…)' }), relayBox); };
  const relaysVal = () => relayBox.value.split(/\s+/).filter(Boolean);
  const run = (label, fn) => async () => {
    SYNC.msg = label; SYNC.msgErr = false; syncPaint();
    try { await fn(); SYNC.msg = ''; } catch (e) { SYNC.msg = e.message; SYNC.msgErr = true; }
    syncPaint();
  };

  if (!st.enabled) {
    say('Data (složky, kanály, Watch later, zhlédnutá videa) se zašifrují (NIP-44) a uloží jako události na Nostr relayích. Na dalším zařízení stačí zadat stejný klíč.');
    b.append(h('div', { className: 'row' },
      h('button', { textContent: 'Vytvořit nový sync klíč', onclick: run('Zakládám…', () => sendSync({ type: 'sync-setup', generate: true, relays: relaysVal() })) })));
    const inp = h('input', { type: 'password', placeholder: 'nsec1… (klíč z jiného zařízení)', autocomplete: 'off', spellcheck: false });
    b.append(h('label', { textContent: 'Nebo zadej existující klíč' }), inp);
    b.append(h('div', { className: 'row' },
      h('button', { textContent: 'Použít tento klíč', onclick: run('Připojuji…', () => sendSync({ type: 'sync-setup', nsec: inp.value, relays: relaysVal() })) })));
    relayRow();
    b.append(h('div', { className: 'warn', textContent: 'Doporučení: nepoužívej svůj hlavní nostr klíč, vytvoř dedikovaný. Klíč je uložený v úložišti rozšíření.' }));
    return;
  }

  b.append(h('label', { textContent: 'Veřejný klíč (npub)' }), h('code', { textContent: st.npub }));
  const last = st.last;
  const ls = h('p', { className: last?.error ? 'err' : '', style: 'margin-top:10px' });
  ls.textContent = last
    ? (last.error ? 'Chyba: ' + last.error : 'Poslední synchronizace: ' + fmtTs(last.ts))
    : 'Zatím nesynchronizováno.';
  b.append(ls);
  (last?.relays || []).forEach(r => b.append(h('div', { className: 'rl ' + (r.ok ? 'ok' : 'err'), textContent: (r.ok ? '● ' : '○ ') + r.url + (r.error ? ' – ' + r.error : '') })));

  b.append(h('div', { className: 'row' },
    h('button', { textContent: '↻ Synchronizovat teď', onclick: run('Synchronizuji…', () => sendSync({ type: 'sync-now' })) })));

  relayRow();
  b.append(h('div', { className: 'row' },
    h('button', { textContent: 'Uložit relaye a synchronizovat', onclick: run('Ukládám…', () => sendSync({ type: 'sync-setup', relays: relaysVal() })) })));

  b.append(h('label', { textContent: 'Přidání dalšího zařízení' }));
  if (SYNC.reveal) {
    b.append(h('input', { type: 'text', value: SYNC.reveal, readOnly: true, onfocus: e => e.target.select() }));
    b.append(h('div', { className: 'warn', textContent: 'Kdo má tento klíč, přečte všechna tvoje synchronizovaná data. Nikomu ho neposílej.' }));
  }
  b.append(h('div', { className: 'row' },
    h('button', { textContent: SYNC.reveal ? 'Skrýt klíč' : 'Zobrazit sync klíč (nsec)', onclick: async () => {
      if (SYNC.reveal) SYNC.reveal = '';
      else { try { SYNC.reveal = (await sendSync({ type: 'sync-reveal' })).nsec || ''; } catch (e) { /* */ } }
      syncPaint();
    } }),
    h('button', { textContent: 'Vypnout synchronizaci', onclick: async () => {
      if (!confirm('Vypnout synchronizaci na tomto zařízení? Místní data zůstanou, data na relayích se nemažou.')) return;
      SYNC.reveal = '';
      await run('Vypínám…', () => sendSync({ type: 'sync-disable' }))();
    } })));
}

$('#syncBtn').onclick = () => { SYNC.msg = ''; SYNC.reveal = ''; syncPaint(); SYNC.dlg.showModal(); };
$('#syncClose').onclick = () => { SYNC.reveal = ''; SYNC.dlg.close(); };
SYNC.dlg.addEventListener('close', () => { SYNC.reveal = ''; });
chrome.storage.onChanged.addListener(ch => { if (ch.syncStatus && SYNC.dlg.open) syncPaint(); });
sendSync({ type: 'sync-status' }).then(st => { $('#syncBtn').classList.toggle('on', !!st.enabled); $('#menuBtn').classList.toggle('on', !!st.enabled); }).catch(() => {});



/* ---------- Výběr prohlížeče pro otevírání videí (Brave, Firefox, NewPipe…) ---------- */
const BROWSER_DLG = $('#browserDlg'), BROWSER_BODY = $('#browserBody');

function paintBrowserDlg() {
  BROWSER_BODY.replaceChildren();
  const choices = PT.getBrowserChoices();
  const cur = S.settings.targetBrowser || (window.IS_ANDROID_APP ? 'chooser' : 'default');
  const isCustom = !choices.some(c => c.id === cur);

  BROWSER_BODY.append(h('p', {
    textContent: 'Vyber, ve kterém nainstalovaném prohlížeči nebo přehrávači se mají otevírat videa po kliknutí (např. Brave, Firefox, Fennec, NewPipe). Tím na Androidu obejdeš nucené otevírání v oficiální YouTube aplikaci.'
  }));

  const sel = h('select', {});
  choices.forEach(c => {
    sel.append(h('option', { value: c.id, textContent: c.label, selected: !isCustom && c.id === cur }));
  });
  sel.append(h('option', { value: '__custom__', textContent: '⚙️ Vlastní package name (zadat ručně)…', selected: isCustom }));

  const customWrap = h('div', { hidden: !isCustom });
  const customInp = h('input', {
    type: 'text',
    placeholder: 'např. com.brave.browser_nightly nebo org.mozilla.fenix',
    value: isCustom ? cur : ''
  });
  customWrap.append(h('label', { textContent: 'Android package name prohlížeče:' }), customInp);

  sel.onchange = () => {
    customWrap.hidden = sel.value !== '__custom__';
  };

  const markChk = h('input', { type: 'checkbox', checked: !!S.settings.markSeenOnExternal });
  const markRow = h('label', { className: 'chkrow' },
    markChk,
    ' Při otevření v externím prohlížeči rovnou označit video jako zhlédnuté (pro Nostr sync)'
  );

  const msg = h('div', { className: 'hint' });

  const saveBtn = h('button', {
    textContent: '✓ Uložit nastavení prohlížeče',
    onclick: async () => {
      const val = sel.value === '__custom__' ? customInp.value.trim() : sel.value;
      S.settings.targetBrowser = val || 'default';
      S.settings.markSeenOnExternal = markChk.checked;
      await saveSettings();
      msg.textContent = 'Uloženo: ' + S.settings.targetBrowser;
      msg.className = 'hint ok';
      setTimeout(() => BROWSER_DLG.close(), 400);
    }
  });

  const testBtn = h('button', {
    textContent: '▶ Otestovat otevření',
    onclick: () => {
      const val = sel.value === '__custom__' ? customInp.value.trim() : sel.value;
      PT.openExternalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { ...S.settings, targetBrowser: val || 'default' }, EMBED);
    }
  });

  BROWSER_BODY.append(
    h('label', { textContent: 'Zvolený prohlížeč / aplikace:' }),
    sel,
    customWrap,
    markRow,
    h('div', { className: 'row' }, saveBtn, testBtn),
    msg
  );
}

if ($('#browserBtn')) {
  $('#browserBtn').onclick = () => { paintBrowserDlg(); BROWSER_DLG.showModal(); };
  $('#browserClose').onclick = () => BROWSER_DLG.close();
}

/* ---------- Přidání kanálu nebo Watch Later videa přes URL / @handle / Android Share ---------- */
const ADD_DLG = $('#addUrlDlg'), ADD_BODY = $('#addUrlBody');
const CH_ID_RES = [
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
  /"externalId":"(UC[\w-]{22})"/,
  /"channelId":"(UC[\w-]{22})"/,
  /channel_id=(UC[\w-]{22})/
];

async function resolveInputToTarget(raw) {
  const input = (raw || '').trim();
  if (!input) throw new Error('Zadej URL videa, kanálu nebo @handle.');

  // Extrahovat první URL, pokud text pochází z Android "Sdílet" (např. "Podívej se na video https://youtu.be/...")
  const urlMatch = input.match(/https?:\/\/[^\s]+/i);
  const clean = urlMatch ? urlMatch[0] : input;

  // 1) Je to přímo UC... ID kanálu?
  if (/^UC[\w-]{22}$/.test(clean)) {
    return { type: 'channel', id: clean, name: clean, avatar: '' };
  }

  // 2) Je to video URL nebo 11-znakové ID videa?
  const vid = PT.videoIdFromUrl(clean);
  if (vid) {
    let title = vid, channel = '', authorUrl = '';
    try {
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + vid), { credentials: 'omit' });
      if (r.ok) {
        const j = await r.json();
        title = j.title || vid;
        channel = j.author_name || '';
        authorUrl = j.author_url || '';
      }
    } catch (e) { /* fallback */ }
    return { type: 'video', videoId: vid, title, channel, authorUrl };
  }

  // 3) Je to @handle nebo URL kanálu?
  let path = clean;
  if (clean.startsWith('@')) path = '/' + clean;
  else if (/^https?:\/\//i.test(clean)) {
    const u = new URL(clean);
    path = u.pathname;
  } else if (!clean.startsWith('/')) {
    path = '/@' + clean;
  }

  const directMatch = path.match(/^\/channel\/(UC[\w-]{22})/);
  const html = await (await fetch('https://www.youtube.com' + path, { credentials: 'omit' })).text();
  let cid = directMatch ? directMatch[1] : null;
  if (!cid) {
    for (const re of CH_ID_RES) {
      const m = html.match(re);
      if (m) { cid = m[1]; break; }
    }
  }
  if (!cid) throw new Error('Nepodařilo se zjistit ID kanálu (UC…). Zkontroluj URL nebo @handle.');
  const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
  const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
  const name = titleMatch ? titleMatch[1].replace(/ - YouTube$/, '') : path.slice(1);
  const avatar = imgMatch ? imgMatch[1].replace(/=s\d+/, '=s96') : '';
  return { type: 'channel', id: cid, name, avatar };
}

function paintAddUrlDlg(prefill = '') {
  ADD_BODY.replaceChildren();
  ADD_BODY.append(h('p', {
    textContent: 'Vlož odkaz na YouTube video (pro Watch later nebo odběr kanálu), odkaz na kanál nebo @handle (např. @Kanál).'
  }));

  const inp = h('input', {
    type: 'text',
    placeholder: 'https://youtu.be/… nebo @handle nebo UC…',
    value: prefill
  });

  const folderNames = orderedNames();
  const folderSel = h('select', {});
  folderNames.forEach(f => folderSel.append(h('option', { value: f, textContent: 'Složka: ' + f })));
  folderSel.append(h('option', { value: '__new__', textContent: '＋ Vytvořit novou složku…' }));

  const newFolderInp = h('input', {
    type: 'text',
    placeholder: 'Název nové složky',
    hidden: folderNames.length > 0
  });
  folderSel.onchange = () => { newFolderInp.hidden = folderSel.value !== '__new__'; };

  const statusEl = h('div', { className: 'hint' });

  const getTargetFolder = () => {
    if (folderSel.value === '__new__' || !folderNames.length) return newFolderInp.value.trim();
    return folderSel.value;
  };

  const addWlBtn = h('button', {
    textContent: '🕒 Přidat video do Watch later',
    onclick: async () => {
      statusEl.textContent = 'Načítám informace o videu…';
      statusEl.className = 'hint';
      try {
        const res = await resolveInputToTarget(inp.value);
        if (res.type !== 'video') throw new Error('Zadaný odkaz není video.');
        if (!S.wl.some(v => v.id === res.videoId)) {
          S.wl.unshift({ id: res.videoId, title: res.title, channel: res.channel, added: new Date().toISOString() });
          await chrome.storage.local.set({ wl: S.wl });
          render();
        }
        statusEl.textContent = `✓ Video „${res.title}“ uloženo do Watch later.`;
        statusEl.className = 'hint ok';
      } catch (e) {
        statusEl.textContent = e.message || String(e);
        statusEl.className = 'hint err';
      }
    }
  });

  const addChBtn = h('button', {
    textContent: '＋ Přidat kanál do složky',
    onclick: async () => {
      const folderName = getTargetFolder();
      if (!folderName) {
        statusEl.textContent = 'Zadej nebo vyber cílovou složku.';
        statusEl.className = 'hint err';
        return;
      }
      statusEl.textContent = 'Hledám kanál…';
      statusEl.className = 'hint';
      try {
        let res = await resolveInputToTarget(inp.value);
        if (res.type === 'video') {
          if (!res.authorUrl) throw new Error('Z videa se nepodařilo zjistit kanál. Vlož přímo odkaz na kanál.');
          res = await resolveInputToTarget(res.authorUrl);
        }
        S.db.folders[folderName] = [...new Set([...(S.db.folders[folderName] || []), res.id])];
        const old = S.db.channels[res.id] || {};
        S.db.channels[res.id] = { ...old, name: res.name || old.name || res.id, avatar: res.avatar || old.avatar || '' };
        await saveDb();
        await fetchChannel(res.id, true);
        await saveCache();
        render();
        statusEl.textContent = `✓ Kanál „${res.name}“ přidán do složky „${folderName}“.`;
        statusEl.className = 'hint ok';
      } catch (e) {
        statusEl.textContent = e.message || String(e);
        statusEl.className = 'hint err';
      }
    }
  });

  ADD_BODY.append(
    h('label', { textContent: 'URL videa / kanálu nebo @handle:' }),
    inp,
    h('label', { textContent: 'Cílová složka (při přidání kanálu):' }),
    folderSel,
    newFolderInp,
    h('div', { className: 'row' }, addWlBtn, addChBtn),
    statusEl
  );
}

if ($('#addUrlBtn')) {
  $('#addUrlBtn').onclick = () => { paintAddUrlDlg(''); ADD_DLG.showModal(); };
  $('#addUrlClose').onclick = () => ADD_DLG.close();
}

// Callback volaný z Android nativního Share Intentu (když uživatel dá v Brave/Firefoxu/YouTube "Sdílet -> MyTube Feed")
window.onAndroidSharedUrl = function(sharedText) {
  if (!sharedText) return;
  paintAddUrlDlg(sharedText);
  if (!ADD_DLG.open) ADD_DLG.showModal();
};
