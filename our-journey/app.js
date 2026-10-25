'use strict';

/* =========================================================
   Our Journey — a private photo & video slideshow.
   Everything added on the phone is stored on the phone
   (IndexedDB); nothing is uploaded anywhere.
   ========================================================= */

const $ = (sel) => document.querySelector(sel);

const DEFAULT_SETTINGS = {
  names: '',
  startDate: '',
  duration: 6,
  order: 'chrono',
  chapters: true,
  videoSound: true,
  musicName: '',
};

const state = {
  memories: [],          // sorted oldest -> newest
  settings: { ...DEFAULT_SETTINGS },
  music: null,           // Blob
  thumbUrls: new Map(),  // id -> object URL for grid thumbnails
  editing: null,
};

/* ---------------- IndexedDB ---------------- */

const DB_NAME = 'our-journey';
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('memories', { keyPath: 'id' });
        d.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const idb = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
};

/* ---------------- Dates ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const longDate = (s) => parseISODate(s).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const DAY = 86400000;

function yearOfUs(dateStr) {
  const start = state.settings.startDate;
  if (!start || dateStr < start) return null;
  const a = parseISODate(start);
  const b = parseISODate(dateStr);
  let years = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) years--;
  return years + 1;
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/* ---------------- Reading capture dates from files ---------------- */

// JPEG EXIF DateTimeOriginal -> 'YYYY-MM-DD'
async function exifDate(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10;
        const le = v.getUint16(tiff) === 0x4949;
        const u16 = (o) => v.getUint16(o, le);
        const u32 = (o) => v.getUint32(o, le);
        const readIFD = (ifdOff) => {
          const out = {};
          const count = u16(tiff + ifdOff);
          for (let i = 0; i < count; i++) {
            const e = tiff + ifdOff + 2 + i * 12;
            out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 };
          }
          return out;
        };
        const ascii = (entry) => {
          const start = entry.count > 4 ? tiff + u32(entry.valueOff) : entry.valueOff;
          let s = '';
          for (let i = 0; i < entry.count - 1; i++) s += String.fromCharCode(v.getUint8(start + i));
          return s;
        };
        const ifd0 = readIFD(u32(tiff + 4));
        let raw = null;
        if (ifd0[0x8769]) {
          const exif = readIFD(u32(ifd0[0x8769].valueOff));
          if (exif[0x9003]) raw = ascii(exif[0x9003]);
        }
        if (!raw && ifd0[0x0132]) raw = ascii(ifd0[0x0132]);
        const m = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2})/);
        return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : null;
      }
      if ((marker & 0xff00) !== 0xff00) return null;
      off += 2 + len;
    }
  } catch (_) { /* unreadable — fall back */ }
  return null;
}

// MP4 / MOV 'mvhd' creation time -> 'YYYY-MM-DD'
async function videoDate(file) {
  const scan = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    for (let i = 0; i < bytes.length - 16; i++) {
      if (bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) {
        const v = new DataView(bytes.buffer, i + 4);
        const secs = v.getUint8(0) === 1 ? Number(v.getBigUint64(4)) : v.getUint32(4);
        const d = new Date((secs - 2082844800) * 1000);
        if (d.getFullYear() > 1990 && d.getTime() < Date.now() + DAY) return toISODate(d);
        return null;
      }
    }
    return null;
  };
  try {
    const chunk = 1024 * 1024;
    return (await scan(file.slice(0, chunk))) ||
      (file.size > chunk ? await scan(file.slice(Math.max(0, file.size - chunk))) : null);
  } catch (_) {
    return null;
  }
}

/* ---------------- Thumbnails ---------------- */

function canvasToBlob(source, w, h) {
  const max = 480;
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
}

function imageThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      const blob = await canvasToBlob(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function videoThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    const finish = (blob) => {
      if (done) return;
      done = true;
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 4); };
    v.onseeked = async () => finish(await canvasToBlob(v, v.videoWidth, v.videoHeight));
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 10000);
    v.src = url;
    // iOS only loads video data once playback is requested.
    v.play().then(() => v.pause()).catch(() => {});
  });
}

/* ---------------- Loading ---------------- */

const isVideoName = (name) => /\.(mp4|mov|m4v|webm)$/i.test(name);

