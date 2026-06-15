// RIT frontend — strict B/W, animated with GSAP + anime.js.
// Standalone-capable via mock mode (in-browser fake backend in localStorage).

const API = location.port === '3000' || location.protocol === 'file:'
  ? (location.protocol === 'file:' ? 'http://localhost:3000' : '')
  : 'http://localhost:3000';

const USERS = {
  alice: { name: 'Alice' },
  bob:   { name: 'Bob' },
};

const PX_PER_SEC = 12;
const TIMELINE_SECONDS = 90;
const LS_PREFIX = 'rit:working:';
const MOCK_REPO_KEY = 'rit:mock-repo';

// Mock auto-enables for file:// (no backend possible), ?mock=1 query, or
// persistent localStorage flag. Also flips ON if first real call fails.
let useMock = (new URLSearchParams(location.search).get('mock') === '1') ||
              (location.protocol === 'file:') ||
              (localStorage.getItem('rit:mock') === '1');

// ---------- state ----------

const state = {
  currentUser: 'alice',
  working: {
    alice: loadWorking('alice'),
    bob:   loadWorking('bob'),
  },
  repo: null,
  pendingMerge: null,
  prevMainIds: new Set(),
};

function loadWorking(user) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + user);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  if (user === 'alice') {
    return [
      makeClip('intro hook', 0, 5, 'alice'),
      makeClip('cold open',  5, 6, 'alice'),
    ];
  }
  return [
    makeClip('B-roll city', 30, 6, 'bob'),
    makeClip('outro CTA',   42, 5, 'bob'),
  ];
}

function persistWorking() {
  localStorage.setItem(
    LS_PREFIX + state.currentUser,
    JSON.stringify(state.working[state.currentUser])
  );
}

function makeClip(name, start, duration, owner) {
  return {
    id: cryptoRandomId(),
    name,
    start_sec: start,
    duration_sec: duration,
    owner,
  };
}