async function loadBundled() {
  // Optional: memories.json next to this file, for photos you ship with the app.
  try {
    const res = await fetch('memories.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.memories || []).map((m, i) => ({
      id: `bundled-${i}`,
      bundled: true,
      kind: m.type || (isVideoName(m.src) ? 'video' : 'image'),
      src: m.src,
      poster: m.poster || null,
      date: m.date || '1970-01-01',
      caption: m.caption || '',
      favorite: !!m.favorite,
    }));
  } catch (_) {
    return [];
  }
}

async function loadAll() {
  const [local, bundled, saved, music] = await Promise.all([
    idb.all('memories'),
    loadBundled(),
    idb.get('settings', 'prefs'),
    idb.get('settings', 'music'),
  ]);
  state.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  state.music = music || null;
  state.memories = sortMemories([...bundled, ...local]);
}

function sortMemories(list) {
  return list.sort((a, b) => a.date.localeCompare(b.date) || (a.added || 0) - (b.added || 0));
}

function thumbUrl(m) {
  if (m.bundled) return m.kind === 'image' ? m.src : m.poster;
  if (!m.thumb) return null;
  if (!state.thumbUrls.has(m.id)) state.thumbUrls.set(m.id, URL.createObjectURL(m.thumb));
  return state.thumbUrls.get(m.id);
}

function fullUrl(m) {
  return m.bundled ? m.src : URL.createObjectURL(m.blob);
}

function releaseUrl(m, url) {
  if (!m.bundled && url) URL.revokeObjectURL(url);
}

/* ---------------- Importing ---------------- */

async function importFiles(files) {
  const list = [...files].filter((f) => /^(image|video)\//.test(f.type) || isVideoName(f.name));
  if (!list.length) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  let added = 0;
  for (const file of list) {
    toast(`Adding ${added + 1} of ${list.length}…`, 0);
    const kind = file.type.startsWith('video') || isVideoName(file.name) ? 'video' : 'image';
    const date = (kind === 'image' ? await exifDate(file) : await videoDate(file)) ||
      toISODate(new Date(file.lastModified || Date.now()));
    const thumb = kind === 'image' ? await imageThumb(file) : await videoThumb(file);
    const memory = {
      id: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`,
      kind,
      date,
      caption: '',
      favorite: false,
      name: file.name,
      added: Date.now(),
      blob: file,
      thumb,
    };
    try {
      await idb.put('memories', memory);
      state.memories.push(memory);
      added++;
    } catch (err) {
      toast('Your phone is out of space for more memories.');
      console.error(err);
      break;
    }
  }
  sortMemories(state.memories);
  render();
  if (added) toast(added === 1 ? 'Memory added ♥' : `${added} memories added ♥`);
}

/* ---------------- Rendering ---------------- */

function render() {
  renderHero();
  renderOnThisDay();
  renderTimeline();
}

let heroUrl = null;
let heroMemory = null;
function renderHero() {
  const { names, startDate } = state.settings;
  $('#heroNames').textContent = names || 'Us';

  const counter = $('#dayCounter');
  if (startDate) {
    const days = Math.floor((Date.now() - parseISODate(startDate).getTime()) / DAY);
    counter.innerHTML = `<strong>${days.toLocaleString()}</strong> days together · since ${longDate(startDate)}`;
  } else {
    counter.textContent = 'Every picture tells a piece of our story.';
  }

  const images = state.memories.filter((m) => m.kind === 'image');
  const pool = images.filter((m) => m.favorite).length ? images.filter((m) => m.favorite) : images;
  if (heroMemory && pool.includes(heroMemory)) return;
  if (heroUrl) releaseUrl(heroMemory, heroUrl);
  heroMemory = pool[Math.floor(Math.random() * pool.length)] || null;
  heroUrl = heroMemory ? fullUrl(heroMemory) : null;
  $('#heroBg').style.backgroundImage = heroUrl ? `url("${heroUrl}")` : '';
}

let otdUrl = null;
function renderOnThisDay() {
  const card = $('#onThisDay');
  const today = new Date();
  const md = `${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const matches = state.memories.filter((m) => m.date.slice(5) === md && Number(m.date.slice(0, 4)) < today.getFullYear());
  if (otdUrl) { URL.revokeObjectURL(otdUrl); otdUrl = null; }
  if (!matches.length) { card.hidden = true; return; }

  const m = matches[Math.floor(Math.random() * matches.length)];
  const years = today.getFullYear() - Number(m.date.slice(0, 4));
  const url = fullUrl(m);
  if (!m.bundled) otdUrl = url;
  const media = $('#otdMedia');
  media.innerHTML = '';
  const el = document.createElement(m.kind === 'video' ? 'video' : 'img');
  el.src = url;
  if (m.kind === 'video') Object.assign(el, { muted: true, playsInline: true, controls: true, preload: 'metadata' });
  else el.alt = m.caption || 'A memory';
  media.append(el);
  $('#otdCaption').textContent = `${years} year${years > 1 ? 's' : ''} ago${m.caption ? ` · ${m.caption}` : ''}`;
  card.hidden = false;
}

function renderTimeline() {
  const root = $('#timeline');
  root.innerHTML = '';
  const n = state.memories.length;
  $('#memoryCount').textContent = n ? `${n} ${n === 1 ? 'memory' : 'memories'}` : '';
  $('#emptyState').hidden = n > 0;

  const byYear = new Map();
  for (const m of state.memories) {
    const y = m.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(m);
  }

  for (const [year, items] of byYear) {
    const section = document.createElement('section');
    section.className = 'chapter';
    const title = document.createElement('h3');
    title.className = 'chapter-title';
    title.textContent = year;
    const yo = yearOfUs(items[items.length - 1].date);
    const sub = document.createElement('span');
    sub.textContent = yo ? `${ordinal(yo)} year together` : `${items.length} ${items.length === 1 ? 'memory' : 'memories'}`;
    title.append(sub);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const m of items) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.setAttribute('aria-label', m.caption || longDate(m.date));
      const t = thumbUrl(m);
      if (t) tile.style.backgroundImage = `url("${t}")`;
      if (m.kind === 'video') {
        tile.innerHTML = '<span class="badge"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>';
      }
      if (m.favorite) tile.insertAdjacentHTML('beforeend', '<span class="fav">♥</span>');
      tile.addEventListener('click', () => openEditor(m));
      grid.append(tile);
    }
    section.append(title, grid);
    root.append(section);
  }
}

/* ---------------- Edit sheet ---------------- */

let editUrl = null;
function openEditor(m) {
  state.editing = m;
  const media = $('#editMedia');
  media.innerHTML = '';
  editUrl = fullUrl(m);
  const el = document.createElement(m.kind === 'video' ? 'video' : 'img');
  el.src = editUrl;
  if (m.kind === 'video') Object.assign(el, { controls: true, playsInline: true, preload: 'metadata' });
  media.append(el);

  $('#editDate').value = m.date;
  $('#editCaption').value = m.caption;
  $('#editFavorite').checked = m.favorite;
  for (const id of ['#editDate', '#editCaption', '#editFavorite']) $(id).disabled = !!m.bundled;
  $('#deleteBtn').hidden = !!m.bundled;
  $('#editSheet').showModal();
}

function closeEditorCleanup() {
  const m = state.editing;
  $('#editMedia').innerHTML = '';
  if (m) releaseUrl(m, editUrl);
  editUrl = null;
  state.editing = null;
}

async function saveEdit() {
  const m = state.editing;
  if (!m || m.bundled) return;
  m.date = $('#editDate').value || m.date;
  m.caption = $('#editCaption').value.trim();
  m.favorite = $('#editFavorite').checked;
  await idb.put('memories', m);
  sortMemories(state.memories);
  render();
}

async function deleteEditing() {
  const m = state.editing;
  if (!m || !confirm('Remove this memory from the app? (It stays in your Photos library.)')) return;
  await idb.del('memories', m.id);
  state.memories = state.memories.filter((x) => x !== m);
  if (state.thumbUrls.has(m.id)) {
    URL.revokeObjectURL(state.thumbUrls.get(m.id));
    state.thumbUrls.delete(m.id);
  }
  $('#editSheet').close();
  render();
  toast('Memory removed');
}

/* ---------------- Settings sheet ---------------- */

async function openSettings() {
  const s = state.settings;
  $('#setNames').value = s.names;
  $('#setStart').value = s.startDate;
  $('#setDuration').value = s.duration;
  $('#durationLabel').textContent = `${s.duration} seconds`;
  $('#setOrder').value = s.order;
  $('#setChapters').checked = s.chapters;
  $('#setVideoSound').checked = s.videoSound;
  $('#musicName').textContent = state.music ? s.musicName || 'Your song' : 'None';
  $('#clearMusic').hidden = !state.music;

  const info = $('#storageInfo');
  info.textContent = '';
  if (navigator.storage && navigator.storage.estimate) {
    const { usage } = await navigator.storage.estimate();
    if (usage) info.textContent = `Memories use about ${(usage / 1e9).toFixed(usage > 1e8 ? 1 : 2)} GB on this phone.`;
  }
  $('#settingsSheet').showModal();
}

async function saveSettings() {
  const s = state.settings;
  s.names = $('#setNames').value.trim();
  s.startDate = $('#setStart').value;
  s.duration = Number($('#setDuration').value);
  s.order = $('#setOrder').value;
  s.chapters = $('#setChapters').checked;
  s.videoSound = $('#setVideoSound').checked;
  await idb.put('settings', s, 'prefs');
  render();
}

/* ---------------- Slideshow ---------------- */

const show = {
  playlist: [],
  index: 0,
  slides: [],
  front: 0,
  paused: false,
  elapsed: 0,
  lastTick: 0,
  duration: 6000,
  current: null,
  raf: 0,
  video: null,
  audio: null,
  audioUrl: null,
  wakeLock: null,
  controlsTimer: 0,
  token: 0,
  loading: false,
};

function buildPlaylist(startAt) {
  const s = state.settings;
  let items = [...state.memories];
  if (s.order === 'favorites') {
    const favs = items.filter((m) => m.favorite);
    if (favs.length) items = favs;
  }
  if (s.order === 'reverse') items.reverse();
  if (s.order === 'shuffle') {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }
  if (startAt) {
    const i = items.indexOf(startAt);
    if (i > 0) items = [...items.slice(i), ...items.slice(0, i)];
  }

  const list = [];
  const chapters = s.chapters && s.order !== 'shuffle';
  let lastYear = null;
  for (const m of items) {
    const y = m.date.slice(0, 4);
    if (chapters && y !== lastYear) {
      const yo = yearOfUs(m.date);
      list.push({ title: y, sub: yo ? `Our ${ordinal(yo)} year` : '' });
      lastYear = y;
    }
    list.push({ memory: m });
  }
  if (s.startDate && !startAt) {
    const days = Math.floor((Date.now() - parseISODate(s.startDate).getTime()) / DAY);
    list.push({ title: '♥', sub: `${days.toLocaleString()} days · and counting` });
  }
  return list;
}

function startShow(startAt) {
  if (!state.memories.length) {
    toast('Add a few photos first ♥');
    return;
  }
  show.playlist = buildPlaylist(startAt);
  show.index = 0;
  show.paused = false;
  show.slides = [$('#slideA'), $('#slideB')];
  show.duration = state.settings.duration * 1000;

  // These must be created inside the tap so iOS allows sound later.
  if (!show.video) {
    show.video = document.createElement('video');
    show.video.className = 'media';
    show.video.playsInline = true;
    show.video.setAttribute('playsinline', '');
    show.video.addEventListener('ended', () => next());
  }
  show.video.load();

  if (state.music) {
    if (!show.audio) {
      show.audio = new Audio();
      show.audio.loop = true;
    }
    if (show.audioUrl) URL.revokeObjectURL(show.audioUrl);
    show.audioUrl = URL.createObjectURL(state.music);
    show.audio.src = show.audioUrl;
    show.audio.play().catch(() => {});
  }

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $('#show').classList.add('active');
  setPauseIcon();
  requestWakeLock();
  showSlide(0);
  show.lastTick = performance.now();
  cancelAnimationFrame(show.raf);
  show.raf = requestAnimationFrame(tick);
}

function stopShow() {
  cancelAnimationFrame(show.raf);
  show.token++;
  if (show.video) {
    show.video.pause();
    show.video.removeAttribute('src');
    show.video.load();
  }
  if (show.audio) show.audio.pause();
  for (const slide of show.slides) clearSlide(slide);
  if (show.wakeLock) show.wakeLock.release().catch(() => {});
  show.wakeLock = null;
  $('#show').classList.remove('active');
  $('#home').classList.add('active');
}

function clearSlide(slide) {
  if (slide._memory) releaseUrl(slide._memory, slide._url);
  slide._memory = null;
  slide._url = null;
  slide.className = 'slide';
  slide.innerHTML = '';
}

async function showSlide(i) {
  const token = ++show.token;
  const n = show.playlist.length;
  show.index = ((i % n) + n) % n;
  const item = show.playlist[show.index];
  show.current = item;
  show.loading = true;

  const outgoing = show.slides[show.front];
  const incoming = show.slides[1 - show.front];
  clearSlide(incoming);

  const caption = $('#showCaption');
  caption.classList.add('hidden');

  if (item.title) {
    incoming.classList.add('title-card');
    incoming.innerHTML = '<p class="year"></p><p class="sub"></p>';
    incoming.querySelector('.year').textContent = item.title;
    incoming.querySelector('.sub').textContent = item.sub;
  } else {
    const m = item.memory;
    const url = fullUrl(m);
    incoming._memory = m;
    incoming._url = url;
    if (m.kind === 'image') {
      const backdrop = document.createElement('div');
      backdrop.className = 'backdrop';
      backdrop.style.backgroundImage = `url("${url}")`;
      const img = new Image();
      img.className = 'media';
      img.alt = m.caption || '';
      img.src = url;
      try { await img.decode(); } catch (_) { /* show anyway */ }
      if (token !== show.token) return;
      setKenBurns(incoming);
      incoming.append(backdrop, img);
    } else {
      const v = show.video;
      v.pause();
      v.muted = !state.settings.videoSound;
      v.src = url;
      incoming.append(v);
    }
  }

  if (token !== show.token) return;
  incoming.classList.add('visible');
  outgoing.classList.remove('visible');
  show.front = 1 - show.front;
  show.elapsed = 0;
  show.loading = false;
  // Let the old slide finish fading before freeing it.
  setTimeout(() => { if (token === show.token && !outgoing.classList.contains('visible')) clearSlide(outgoing); }, 1200);

  if (item.memory) {
    $('#showDate').textContent = longDate(item.memory.date);
    $('#showText').textContent = item.memory.caption;
    setTimeout(() => { if (token === show.token) caption.classList.remove('hidden'); }, 500);
  }

  syncMedia();
}

function setKenBurns(slide) {
  const r = (a, b) => (a + Math.random() * (b - a)).toFixed(3);
  const zoomIn = Math.random() > 0.5;
  slide.style.setProperty('--kb-dur', `${state.settings.duration + 1.5}s`);
  slide.style.setProperty('--kb-s0', zoomIn ? '1' : '1.14');
  slide.style.setProperty('--kb-s1', zoomIn ? '1.14' : '1');
  slide.style.setProperty('--kb-x0', `${r(-2, 2)}%`);
  slide.style.setProperty('--kb-y0', `${r(-2, 2)}%`);
  slide.style.setProperty('--kb-x1', `${r(-2, 2)}%`);
  slide.style.setProperty('--kb-y1', `${r(-2, 2)}%`);
  slide.classList.add('kenburns');
}

// Keep the video and music in step with the current slide and pause state.
function syncMedia() {
  const isVideo = show.current && show.current.memory && show.current.memory.kind === 'video';
  const v = show.video;
  if (isVideo && !show.paused) {
    v.play().catch(() => {
      // Sound not allowed yet — play silently instead of stalling.
      v.muted = true;
      v.play().catch(() => {});
    });
  } else if (v) {
    v.pause();
  }

  if (show.audio && state.music) {
    const videoWithSound = isVideo && !v.muted;
    if (show.paused || videoWithSound) show.audio.pause();
    else show.audio.play().catch(() => {});
  }

  const running = !show.paused;
  for (const slide of show.slides) {
    slide.querySelectorAll('img.media').forEach((img) => {
      img.style.animationPlayState = running ? 'running' : 'paused';
    });
  }
}

function tick(now) {
  const dt = now - show.lastTick;
  show.lastTick = now;
  const item = show.current;
  let progress = 0;

  if (item && item.memory && item.memory.kind === 'video') {
    const v = show.video;
    progress = v.duration ? v.currentTime / v.duration : 0;
  } else if (item && !show.loading) {
    if (!show.paused) show.elapsed += dt;
    const dur = item.title ? 3500 : show.duration;
    progress = show.elapsed / dur;
    if (show.elapsed >= dur) next();
  }
  $('#progressBar').style.width = `${Math.min(100, progress * 100)}%`;
  show.raf = requestAnimationFrame(tick);
}

function next() { showSlide(show.index + 1); }
function prev() { showSlide(show.index - 1); }

function togglePause() {
  show.paused = !show.paused;
  setPauseIcon();
  syncMedia();
}

function setPauseIcon() {
  $('#pauseIcon').innerHTML = show.paused ? '<path d="M8 5v14l11-7z"/>' : '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';
  $('#pauseBtn').setAttribute('aria-label', show.paused ? 'Play' : 'Pause');
}

function flashControls() {
  const c = $('#showControls');
  c.classList.add('visible');
  clearTimeout(show.controlsTimer);
  show.controlsTimer = setTimeout(() => c.classList.remove('visible'), 3500);
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) show.wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) { /* not supported or denied */ }
}