function cryptoRandomId() {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- mock backend ----------

function mockLoad() {
  try {
    const raw = localStorage.getItem(MOCK_REPO_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return { commits: [], main_timeline: [], head: null };
}
function mockSave(repo) {
  localStorage.setItem(MOCK_REPO_KEY, JSON.stringify(repo));
}
function mockOverlaps(a, b) {
  const aEnd = a.start_sec + a.duration_sec;
  const bEnd = b.start_sec + b.duration_sec;
  return a.start_sec < bEnd && b.start_sec < aEnd;
}
function mockPlanMerge(base, incoming) {
  const baseIds = new Set(base.map(c => c.id));
  const newClips = incoming.filter(c => !baseIds.has(c.id));
  const auto_add = [], conflicts = [];
  for (const clip of newClips) {
    const collisions = base.filter(b => mockOverlaps(clip, b));
    if (collisions.length === 0) auto_add.push(clip);
    else conflicts.push({ incoming: clip, conflicting_main: collisions });
  }
  return { auto_add, conflicts };
}

async function mockApi(method, path, body) {
  await new Promise(r => setTimeout(r, 80)); // tiny latency for nicer animations
  const repo = mockLoad();

  if (method === 'GET' && path === '/api/repo') return repo;

  if (method === 'POST' && path === '/api/commit') {
    const { author, message, timeline } = body || {};
    const commit = {
      id: cryptoRandomId(),
      author,
      message: message || '',
      timestamp: new Date().toISOString(),
      parent: repo.head,
      timeline_snapshot: timeline,
    };
    repo.commits.push(commit);
    repo.head = commit.id;
    mockSave(repo);
    return { ok: true, commit };
  }

  if (method === 'POST' && path === '/api/merge/preview') {
    const c = repo.commits.find(c => c.id === body.commit_id);
    if (!c) throw new Error('commit not found');
    const plan = mockPlanMerge(repo.main_timeline, c.timeline_snapshot);
    return { ok: true, plan, base_count: repo.main_timeline.length };
  }

  if (method === 'POST' && path === '/api/merge') {
    const { commit_id, resolutions = {} } = body || {};
    const c = repo.commits.find(c => c.id === commit_id);
    if (!c) throw new Error('commit not found');
    const plan = mockPlanMerge(repo.main_timeline, c.timeline_snapshot);
    let newTimeline = [...repo.main_timeline, ...plan.auto_add];
    const decisions = [];
    for (const cf of plan.conflicts) {
      const choice = resolutions[cf.incoming.id] || 'skip';
      if (choice === 'incoming') {
        const ids = new Set(cf.conflicting_main.map(x => x.id));
        newTimeline = newTimeline.filter(x => !ids.has(x.id));
        newTimeline.push(cf.incoming);
      }
      decisions.push({ clip_id: cf.incoming.id, choice });
    }
    newTimeline.sort((a, b) => a.start_sec - b.start_sec);
    const mergeCommit = {
      id: cryptoRandomId(),
      author: 'merge',
      message: `Merge ${c.id} (${c.author})`,
      timestamp: new Date().toISOString(),
      parent: repo.head,
      merged_from: c.id,
      decisions,
      timeline_snapshot: newTimeline,
    };
    repo.commits.push(mergeCommit);
    repo.head = mergeCommit.id;
    repo.main_timeline = newTimeline;
    mockSave(repo);
    return {
      ok: true,
      merge_commit: mergeCommit,
      auto_merged: plan.auto_add.length,
      conflicts_resolved: decisions.length,
      timeline: newTimeline,
    };
  }

  if (method === 'POST' && path === '/api/reset') {
    mockSave({ commits: [], main_timeline: [], head: null });
    return { ok: true };
  }

  throw new Error(`mock: ${method} ${path} not implemented`);
}

// ---------- real API + dispatcher ----------

async function realApi(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `${method} ${path} failed`);
  }
  return res.json();
}

async function api(method, path, body) {
  if (useMock) return mockApi(method, path, body);
  try {
    return await realApi(method, path, body);
  } catch (e) {
    if (!useMock) {
      useMock = true;
      showMockBanner();
      return mockApi(method, path, body);
    }
    throw e;
  }
}

function showMockBanner() { /* disabled — mock is silent */ }

async function fetchRepo({ animateFlyIn = false } = {}) {
  try {
    const next = await api('GET', '/api/repo');
    const prevIds = state.prevMainIds;
    state.repo = next;
    const nextIds = new Set(next.main_timeline.map(c => c.id));
    const newIds = animateFlyIn
      ? next.main_timeline.filter(c => !prevIds.has(c.id)).map(c => c.id)
      : [];
    state.prevMainIds = nextIds;
    renderMain(newIds);
    renderCommits();
  } catch (e) {
    toast(e.message || 'fetch failed', 'err');
  }
}

// ---------- render ----------

function renderRuler(el) {
  el.innerHTML = '';
  const step = 10;
  for (let s = 0; s <= TIMELINE_SECONDS; s += step) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.left = `${s * PX_PER_SEC}px`;
    tick.textContent = `${s}s`;
    el.appendChild(tick);
  }
}

function renderClipEl(clip, opts = {}) {
  const el = document.createElement('div');
  el.className = 'clip';
  if (opts.conflict) el.classList.add('conflict');
  el.style.left = `${clip.start_sec * PX_PER_SEC}px`;
  el.style.width = `${clip.duration_sec * PX_PER_SEC}px`;
  el.dataset.clipId = clip.id;
  el.dataset.owner = clip.owner;

  el.innerHTML = `
    <div>${escapeHtml(clip.name)}</div>
    <div class="meta">${clip.start_sec}s · ${clip.duration_sec}s · ${clip.owner}</div>
  `;
  return el;
}

function renderWorking() {
  const track = document.getElementById('working-track');
  track.innerHTML = '';
  const clips = state.working[state.currentUser];
  const newEls = [];
  for (const clip of clips) {
    const el = renderClipEl(clip);
    attachDrag(el, clip);
    el.addEventListener('click', () => {
      if (el._wasDragging) { el._wasDragging = false; return; }
      openClipModal(clip);
    });
    track.appendChild(el);
    newEls.push(el);
  }
  document.getElementById('who-label').textContent = USERS[state.currentUser].name;

  if (window.gsap && newEls.length) {
    gsap.from(newEls, {
      y: -16, opacity: 0, duration: 0.45,
      stagger: 0.06, ease: 'expo.out',
    });
  }
}

function renderMain(flyInIds = []) {
  const track = document.getElementById('main-track');
  track.innerHTML = '';
  if (!state.repo) return;
  const flyEls = [];
  for (const clip of state.repo.main_timeline) {
    const el = renderClipEl(clip);
    track.appendChild(el);
    if (flyInIds.includes(clip.id)) flyEls.push(el);
  }
  const status = document.getElementById('main-status');
  status.textContent = state.repo.commits.length
    ? `HEAD ${state.repo.head?.slice(0, 7) || '—'} · ${state.repo.main_timeline.length} clip(s)`
    : 'no commits yet';

  if (flyEls.length && window.gsap) {
    gsap.from(flyEls, {
      y: -100, opacity: 0, scale: 0.6, rotation: -4,
      duration: 0.8,
      stagger: 0.08,
      ease: 'elastic.out(1, 0.6)',
    });
  }
}

function renderCommits() {
  const ul = document.getElementById('commit-log');
  ul.innerHTML = '';
  if (!state.repo || !state.repo.commits.length) {
    ul.innerHTML = '<li class="muted" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase">no commits yet. Make changes, commit.</li>';
    return;
  }
  const commits = [...state.repo.commits].reverse();
  const items = [];
  for (const c of commits) {
    const isHead = c.id === state.repo.head;
    const isMerge = c.author === 'merge';
    const li = document.createElement('li');
    li.className = 'commit-item' + (isHead ? ' head' : '');
    li.innerHTML = `
      <div class="commit-row">
        <span class="commit-msg">${escapeHtml(c.message || '(no message)')}</span>
        <span class="commit-hash">${c.id.slice(0, 7)}</span>
      </div>
      <div class="commit-row">
        <span class="commit-author">
          <span class="dot" style="${isMerge ? '' : (c.author === 'alice' ? 'background:#fff' : 'background:#000')}"></span>
          ${escapeHtml(c.author)}
        </span>
        <span class="commit-time">${formatTime(c.timestamp)}</span>
      </div>
    `;
    if (!isHead && !isMerge) {
      const btn = document.createElement('button');
      btn.className = 'commit-merge-btn';
      btn.textContent = 'Merge → main';
      btn.addEventListener('click', () => openMergeModal(c));
      li.appendChild(btn);
    }
    ul.appendChild(li);
    items.push(li);
  }
  if (window.gsap && items.length) {
    gsap.from(items, {
      x: 30, opacity: 0, duration: 0.4,
      stagger: 0.05, ease: 'expo.out',
    });
  }
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[ch]);
}

// ---------- drag ----------

function attachDrag(el, clip) {
  let startX = 0, origStart = 0, dragging = false, moved = false;
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    origStart = clip.start_sec;
    el.classList.add('dragging');
    if (window.gsap) gsap.to(el, { scale: 1.04, duration: 0.15, ease: 'power2.out' });
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    const dSec = Math.round(dx / PX_PER_SEC);
    let next = Math.max(0, origStart + dSec);
    next = Math.min(next, TIMELINE_SECONDS - clip.duration_sec);
    clip.start_sec = next;
    el.style.left = `${clip.start_sec * PX_PER_SEC}px`;
    el.querySelector('.meta').textContent =
      `${clip.start_sec}s · ${clip.duration_sec}s · ${clip.owner}`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    el._wasDragging = moved;
    if (window.gsap) gsap.to(el, { scale: 1, duration: 0.22, ease: 'elastic.out(1, 0.5)' });
    if (moved) persistWorking();
  });
}

// ---------- clip modal ----------

let editingClip = null;

function openClipModal(clip) {
  editingClip = clip;
  document.getElementById('clip-modal-title').textContent =
    clip ? 'Edit clip' : 'New clip';
  document.getElementById('clip-name').value = clip ? clip.name : '';
  document.getElementById('clip-start').value = clip ? clip.start_sec : 0;
  document.getElementById('clip-duration').value = clip ? clip.duration_sec : 5;
  document.getElementById('clip-delete').classList.toggle('hidden', !clip);
  showModal('clip-modal');
  document.getElementById('clip-name').focus();
}

function closeClipModal() {
  editingClip = null;
  hideModal('clip-modal');
}