/* ---------------- Toast ---------------- */

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------------- Wiring ---------------- */

function wire() {
  $('#playBtn').addEventListener('click', () => startShow());
  $('#fileInput').addEventListener('change', async (e) => {
    const files = e.target.files;
    await importFiles(files);
    e.target.value = '';
  });

  // Edit sheet
  const editSheet = $('#editSheet');
  editSheet.addEventListener('close', async () => {
    if (editSheet.returnValue === 'save') await saveEdit();
    closeEditorCleanup();
  });
  $('#deleteBtn').addEventListener('click', deleteEditing);
  $('#playFromBtn').addEventListener('click', () => {
    const m = state.editing;
    editSheet.close('cancel');
    startShow(m);
  });

  // Settings sheet
  const settingsSheet = $('#settingsSheet');
  $('#settingsBtn').addEventListener('click', openSettings);
  settingsSheet.addEventListener('close', saveSettings);
  $('#setDuration').addEventListener('input', (e) => {
    $('#durationLabel').textContent = `${e.target.value} seconds`;
  });
  $('#musicInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    state.music = file;
    state.settings.musicName = file.name.replace(/\.[^.]+$/, '');
    await idb.put('settings', file, 'music');
    await idb.put('settings', state.settings, 'prefs');
    $('#musicName').textContent = state.settings.musicName;
    $('#clearMusic').hidden = false;
  });
  $('#clearMusic').addEventListener('click', async () => {
    state.music = null;
    state.settings.musicName = '';
    await idb.del('settings', 'music');
    $('#musicName').textContent = 'None';
    $('#clearMusic').hidden = true;
  });

  // Slideshow controls
  $('#closeShow').addEventListener('click', stopShow);
  $('#pauseBtn').addEventListener('click', () => { togglePause(); flashControls(); });
  $('#prevBtn').addEventListener('click', () => { prev(); flashControls(); });
  $('#nextBtn').addEventListener('click', () => { next(); flashControls(); });

  const stage = $('#show');
  let sx = 0;
  let sy = 0;
  let st = 0;
  stage.addEventListener('touchstart', (e) => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    st = Date.now();
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (e.target.closest('.icon-btn')) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next(); else prev();
    } else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) {
      stopShow();
    } else if (Date.now() - st < 300) {
      flashControls();
    }
  });
  stage.addEventListener('click', (e) => {
    // Desktop browsers: click toggles controls (touch handled above).
    if (!e.target.closest('.icon-btn') && !('ontouchstart' in window)) flashControls();
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#show').classList.contains('active')) return;
    if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key === 'Escape') stopShow();
  });

  document.addEventListener('visibilitychange', () => {
    if (!$('#show').classList.contains('active')) return;
    if (document.hidden) {
      if (!show.paused) togglePause();
    } else {
      requestWakeLock();
      show.lastTick = performance.now();
    }
  });
}

async function init() {
  wire();
  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    toast('Could not open saved memories on this device.');
  }
  render();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