function saveClipModal() {
  const name = document.getElementById('clip-name').value.trim() || 'untitled';
  const start = Math.max(0, parseInt(document.getElementById('clip-start').value, 10) || 0);
  const duration = Math.max(1, parseInt(document.getElementById('clip-duration').value, 10) || 1);
  if (editingClip) {
    editingClip.name = name;
    editingClip.start_sec = start;
    editingClip.duration_sec = duration;
  } else {
    state.working[state.currentUser].push(
      makeClip(name, start, duration, state.currentUser)
    );
  }
  persistWorking();
  renderWorking();
  closeClipModal();
}

function deleteClipModal() {
  if (!editingClip) return;
  state.working[state.currentUser] =
    state.working[state.currentUser].filter(c => c.id !== editingClip.id);
  persistWorking();
  renderWorking();
  closeClipModal();
}

// ---------- commit ----------

function openCommitModal() {
  const clips = state.working[state.currentUser];
  document.getElementById('commit-summary').textContent =
    `${clips.length} clip(s) on ${USERS[state.currentUser].name}'s timeline`;
  document.getElementById('commit-message').value = '';
  showModal('commit-modal');
  document.getElementById('commit-message').focus();
}

function closeCommitModal() { hideModal('commit-modal'); }

async function confirmCommit() {
  const message = document.getElementById('commit-message').value.trim();
  const clips = state.working[state.currentUser];
  try {
    const out = await api('POST', '/api/commit', {
      author: state.currentUser,
      message: message || `${USERS[state.currentUser].name}'s update`,
      timeline: clips,
    });
    toast(`Committed ${out.commit.id.slice(0,7)}`, 'ok');
    closeCommitModal();
    await fetchRepo();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- merge ----------

async function openMergeModal(commit) {
  try {
    const { plan } = await api('POST', '/api/merge/preview', { commit_id: commit.id });
    state.pendingMerge = {
      commit,
      plan,
      resolutions: Object.fromEntries(
        plan.conflicts.map(cf => [cf.incoming.id, 'incoming'])
      ),
    };
    document.getElementById('merge-commit-label').textContent =
      `${commit.id.slice(0, 7)} (${commit.author})`;
    const summary = document.getElementById('merge-summary');
    summary.innerHTML = `
      <b>${plan.auto_add.length}</b> auto-merge ·
      <b>${plan.conflicts.length}</b> conflict(s)
    `;
    const list = document.getElementById('conflicts-list');
    list.innerHTML = '';
    if (plan.conflicts.length === 0) {
      list.innerHTML = `<p class="muted">clean merge — no overlaps</p>`;
    }
    plan.conflicts.forEach(cf => {
      const row = document.createElement('div');
      row.className = 'conflict-row';
      const main = cf.conflicting_main[0];
      row.innerHTML = `
        <div class="muted" style="margin-bottom:10px">
          conflict @ ${cf.incoming.start_sec}s–${cf.incoming.start_sec + cf.incoming.duration_sec}s
        </div>
        <div class="conflict-pair">
          <div class="mini-clip" data-owner="${cf.incoming.owner}">
            ${escapeHtml(cf.incoming.name)}
            <div class="small">incoming · ${cf.incoming.owner}</div>
          </div>
          <div class="mini-clip" data-owner="${main.owner}">
            ${escapeHtml(main.name)}
            <div class="small">main · ${main.owner}</div>
          </div>
        </div>
        <div class="conflict-choices" data-clip="${cf.incoming.id}">
          <button data-choice="incoming" class="chosen">Take incoming</button>
          <button data-choice="main">Keep main</button>
          <button data-choice="skip">Skip</button>
        </div>
      `;
      list.appendChild(row);
    });

    list.querySelectorAll('.conflict-choices').forEach(group => {
      group.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const clipId = group.dataset.clip;
        state.pendingMerge.resolutions[clipId] = btn.dataset.choice;
        group.querySelectorAll('button').forEach(b => b.classList.remove('chosen'));
        btn.classList.add('chosen');
        if (window.anime) {
          anime({
            targets: btn,
            scale: [1, 1.12, 1],
            duration: 320,
            easing: 'easeOutBack',
          });
        }
      });
    });
    showModal('merge-modal');

    if (window.anime) {
      anime({
        targets: '#conflicts-list .conflict-row',
        translateX: [-30, 0],
        opacity: [0, 1],
        duration: 500,
        delay: anime.stagger(80),
        easing: 'easeOutExpo',
      });
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

function closeMergeModal() {
  state.pendingMerge = null;
  hideModal('merge-modal');
}

async function confirmMerge() {
  if (!state.pendingMerge) return;
  const { commit, resolutions } = state.pendingMerge;
  try {
    const out = await api('POST', '/api/merge', {
      commit_id: commit.id,
      resolutions,
    });
    closeMergeModal();
    await fetchRepo({ animateFlyIn: true });
    toast(
      `merged · ${out.auto_merged} auto, ${out.conflicts_resolved} resolved`,
      'ok'
    );
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- modal helpers ----------

function showModal(id) {
  const m = document.getElementById(id);
  m.classList.remove('hidden');
  if (window.gsap) {
    gsap.fromTo(m, { opacity: 0 }, { opacity: 1, duration: 0.2 });
    gsap.fromTo(
      m.querySelector('.modal-card'),
      { y: 30, scale: 0.94, opacity: 0 },
      { y: 0, scale: 1, opacity: 1, duration: 0.45, ease: 'expo.out' }
    );
  }
}

function hideModal(id) {
  const m = document.getElementById(id);
  if (window.gsap) {
    gsap.to(m.querySelector('.modal-card'), {
      y: 20, scale: 0.96, opacity: 0, duration: 0.2, ease: 'power2.in',
    });
    gsap.to(m, {
      opacity: 0, duration: 0.2,
      onComplete: () => {
        m.classList.add('hidden');
        m.style.opacity = '';
        const card = m.querySelector('.modal-card');
        card.style.transform = '';
        card.style.opacity = '';
      },
    });
  } else {
    m.classList.add('hidden');
  }
}

// ---------- toast ----------

let toastTimer = null;
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (kind || '');
  if (window.gsap) {
    gsap.fromTo(t,
      { y: 30, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.4, ease: 'expo.out' }
    );
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (window.gsap) {
      gsap.to(t, {
        y: 20, opacity: 0, duration: 0.3,
        onComplete: () => t.classList.add('hidden'),
      });
    } else {
      t.classList.add('hidden');
    }
  }, 2600);
}

// ---------- reset ----------

async function resetRepo() {
  if (!confirm('Reset repo? Wipes commits + main timeline.')) return;
  try {
    await api('POST', '/api/reset');
    localStorage.removeItem(LS_PREFIX + 'alice');
    localStorage.removeItem(LS_PREFIX + 'bob');
    state.working.alice = loadWorking('alice');
    state.working.bob = loadWorking('bob');
    state.prevMainIds = new Set();
    renderWorking();
    await fetchRepo();
    toast('repo reset', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- user switch ----------

function switchUser(user) {
  if (state.currentUser === user) return;
  state.currentUser = user;
  document.querySelectorAll('.user-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.user === user);
  });
  if (window.gsap) {
    const ws = document.querySelector('.workspace');
    gsap.fromTo(ws,
      { opacity: 0.2, x: user === 'bob' ? 40 : -40 },
      { opacity: 1, x: 0, duration: 0.5, ease: 'expo.out' }
    );
  }
  renderWorking();
}

// ---------- splash ----------

function runSplash() {
  const splash = document.getElementById('splash');
  const mark = document.getElementById('splash-mark');
  if (!splash || !window.gsap) {
    if (splash) splash.remove();
    return Promise.resolve();
  }
  const letters = splash.querySelectorAll('.splash-letter');

  if (window.anime && mark) {
    anime({
      targets: mark.querySelectorAll('.ray'),
      scale: [0, 1],
      opacity: [0, 1],
      delay: anime.stagger(45, { from: 'center' }),
      duration: 700,
      easing: 'easeOutBack',
    });
    anime({
      targets: mark.querySelector('circle'),
      scale: [0, 1],
      duration: 500,
      easing: 'easeOutBack',
    });
  }

  const tl = gsap.timeline();
  tl.from(letters, {
    y: 220, opacity: 0,
    duration: 0.9, stagger: 0.08, ease: 'expo.out',
  }, 0.3)
  .from('.splash-sub', {
    opacity: 0, y: 20, duration: 0.5, ease: 'expo.out',
  }, '-=0.4')
  .to(mark, {
    rotate: 45, duration: 0.7, ease: 'power3.inOut',
  }, '<')
  .to(splash, {
    opacity: 0, duration: 0.5, ease: 'power2.in',
    onComplete: () => splash.remove(),
  }, '+=0.6');
  return tl;
}

// ---------- scroll reveals + counters ----------

function initScrollFx() {
  if (!window.gsap) return;
  if (window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

  // Lenis smooth scroll
  if (window.Lenis) {
    const lenis = new Lenis({ duration: 1.1, smoothWheel: true });
    function raf(t) { lenis.raf(t); requestAnimationFrame(raf); }
    requestAnimationFrame(raf);
    if (window.ScrollTrigger) {
      lenis.on('scroll', ScrollTrigger.update);
    }
  }

  // Reveal-on-scroll for [data-rev]
  const reveals = document.querySelectorAll('[data-rev]');
  reveals.forEach(el => {
    gsap.set(el, { y: 40, opacity: 0 });
    if (window.ScrollTrigger) {
      ScrollTrigger.create({
        trigger: el,
        start: 'top 88%',
        once: true,
        onEnter: () => gsap.to(el, {
          y: 0, opacity: 1, duration: 0.9, ease: 'expo.out',
        }),
      });
    } else {
      gsap.to(el, { y: 0, opacity: 1, duration: 0.9, ease: 'expo.out' });
    }
  });

  // Animated counters
  document.querySelectorAll('.counter').forEach(el => {
    const target = parseFloat(el.dataset.target);
    const decimals = parseInt(el.dataset.decimals || '0', 10);
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    const obj = { v: 0 };
    const tween = () => gsap.to(obj, {
      v: target,
      duration: 2.0,
      ease: 'expo.out',
      onUpdate: () => {
        el.textContent = prefix + obj.v.toFixed(decimals) + suffix;
      },
    });
    if (window.ScrollTrigger) {
      ScrollTrigger.create({
        trigger: el,
        start: 'top 85%',
        once: true,
        onEnter: tween,
      });
    } else {
      tween();
    }
  });
}

function startLogoIdle() {
  if (!window.anime) return;
  const logo = document.getElementById('logo-mark');
  if (!logo) return;
  anime({
    targets: logo,
    rotate: [0, 360],
    duration: 16000,
    easing: 'linear',
    loop: true,
  });
  anime({
    targets: logo.querySelectorAll('.ray'),
    scale: [
      { value: 1, duration: 0 },
      { value: 1.15, duration: 600 },
      { value: 1, duration: 600 },
    ],
    delay: anime.stagger(120, { from: 'center' }),
    loop: true,
    easing: 'easeInOutSine',
  });
}

// ---------- init ----------

function init() {
  if (useMock) showMockBanner();
  renderRuler(document.getElementById('ruler'));
  renderRuler(document.getElementById('ruler-main'));
  renderWorking();
  fetchRepo();

  runSplash();
  startLogoIdle();
  initScrollFx();

  document.querySelectorAll('.user-btn').forEach(b => {
    b.addEventListener('click', () => switchUser(b.dataset.user));
  });

  document.getElementById('add-clip-btn').addEventListener('click', () => openClipModal(null));
  document.getElementById('commit-btn').addEventListener('click', openCommitModal);
  document.getElementById('reset-btn').addEventListener('click', resetRepo);

  document.getElementById('clip-cancel').addEventListener('click', closeClipModal);
  document.getElementById('clip-save').addEventListener('click', saveClipModal);
  document.getElementById('clip-delete').addEventListener('click', deleteClipModal);

  document.getElementById('commit-cancel').addEventListener('click', closeCommitModal);
  document.getElementById('commit-confirm').addEventListener('click', confirmCommit);

  document.getElementById('merge-cancel').addEventListener('click', closeMergeModal);
  document.getElementById('merge-confirm').addEventListener('click', confirmMerge);

  setInterval(fetchRepo, 3000);

  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m) hideModal(m.id);
    });
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => hideModal(m.id));
    }
  });
}

init();
