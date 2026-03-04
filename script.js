/**
 * TimeLedger Pro — script.js
 * ─────────────────────────────────────────────
 * Architecture:
 *   Auth    → Supabase Auth (email/password) OR Demo mode (localStorage)
 *   Store   → Supabase DB (when online) + localStorage mirror (offline)
 *   State   → single reactive object
 *   UI      → pure DOM functions
 *   Charts  → Chart.js (bar, line, salary, shift-type, mini-week)
 *   Export  → CSV, jsPDF, SheetJS (Excel)
 * ─────────────────────────────────────────────
 *
 * ⚠️  SETUP:
 *  Replace SUPABASE_URL and SUPABASE_ANON_KEY with your project values.
 *  Supabase table needed:
 *
 *  CREATE TABLE work_entries (
 *    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
 *    user_id     uuid REFERENCES auth.users NOT NULL,
 *    day_key     text NOT NULL,           -- "YYYY-MM-DD"
 *    hours       numeric(5,2) NOT NULL,
 *    rate        numeric(6,2) NOT NULL,   -- rate at time of entry
 *    shift_type  text DEFAULT 'normal',   -- normal | overtime | weekend
 *    created_at  timestamptz DEFAULT now(),
 *    UNIQUE(user_id, day_key)
 *  );
 *
 *  ALTER TABLE work_entries ENABLE ROW LEVEL SECURITY;
 *  CREATE POLICY "own_rows" ON work_entries USING (auth.uid() = user_id);
 *
 *  CREATE TABLE user_profiles (
 *    id           uuid REFERENCES auth.users PRIMARY KEY,
 *    full_name    text,
 *    hourly_rate  numeric(6,2) DEFAULT 11,
 *    accent_color text DEFAULT '#4f8dff',
 *    monthly_goal int DEFAULT 160,
 *    role         text DEFAULT 'user',
 *    rate_history jsonb DEFAULT '[]',
 *    notif_time   text DEFAULT '20:00',
 *    created_at   timestamptz DEFAULT now()
 *  );
 *
 *  ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
 *  CREATE POLICY "own_profile" ON user_profiles USING (auth.uid() = id);
 */

'use strict';

/* ═══════════════════════════════════════════
   CONFIG  —  replace with your Supabase creds
═══════════════════════════════════════════ */
const SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';

/* ═══════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════ */
const DEFAULT_RATE = 11;
const LS_PREFIX    = 'tl_';
const MONTHS_BG    = [
  'Януари','Февруари','Март','Април','Май','Юни',
  'Юли','Август','Септември','Октомври','Ноември','Декември'
];
const BADGES_DEF = [
  { id: 'h100',  label: '💪 100+ часа', cls: 'gold',   check: (h) => h >= 100 },
  { id: 'h160',  label: '🏆 160+ часа', cls: 'gold',   check: (h) => h >= 160 },
  { id: 'h200',  label: '🚀 200+ часа', cls: 'purple', check: (h) => h >= 200 },
  { id: 'd20',   label: '📅 20+ дни',   cls: 'green',  check: (h, d) => d >= 20 },
  { id: 'str5',  label: '🔥 5 дни подред', cls: 'gold', check: (h, d, streak) => streak >= 5 },
];

/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
const state = {
  user:        null,   // Supabase user object
  profile:     null,   // user_profiles row
  demoMode:    false,
  isOnline:    navigator.onLine,

  viewYear:    new Date().getFullYear(),
  viewMonth:   new Date().getMonth(),
  darkMode:    true,
  activeTab:   'dashboard',
  activeFilter:'all',
  activeShift: 'normal',  // for hour modal
  modalDay:    null,

  // cached month entries: { "YYYY-MM-DD": { hours, rate, shift_type } }
  entries:     {},

  charts: { bar: null, line: null, salary: null, shift: null, mini: null },
};

/* ═══════════════════════════════════════════
   SUPABASE CLIENT
═══════════════════════════════════════════ */
let sb = null; // will be null if creds not set

function initSupabase() {
  if (SUPABASE_URL.includes('YOUR_PROJECT')) return;
  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.warn('Supabase init failed:', e);
  }
}

/* ═══════════════════════════════════════════
   LOCAL STORE  (offline / demo mirror)
═══════════════════════════════════════════ */
const LS = {
  key(userId, ym) { return `${LS_PREFIX}${userId}_${ym}`; },
  profileKey(userId) { return `${LS_PREFIX}profile_${userId}`; },

  loadEntries(userId, year, month) {
    const ym = ymStr(year, month);
    try {
      const raw = localStorage.getItem(this.key(userId, ym));
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },

  saveEntries(userId, year, month, data) {
    const ym = ymStr(year, month);
    try { localStorage.setItem(this.key(userId, ym), JSON.stringify(data)); }
    catch (e) { console.error('LS.saveEntries:', e); }
  },

  loadProfile(userId) {
    try {
      const raw = localStorage.getItem(this.profileKey(userId));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  saveProfile(userId, profile) {
    try { localStorage.setItem(this.profileKey(userId), JSON.stringify(profile)); }
    catch (e) { console.error('LS.saveProfile:', e); }
  },

  allMonthKeys(userId) {
    const prefix = `${LS_PREFIX}${userId}_`;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix) && !k.includes('profile')) keys.push(k);
    }
    return keys.sort().map(k => k.replace(prefix, ''));
  },

  loadSettings() {
    try { return JSON.parse(localStorage.getItem(`${LS_PREFIX}settings`) || '{}'); }
    catch { return {}; }
  },

  saveSettings(obj) {
    try { localStorage.setItem(`${LS_PREFIX}settings`, JSON.stringify(obj)); }
    catch (e) { console.error(e); }
  },
};

/* ═══════════════════════════════════════════
   SUPABASE DATA OPS
═══════════════════════════════════════════ */
async function dbLoadEntries(year, month) {
  const uid = state.user?.id || 'demo';
  // Always use local mirror for demo or offline
  if (state.demoMode || !sb || !state.isOnline) {
    return LS.loadEntries(uid, year, month);
  }
  try {
    const start = `${year}-${String(month+1).padStart(2,'0')}-01`;
    const end   = `${year}-${String(month+1).padStart(2,'0')}-31`;
    const { data, error } = await sb.from('work_entries')
      .select('day_key,hours,rate,shift_type')
      .eq('user_id', uid)
      .gte('day_key', start)
      .lte('day_key', end);
    if (error) throw error;
    const obj = {};
    (data || []).forEach(r => {
      obj[r.day_key] = { hours: parseFloat(r.hours), rate: parseFloat(r.rate), shift_type: r.shift_type || 'normal' };
    });
    // mirror locally
    LS.saveEntries(uid, year, month, obj);
    return obj;
  } catch (e) {
    console.warn('dbLoadEntries fallback to local:', e);
    return LS.loadEntries(uid, year, month);
  }
}

async function dbSetEntry(dayKey, hours, rate, shift_type) {
  const uid = state.user?.id || 'demo';
  // Update local mirror
  const [y, m] = dayKey.split('-').map(Number);
  const entries = LS.loadEntries(uid, y, m - 1);
  if (hours === 0) {
    delete entries[dayKey];
  } else {
    entries[dayKey] = { hours, rate, shift_type };
  }
  LS.saveEntries(uid, y, m - 1, entries);

  if (state.demoMode || !sb || !state.isOnline) return;
  try {
    if (hours === 0) {
      await sb.from('work_entries').delete().eq('user_id', uid).eq('day_key', dayKey);
    } else {
      await sb.from('work_entries').upsert({
        user_id: uid, day_key: dayKey, hours, rate, shift_type
      }, { onConflict: 'user_id,day_key' });
    }
  } catch (e) { console.warn('dbSetEntry remote failed (will sync later):', e); }
}

async function dbClearMonth(year, month) {
  const uid = state.user?.id || 'demo';
  LS.saveEntries(uid, year, month, {});
  if (state.demoMode || !sb || !state.isOnline) return;
  const ym = ymStr(year, month);
  try {
    await sb.from('work_entries')
      .delete()
      .eq('user_id', uid)
      .like('day_key', `${ym}-%`);
  } catch (e) { console.warn('dbClearMonth remote failed:', e); }
}

async function dbLoadProfile() {
  const uid = state.user?.id || 'demo';
  if (state.demoMode || !sb || !state.isOnline) {
    return LS.loadProfile(uid) || defaultProfile(uid);
  }
  try {
    const { data, error } = await sb.from('user_profiles').select('*').eq('id', uid).single();
    if (error && error.code !== 'PGRST116') throw error;
    const profile = data || defaultProfile(uid);
    LS.saveProfile(uid, profile);
    return profile;
  } catch (e) {
    console.warn('dbLoadProfile fallback:', e);
    return LS.loadProfile(uid) || defaultProfile(uid);
  }
}

function defaultProfile(uid) {
  return {
    id: uid,
    full_name: state.user?.email?.split('@')[0] || 'Потребител',
    hourly_rate: DEFAULT_RATE,
    accent_color: '#4f8dff',
    monthly_goal: 160,
    role: 'user',
    rate_history: [],
    notif_time: '20:00',
  };
}

async function dbSaveProfile(updates) {
  const uid = state.user?.id || 'demo';
  const profile = { ...state.profile, ...updates };
  state.profile = profile;
  LS.saveProfile(uid, profile);
  if (state.demoMode || !sb || !state.isOnline) return;
  try {
    await sb.from('user_profiles').upsert({ id: uid, ...updates });
  } catch (e) { console.warn('dbSaveProfile remote failed:', e); }
}

async function dbAllMonthKeys() {
  const uid = state.user?.id || 'demo';
  if (state.demoMode || !sb || !state.isOnline) {
    return LS.allMonthKeys(uid);
  }
  try {
    const { data, error } = await sb.from('work_entries')
      .select('day_key')
      .eq('user_id', uid)
      .order('day_key', { ascending: true });
    if (error) throw error;
    const yms = new Set((data || []).map(r => r.day_key.substring(0, 7)));
    return [...yms].sort();
  } catch (e) {
    return LS.allMonthKeys(uid);
  }
}

/* ═══════════════════════════════════════════
   UTILS
═══════════════════════════════════════════ */
function ymStr(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function dayKeyStr(year, month, day) {
  return `${ymStr(year, month)}-${String(day).padStart(2, '0')}`;
}

function fmt(n) {
  if (typeof n !== 'number' || isNaN(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function sumHours(entries) {
  return Object.values(entries).reduce((a, v) => a + (v.hours || 0), 0);
}

function sumSalary(entries) {
  return Object.values(entries).reduce((a, v) => a + (v.hours || 0) * (v.rate || DEFAULT_RATE), 0);
}

function countDays(entries) {
  return Object.values(entries).filter(v => v.hours > 0).length;
}

function calcStreak(entries) {
  // Count max consecutive worked days ending today or in current period
  const sorted = Object.keys(entries).sort().reverse();
  let streak = 0;
  let prev = null;
  for (const dk of sorted) {
    if (!entries[dk] || entries[dk].hours <= 0) continue;
    const d = new Date(dk);
    if (prev === null) { streak = 1; prev = d; continue; }
    const diff = (prev - d) / 86400000;
    if (diff === 1) { streak++; prev = d; }
    else break;
  }
  return streak;
}

function filterEntries(entries, filter) {
  if (filter === 'all') return entries;
  return Object.fromEntries(
    Object.entries(entries).filter(([dk, v]) => {
      if (filter === '6')       return v.hours === 6;
      if (filter === '12')      return v.hours === 12;
      if (filter === 'weekend') return v.shift_type === 'weekend';
      if (filter === 'overtime')return v.shift_type === 'overtime';
      return true;
    })
  );
}

function toast(msg, type = 'info', duration = 3000) {
  const tc = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  tc.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 280);
  }, duration);
}

function animateValue(el, value) {
  el.classList.remove('animating');
  void el.offsetWidth;
  el.classList.add('animating');
  el.textContent = value;
}

/* ═══════════════════════════════════════════
   AUTH
═══════════════════════════════════════════ */
async function loginUser(email, password) {
  if (!sb) return { error: { message: 'Supabase не е конфигуриран. Използвай Демо режим.' } };
  return sb.auth.signInWithPassword({ email, password });
}

async function registerUser(email, password, name, rate) {
  if (!sb) return { error: { message: 'Supabase не е конфигуриран.' } };
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error || !data.user) return { error };
  // Create profile
  await sb.from('user_profiles').insert({
    id: data.user.id,
    full_name: name,
    hourly_rate: rate,
    accent_color: '#4f8dff',
    monthly_goal: 160,
    role: 'user',
    rate_history: [{ rate, date: new Date().toISOString().split('T')[0] }],
  });
  return { data };
}

async function logoutUser() {
  if (sb) await sb.auth.signOut();
  state.user    = null;
  state.profile = null;
  state.demoMode = false;
  showAuthScreen();
}

function enterDemoMode() {
  state.demoMode = true;
  state.user = { id: 'demo', email: 'demo@timeleger.local' };
  state.profile = {
    id: 'demo',
    full_name: 'Демо Потребител',
    hourly_rate: DEFAULT_RATE,
    accent_color: '#4f8dff',
    monthly_goal: 160,
    role: 'user',
    rate_history: [{ rate: DEFAULT_RATE, date: new Date().toISOString().split('T')[0] }],
    notif_time: '20:00',
  };
  bootApp();
}

/* ═══════════════════════════════════════════
   SCREEN MANAGEMENT
═══════════════════════════════════════════ */
function showAuthScreen() {
  document.getElementById('authScreen').style.display = '';
  document.getElementById('appShell').setAttribute('hidden', '');
}

function showApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appShell').removeAttribute('hidden');
}

/* ═══════════════════════════════════════════
   BOOT APP (after login)
═══════════════════════════════════════════ */
async function bootApp() {
  showApp();
  state.profile = await dbLoadProfile();
  applyAccentColor(state.profile.accent_color || '#4f8dff');
  renderProfile();
  await loadCurrentEntries();
  switchTab('dashboard');
  scheduleNotifCheck();
}

async function loadCurrentEntries() {
  state.entries = await dbLoadEntries(state.viewYear, state.viewMonth);
}

/* ═══════════════════════════════════════════
   ACCENT COLOR
═══════════════════════════════════════════ */
function applyAccentColor(color) {
  // Parse hex to rgb
  const r = parseInt(color.slice(1,3),16);
  const g = parseInt(color.slice(3,5),16);
  const b = parseInt(color.slice(5,7),16);
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-rgb', `${r},${g},${b}`);
  // Update avatars
  document.querySelectorAll('.user-avatar, .profile-avatar').forEach(el => {
    el.style.background = color;
    el.style.borderColor = `rgba(${r},${g},${b},0.4)`;
  });
}

/* ═══════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════ */
async function renderDashboard() {
  const filtered = filterEntries(state.entries, state.activeFilter);
  const total  = sumHours(filtered);
  const salary = sumSalary(state.entries); // salary always from all entries (unfiltered)
  const days   = countDays(filtered);
  const avg    = days > 0 ? total / days : 0;

  animateValue(document.getElementById('statHours'),  fmt(total));
  animateValue(document.getElementById('statSalary'), `${fmt(salary)} лв.`);
  animateValue(document.getElementById('statDays'),   days);
  animateValue(document.getElementById('statAvg'),    fmt(avg));

  const rate = state.profile?.hourly_rate || DEFAULT_RATE;
  document.getElementById('statRateSub').textContent = `при ${fmt(rate)} лв./час`;
  document.getElementById('dashMonthLabel').textContent = `${MONTHS_BG[state.viewMonth]} ${state.viewYear}`;

  renderGoalProgress(total);
  renderBadges(total, days);
  renderMiniChart();
}

/* ── Goal Progress ── */
function renderGoalProgress(total) {
  const goal = state.profile?.monthly_goal || 160;
  const pct  = Math.min(100, (total / goal) * 100);
  document.getElementById('goalFill').style.width  = pct + '%';
  document.getElementById('goalPct').textContent   = pct.toFixed(1) + '%';
  document.getElementById('goalValue').textContent = `${fmt(total)} / ${goal} ч`;
}

/* ── Badges ── */
function renderBadges(totalHours, totalDays) {
  const streak = calcStreak(state.entries);
  const row = document.getElementById('badgesRow');
  row.innerHTML = '';
  BADGES_DEF.forEach((b, i) => {
    if (b.check(totalHours, totalDays, streak)) {
      const el = document.createElement('div');
      el.className = `badge ${b.cls}`;
      el.textContent = b.label;
      el.style.animationDelay = `${i * 0.08}s`;
      row.appendChild(el);
    }
  });
}

/* ── Mini week chart ── */
function renderMiniChart() {
  const today = new Date();
  const labels = [];
  const values = [];
  // last 7 days
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    labels.push(dk.slice(8)); // day number
    const entry = state.entries[dk];
    values.push(entry ? entry.hours : 0);
  }

  const ctx = document.getElementById('weekMiniChart');
  if (!ctx) return;
  if (state.charts.mini) state.charts.mini.destroy();

  const isDark = document.body.classList.contains('dark-mode');
  state.charts.mini = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map(v => v > 0 ? 'rgba(79,141,255,0.7)' : 'rgba(255,255,255,0.05)'),
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.raw}ч` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: isDark ? '#7777aa' : '#5555aa', font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
             ticks: { color: isDark ? '#7777aa' : '#5555aa', font: { size: 10 } } }
      }
    }
  });
}

/* ═══════════════════════════════════════════
   CALENDAR
═══════════════════════════════════════════ */
function renderCalendar() {
  const { viewYear: year, viewMonth: month } = state;
  const today = new Date();

  document.getElementById('calMonthLabel').textContent = `${MONTHS_BG[month]} ${year}`;

  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const firstDow = (() => {
    let d = new Date(year, month, 1).getDay();
    return d === 0 ? 6 : d - 1; // Mon=0
  })();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Empty cells
  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'cal-day empty';
    grid.appendChild(el);
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dk     = dayKeyStr(year, month, d);
    const entry  = state.entries[dk];
    const hrs    = entry?.hours || 0;
    const shift  = entry?.shift_type || 'normal';
    const dow    = new Date(year, month, d).getDay(); // 0=Sun,6=Sat
    const isWeekend = (dow === 0 || dow === 6);
    const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;

    const cell = document.createElement('div');
    let cls = 'cal-day';
    if (hrs > 0) cls += ' worked';
    if (isToday) cls += ' today';
    if (isWeekend && hrs === 0) cls += ' weekend-day';
    if (shift === 'overtime' && hrs > 0) cls += ' overtime-day';
    cell.className = cls;
    cell.dataset.key = dk;

    const numEl = document.createElement('div');
    numEl.className = 'day-num';
    numEl.textContent = d;
    cell.appendChild(numEl);

    if (hrs > 0) {
      const hEl = document.createElement('div');
      hEl.className = 'day-hours';
      hEl.textContent = fmt(hrs) + 'ч';
      cell.appendChild(hEl);

      // shift dot
      const dot = document.createElement('div');
      dot.className = `day-shift-dot dot-${shift}`;
      cell.appendChild(dot);
    }

    cell.addEventListener('click', () => openHourModal(dk, d));
    grid.appendChild(cell);
  }
}

/* ═══════════════════════════════════════════
   HOUR MODAL
═══════════════════════════════════════════ */
function openHourModal(dk, dayNum) {
  state.modalDay = dk;
  const [y, m] = dk.split('-').map(Number);
  const entry = state.entries[dk];
  const existing = entry?.hours || 0;
  const curShift = entry?.shift_type || 'normal';

  document.getElementById('modalTitle').textContent = existing > 0 ? `Редактирай — ${fmt(existing)}ч` : 'Добави часове';
  document.getElementById('modalDate').textContent  = `${dayNum} ${MONTHS_BG[m - 1]} ${y}`;

  // Shift tags
  state.activeShift = curShift;
  document.querySelectorAll('.shift-tag').forEach(t => {
    t.classList.toggle('active', t.dataset.shift === curShift);
  });

  document.getElementById('customHours').value = existing > 0 ? existing : '';
  const rate = state.profile?.hourly_rate || DEFAULT_RATE;
  document.getElementById('modalRateNote').textContent = `Ставка: ${fmt(rate)} лв./час`;

  document.getElementById('hourModal').removeAttribute('hidden');
  setTimeout(() => document.getElementById('customHours').focus(), 50);
}

function closeHourModal() {
  document.getElementById('hourModal').setAttribute('hidden', '');
  state.modalDay = null;
}

async function saveHours(hours) {
  if (!state.modalDay) return;
  const dk = state.modalDay;
  const parsed = parseFloat(hours);
  if (isNaN(parsed) || parsed < 0 || parsed > 24) {
    toast('Въведи стойност между 0 и 24', 'error');
    return;
  }
  const rate = state.profile?.hourly_rate || DEFAULT_RATE;
  await dbSetEntry(dk, parsed, rate, state.activeShift);
  state.entries = await dbLoadEntries(state.viewYear, state.viewMonth);
  closeHourModal();
  await refreshAll();
  toast(`✓ Записано ${fmt(parsed)}ч за ${dk}`, 'success');
}

/* ═══════════════════════════════════════════
   HISTORY
═══════════════════════════════════════════ */
async function populateHistorySelect() {
  const sel  = document.getElementById('historySelect');
  const keys = await dbAllMonthKeys();
  const curYM = ymStr(state.viewYear, state.viewMonth);
  const set = new Set([...keys, curYM]);
  const sorted = [...set].sort().reverse();

  sel.innerHTML = '';
  sorted.forEach(ym => {
    const opt = document.createElement('option');
    opt.value = ym;
    opt.textContent = monthLabelFromYM(ym);
    sel.appendChild(opt);
  });

  renderHistoryDetail(sorted[0] || curYM);
}

function monthLabelFromYM(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_BG[m - 1]} ${y}`;
}

async function renderHistoryDetail(ym) {
  if (!ym) return;
  const [y, m] = ym.split('-').map(Number);
  const entries = await dbLoadEntries(y, m - 1);
  const total   = sumHours(entries);
  const salary  = sumSalary(entries);
  const days    = countDays(entries);
  const detail  = document.getElementById('historyDetail');

  if (days === 0) {
    detail.innerHTML = '<p class="empty-state">Няма данни за избрания месец.</p>';
    return;
  }

  const sorted = Object.keys(entries).sort();
  const rows = sorted.map(dk => {
    const d = parseInt(dk.split('-')[2], 10);
    const v = entries[dk];
    const shiftLabel = { normal: '—', overtime: '🔴 Извън.', weekend: '🟣 Уикенд' }[v.shift_type] || '—';
    return `<tr>
      <td>${d} ${MONTHS_BG[m-1]} ${y}</td>
      <td>${fmt(v.hours)} ч</td>
      <td>${fmt(v.rate || DEFAULT_RATE)} лв.</td>
      <td>${fmt(v.hours * (v.rate || DEFAULT_RATE))} лв.</td>
      <td>${shiftLabel}</td>
    </tr>`;
  }).join('');

  detail.innerHTML = `
    <div class="history-stats">
      <div class="history-stat"><div class="hs-label">Общо часове</div><div class="hs-value">${fmt(total)}</div></div>
      <div class="history-stat"><div class="hs-label">Заплата</div><div class="hs-value">${fmt(salary)} лв.</div></div>
      <div class="history-stat"><div class="hs-label">Работни дни</div><div class="hs-value">${days}</div></div>
      <div class="history-stat"><div class="hs-label">Среден</div><div class="hs-value">${fmt(days > 0 ? total/days : 0)} ч/ден</div></div>
    </div>
    <table class="history-table">
      <thead><tr><th>Дата</th><th>Часове</th><th>Ставка</th><th>Заплата</th><th>Смяна</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ═══════════════════════════════════════════
   CHARTS
═══════════════════════════════════════════ */
async function renderCharts() {
  renderBarChart();
  await renderLineChart();
  renderMiniChart();
}

function chartBaseOpts(xLabel, yLabel) {
  const isDark = document.body.classList.contains('dark-mode');
  const grid  = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  const tick  = isDark ? '#7777aa' : '#5555aa';
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: isDark ? '#141428' : '#fff',
        titleColor: isDark ? '#eeeef8' : '#0f0f20',
        bodyColor: tick,
        borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
        borderWidth: 1,
        cornerRadius: 8,
      }
    },
    scales: {
      x: { grid: { color: grid }, ticks: { color: tick, font: { family: "'JetBrains Mono', monospace", size: 10 } } },
      y: { beginAtZero: true, grid: { color: grid }, ticks: { color: tick, font: { family: "'JetBrains Mono', monospace", size: 10 } } }
    }
  };
}

function renderBarChart() {
  const { viewYear: year, viewMonth: month } = state;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const labels = [], values = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dk = dayKeyStr(year, month, d);
    const h = state.entries[dk]?.hours || 0;
    if (h > 0) { labels.push(String(d)); values.push(h); }
  }
  const ctx = document.getElementById('barChart');
  if (state.charts.bar) state.charts.bar.destroy();
  state.charts.bar = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Часове', data: values, backgroundColor: 'rgba(79,141,255,0.75)', borderColor: '#4f8dff', borderWidth: 2, borderRadius: 6 }] },
    options: chartBaseOpts('Ден', 'Часове'),
  });
}

async function renderLineChart() {
  const yms = await dbAllMonthKeys();
  const labels = [], valH = [], valS = [];
  for (const ym of yms) {
    const [y, m] = ym.split('-').map(Number);
    const entries = await dbLoadEntries(y, m - 1);
    labels.push(monthLabelFromYM(ym).slice(0, 3));
    valH.push(sumHours(entries));
    valS.push(sumSalary(entries));
  }

  const ctxL = document.getElementById('lineChart');
  if (state.charts.line) state.charts.line.destroy();
  state.charts.line = new Chart(ctxL, {
    type: 'line',
    data: { labels, datasets: [{
      label: 'Часове', data: valH, borderColor: '#3ecf8e',
      backgroundColor: 'rgba(62,207,142,0.10)', borderWidth: 2.5,
      pointBackgroundColor: '#3ecf8e', pointRadius: 5, tension: 0.4, fill: true,
    }]},
    options: chartBaseOpts('Месец', 'Часове'),
  });

  const ctxS = document.getElementById('salaryChart');
  if (state.charts.salary) state.charts.salary.destroy();
  state.charts.salary = new Chart(ctxS, {
    type: 'bar',
    data: { labels, datasets: [{
      label: 'Заплата', data: valS, backgroundColor: 'rgba(176,139,255,0.7)',
      borderColor: '#b08bff', borderWidth: 2, borderRadius: 6
    }]},
    options: chartBaseOpts('Месец', 'лв.'),
  });

  // Shift type pie
  const shiftCounts = { normal: 0, overtime: 0, weekend: 0 };
  Object.values(state.entries).forEach(v => { if (shiftCounts[v.shift_type] !== undefined) shiftCounts[v.shift_type]++; });
  const ctxP = document.getElementById('shiftChart');
  if (state.charts.shift) state.charts.shift.destroy();
  state.charts.shift = new Chart(ctxP, {
    type: 'doughnut',
    data: {
      labels: ['Нормален', 'Извънреден', 'Уикенд'],
      datasets: [{ data: [shiftCounts.normal, shiftCounts.overtime, shiftCounts.weekend],
        backgroundColor: ['rgba(79,141,255,0.8)', 'rgba(255,92,122,0.8)', 'rgba(176,139,255,0.8)'],
        borderColor: ['#4f8dff', '#ff5c7a', '#b08bff'], borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: document.body.classList.contains('dark-mode') ? '#7777aa' : '#5555aa', font: { size: 11 } } } }
    },
  });
}

/* ═══════════════════════════════════════════
   PROFILE
═══════════════════════════════════════════ */
function renderProfile() {
  if (!state.profile) return;
  const p = state.profile;
  const initials = (p.full_name || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);

  document.querySelectorAll('.user-avatar').forEach(el => el.textContent = initials);
  const pa = document.getElementById('profileAvatar');
  if (pa) pa.textContent = initials;

  const pn = document.getElementById('profileName');
  if (pn) pn.textContent = p.full_name || '—';
  const pe = document.getElementById('profileEmail');
  if (pe) pe.textContent = state.user?.email || '—';
  const pr = document.getElementById('profileRole');
  if (pr) pr.textContent = p.role === 'manager' ? '👔 Мениджър' : '👤 Потребител';

  const rateEl = document.getElementById('currentRateDisplay');
  if (rateEl) rateEl.textContent = `${fmt(p.hourly_rate || DEFAULT_RATE)} лв./час`;

  const goalInput = document.getElementById('goalInput');
  if (goalInput) goalInput.value = p.monthly_goal || 160;

  // Rate history
  const rhList = document.getElementById('rateHistoryList');
  if (rhList) {
    const history = Array.isArray(p.rate_history) ? p.rate_history : [];
    if (history.length === 0) {
      rhList.innerHTML = '<div class="rate-history-item"><span>Няма история</span></div>';
    } else {
      rhList.innerHTML = [...history].reverse().slice(0, 6).map(h =>
        `<div class="rate-history-item"><span>${h.date}</span><span>${fmt(h.rate)} лв./час</span></div>`
      ).join('');
    }
  }

  // Highlight active color swatch
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === p.accent_color);
  });

  // Notif time
  const ntEl = document.getElementById('reminderTime');
  if (ntEl) ntEl.value = p.notif_time || '20:00';

  // Notif status
  const ns = document.getElementById('notifStatus');
  if (ns) {
    if ('Notification' in window) {
      const perm = Notification.permission;
      ns.textContent = perm === 'granted' ? '✅ Известията са активирани' :
                       perm === 'denied'  ? '❌ Известията са блокирани' :
                                            '⚪ Известията не са активирани';
    } else {
      ns.textContent = '⚠️ Браузърът не поддържа известия';
    }
  }
}

async function saveRate(newRate) {
  const r = parseFloat(newRate);
  if (isNaN(r) || r <= 0) { toast('Невалидна ставка', 'error'); return; }
  const history = Array.isArray(state.profile?.rate_history) ? state.profile.rate_history : [];
  history.push({ rate: r, date: new Date().toISOString().split('T')[0] });
  await dbSaveProfile({ hourly_rate: r, rate_history: history });
  renderProfile();
  toast(`✓ Ставката е обновена: ${fmt(r)} лв./час`, 'success');
}

async function saveGoal(goal) {
  const g = parseInt(goal);
  if (isNaN(g) || g < 1) { toast('Невалидна цел', 'error'); return; }
  await dbSaveProfile({ monthly_goal: g });
  renderProfile();
  await renderDashboard();
  toast(`✓ Месечна цел: ${g} ч`, 'success');
}

/* ═══════════════════════════════════════════
   EXPORT — CSV
═══════════════════════════════════════════ */
function exportCSV() {
  const { viewYear: year, viewMonth: month } = state;
  const entries = state.entries;
  const ym = ymStr(year, month);
  const total  = sumHours(entries);
  const salary = sumSalary(entries);

  let csv = '\uFEFFДата,Часове,Ставка (лв.),Заплата (лв.),Тип смяна\n';
  Object.keys(entries).sort().forEach(dk => {
    const v = entries[dk];
    const shiftBG = { normal: 'Нормален', overtime: 'Извънреден', weekend: 'Уикенд' }[v.shift_type] || 'Нормален';
    csv += `${dk},${fmt(v.hours)},${fmt(v.rate || DEFAULT_RATE)},${fmt(v.hours*(v.rate||DEFAULT_RATE))},${shiftBG}\n`;
  });
  csv += `\nОБЩО,${fmt(total)},,${fmt(salary)},\n`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `work-hours-${ym}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
  toast('✓ CSV изтеглен', 'success');
}

/* ═══════════════════════════════════════════
   EXPORT — PDF
═══════════════════════════════════════════ */
function exportPDF() {
  try {
    const { jsPDF } = window.jspdf;
    const { viewYear: year, viewMonth: month } = state;
    const entries = state.entries;
    const ym = ymStr(year, month);
    const total  = sumHours(entries);
    const salary = sumSalary(entries);
    const monthName = `${MONTHS_BG[month]} ${year}`;
    const sorted = Object.keys(entries).sort();
    const userName = state.profile?.full_name || 'Потребител';

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    // Header background
    doc.setFillColor(10, 10, 20);
    doc.rect(0, 0, 210, 45, 'F');

    // Logo area
    doc.setTextColor(232, 232, 240);
    doc.setFontSize(20); doc.setFont('helvetica', 'bold');
    doc.text('TimeLedger Pro', 14, 18);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.setTextColor(119, 119, 170);
    doc.text(`Отчет за работни часове — ${monthName}`, 14, 27);
    doc.text(`Потребител: ${userName}  |  Генериран: ${new Date().toLocaleDateString('bg-BG')}`, 14, 34);

    // Accent line
    doc.setFillColor(79, 141, 255);
    doc.rect(0, 43, 210, 2, 'F');

    // Summary cards
    const boxes = [
      { label: 'Общо часове', value: `${fmt(total)} ч`, color: [79,141,255] },
      { label: 'Заплата',     value: `${fmt(salary)} лв.`, color: [62,207,142] },
      { label: 'Работни дни', value: countDays(entries), color: [255,179,71] },
    ];
    let bx = 14;
    boxes.forEach(b => {
      doc.setFillColor(22, 22, 40);
      doc.roundedRect(bx, 50, 58, 22, 4, 4, 'F');
      doc.setDrawColor(...b.color); doc.setLineWidth(0.5);
      doc.roundedRect(bx, 50, 58, 22, 4, 4, 'S');
      doc.setFontSize(7); doc.setFont('helvetica', 'normal');
      doc.setTextColor(119,119,170);
      doc.text(b.label, bx + 4, 56);
      doc.setFontSize(14); doc.setFont('helvetica', 'bold');
      doc.setTextColor(...b.color);
      doc.text(String(b.value), bx + 4, 67);
      bx += 62;
    });

    // Table header
    const tt = 80;
    doc.setFillColor(20, 20, 40);
    doc.rect(14, tt, 182, 8, 'F');
    doc.setTextColor(160,160,200); doc.setFontSize(8); doc.setFont('helvetica','bold');
    doc.text('Дата',18,tt+5.5); doc.text('Часове',70,tt+5.5);
    doc.text('Ставка',100,tt+5.5); doc.text('Заплата',132,tt+5.5); doc.text('Смяна',168,tt+5.5);

    let ty = tt + 8;
    const shiftLabel = { normal:'Нормален', overtime:'Извънреден', weekend:'Уикенд' };
    sorted.forEach((dk, i) => {
      const v = entries[dk];
      if (i % 2 === 0) { doc.setFillColor(16,16,30); doc.rect(14,ty,182,7,'F'); }
      doc.setTextColor(200,200,220); doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
      doc.text(dk,18,ty+4.8);
      doc.text(`${fmt(v.hours)} ч`,70,ty+4.8);
      doc.text(`${fmt(v.rate||DEFAULT_RATE)} лв.`,100,ty+4.8);
      doc.text(`${fmt(v.hours*(v.rate||DEFAULT_RATE))} лв.`,132,ty+4.8);
      doc.text(shiftLabel[v.shift_type]||'Нормален',168,ty+4.8);
      ty += 7;
      if (ty > 272) { doc.addPage(); ty = 20; }
    });

    // Footer
    ty += 3;
    doc.setDrawColor(79,141,255); doc.setLineWidth(0.5); doc.line(14,ty,196,ty);
    ty += 7;
    doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(79,141,255);
    doc.text(`ОБЩО: ${fmt(total)} ч = ${fmt(salary)} лв.`, 18, ty);

    doc.save(`work-hours-${ym}.pdf`);
    toast('✓ PDF изтеглен', 'success');
  } catch(e) {
    console.error(e);
    toast('Грешка при PDF генерирането', 'error');
  }
}

/* ═══════════════════════════════════════════
   EXPORT — EXCEL
═══════════════════════════════════════════ */
function exportXLSX() {
  try {
    const { viewYear: year, viewMonth: month } = state;
    const entries = state.entries;
    const ym = ymStr(year, month);
    const monthName = `${MONTHS_BG[month]} ${year}`;
    const sorted = Object.keys(entries).sort();

    const wsData = [
      ['TimeLedger Pro — Отчет за работни часове'],
      [`Месец: ${monthName}  |  Потребител: ${state.profile?.full_name || 'Потребител'}`],
      [],
      ['Дата', 'Часове', 'Ставка (лв./ч)', 'Заплата (лв.)', 'Тип смяна'],
    ];

    const shiftLabel = { normal:'Нормален', overtime:'Извънреден', weekend:'Уикенд' };
    sorted.forEach(dk => {
      const v = entries[dk];
      wsData.push([dk, v.hours, v.rate||DEFAULT_RATE, v.hours*(v.rate||DEFAULT_RATE), shiftLabel[v.shift_type]||'Нормален']);
    });

    wsData.push([]);
    wsData.push(['ОБЩО', sumHours(entries), '', sumSalary(entries), '']);

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [{ wch:14 }, { wch:10 }, { wch:14 }, { wch:14 }, { wch:14 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, monthName);
    XLSX.writeFile(wb, `work-hours-${ym}.xlsx`);
    toast('✓ Excel изтеглен', 'success');
  } catch(e) {
    console.error(e);
    toast('Грешка при Excel генерирането', 'error');
  }
}

/* ═══════════════════════════════════════════
   PUSH NOTIFICATIONS
═══════════════════════════════════════════ */
async function enableNotifications() {
  if (!('Notification' in window)) { toast('Браузърът не поддържа известия', 'error'); return; }
  const perm = await Notification.requestPermission();
  renderProfile();
  if (perm === 'granted') {
    toast('✓ Известията са активирани', 'success');
    scheduleNotifCheck();
  } else {
    toast('Известията са отказани', 'error');
  }
}

function scheduleNotifCheck() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Check every hour if we need to send a reminder
  setInterval(checkMissedDay, 3600 * 1000);
  checkMissedDay();
}

function checkMissedDay() {
  if (Notification.permission !== 'granted') return;
  const notifTime = state.profile?.notif_time || '20:00';
  const [hh, mm] = notifTime.split(':').map(Number);
  const now = new Date();
  // Only fire around reminder time (within ±30min)
  if (Math.abs(now.getHours() - hh) > 0 || now.getMinutes() < mm - 30) return;

  // Check if yesterday has no entry
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yk = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
  const entry = state.entries[yk];
  if (!entry || entry.hours <= 0) {
    new Notification('TimeLedger Pro ⏱', {
      body: `Не си добавил часове за ${yk}. Провери дали всичко е записано.`,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
    });
  }
}

/* ═══════════════════════════════════════════
   RESET MONTH
═══════════════════════════════════════════ */
function confirmReset() {
  const label = `${MONTHS_BG[state.viewMonth]} ${state.viewYear}`;
  document.getElementById('confirmMsg').textContent =
    `Сигурни ли сте, че искате да изтриете всички данни за ${label}? Тази операция е необратима.`;
  document.getElementById('confirmModal').removeAttribute('hidden');
}

async function doReset() {
  await dbClearMonth(state.viewYear, state.viewMonth);
  document.getElementById('confirmModal').setAttribute('hidden', '');
  state.entries = {};
  await refreshAll();
  toast('✓ Месецът е нулиран', 'info');
}

/* ═══════════════════════════════════════════
   TABS
═══════════════════════════════════════════ */
async function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-section').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tabId}`).classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${tabId}"]`).classList.add('active');

  if (tabId === 'dashboard') await renderDashboard();
  if (tabId === 'calendar')  renderCalendar();
  if (tabId === 'history')   await populateHistorySelect();
  if (tabId === 'charts')    await renderCharts();
  if (tabId === 'profile')   renderProfile();
}

/* ═══════════════════════════════════════════
   THEME
═══════════════════════════════════════════ */
function applyTheme(dark) {
  state.darkMode = dark;
  document.body.classList.toggle('dark-mode',  dark);
  document.body.classList.toggle('light-mode', !dark);
  document.getElementById('darkToggle').textContent = dark ? '🌙' : '☀️';
  LS.saveSettings({ ...LS.loadSettings(), darkMode: dark });
}

/* ═══════════════════════════════════════════
   MONTH NAVIGATION
═══════════════════════════════════════════ */
async function changeMonth(delta) {
  let m = state.viewMonth + delta;
  let y = state.viewYear;
  if (m > 11) { m = 0;  y++; }
  if (m < 0)  { m = 11; y--; }
  state.viewMonth = m;
  state.viewYear  = y;
  state.entries = await dbLoadEntries(y, m);
  await refreshAll();
}

/* ═══════════════════════════════════════════
   REFRESH
═══════════════════════════════════════════ */
async function refreshAll() {
  if (state.activeTab === 'dashboard' || true) await renderDashboard();
  renderCalendar();
  if (state.activeTab === 'charts')  await renderCharts();
  if (state.activeTab === 'history') await populateHistorySelect();
}

/* ═══════════════════════════════════════════
   TOUCH SWIPE (calendar month navigation)
═══════════════════════════════════════════ */
function addSwipeSupport(el) {
  let startX = 0;
  el.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 60) changeMonth(dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* ═══════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════ */
function wireAuthEvents() {
  // Tab switcher
  document.querySelectorAll('.auth-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById(`auth${t.dataset.auth.charAt(0).toUpperCase()}${t.dataset.auth.slice(1)}`).classList.add('active');
    });
  });

  // Login
  document.getElementById('loginBtn').addEventListener('click', async () => {
    const btn = document.getElementById('loginBtn');
    const email = document.getElementById('loginEmail').value.trim();
    const pass  = document.getElementById('loginPassword').value;
    const msg   = document.getElementById('authMsg');
    if (!email || !pass) { msg.textContent = 'Попълни всички полета.'; msg.className = 'auth-msg error'; return; }
    btn.innerHTML = '<span class="spinner"></span>';
    const { error } = await loginUser(email, pass);
    if (error) {
      msg.textContent = error.message;
      msg.className = 'auth-msg error';
      btn.textContent = 'Влез в акаунта';
    } else {
      const { data: { user } } = await sb.auth.getUser();
      state.user = user;
      await bootApp();
    }
  });

  // Register
  document.getElementById('registerBtn').addEventListener('click', async () => {
    const btn   = document.getElementById('registerBtn');
    const name  = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const pass  = document.getElementById('regPassword').value;
    const rate  = parseFloat(document.getElementById('regRate').value) || DEFAULT_RATE;
    const msg   = document.getElementById('authMsg');
    if (!name || !email || !pass) { msg.textContent = 'Попълни всички полета.'; msg.className = 'auth-msg error'; return; }
    btn.innerHTML = '<span class="spinner"></span>';
    const { error } = await registerUser(email, pass, name, rate);
    if (error) {
      msg.textContent = error.message;
      msg.className = 'auth-msg error';
      btn.textContent = 'Създай акаунт';
    } else {
      msg.textContent = '✓ Акаунтът е създаден! Провери имейла си за потвърждение.';
      msg.className = 'auth-msg success';
      btn.textContent = 'Създай акаунт';
    }
  });

  // Demo
  document.getElementById('demoBtn').addEventListener('click', enterDemoMode);
}

function wireAppEvents() {
  // Nav tabs
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Dark mode
  document.getElementById('darkToggle').addEventListener('click', () => applyTheme(!state.darkMode));

  // Month nav (calendar)
  document.getElementById('prevMonth').addEventListener('click', () => changeMonth(-1));
  document.getElementById('nextMonth').addEventListener('click', () => changeMonth(+1));

  // Dashboard month nav
  document.getElementById('dashPrev').addEventListener('click', () => changeMonth(-1));
  document.getElementById('dashNext').addEventListener('click', () => changeMonth(+1));

  // Shift tags in modal
  document.querySelectorAll('.shift-tag').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.shift-tag').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      state.activeShift = t.dataset.shift;
    });
  });

  // Hour presets
  document.querySelectorAll('.hour-preset').forEach(btn => {
    btn.addEventListener('click', () => saveHours(Number(btn.dataset.hours)));
  });

  // Custom hour save
  document.getElementById('customSave').addEventListener('click', () =>
    saveHours(document.getElementById('customHours').value));
  document.getElementById('customHours').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveHours(e.target.value);
  });

  // Clear day
  document.getElementById('clearDay').addEventListener('click', async () => {
    if (!state.modalDay) return;
    await dbSetEntry(state.modalDay, 0, 0, 'normal');
    state.entries = await dbLoadEntries(state.viewYear, state.viewMonth);
    closeHourModal();
    await refreshAll();
  });

  // Close hour modal
  document.getElementById('closeModal').addEventListener('click', closeHourModal);
  document.getElementById('hourModal').addEventListener('click', e => {
    if (e.target === document.getElementById('hourModal')) closeHourModal();
  });

  // Exports
  document.getElementById('exportCSV').addEventListener('click', exportCSV);
  document.getElementById('exportPDF').addEventListener('click', exportPDF);
  document.getElementById('exportXLSX').addEventListener('click', exportXLSX);

  // Reset month
  document.getElementById('resetMonth').addEventListener('click', confirmReset);
  document.getElementById('confirmOK').addEventListener('click', doReset);
  document.getElementById('confirmCancel').addEventListener('click', () =>
    document.getElementById('confirmModal').setAttribute('hidden',''));
  document.getElementById('confirmModal').addEventListener('click', e => {
    if (e.target === document.getElementById('confirmModal'))
      document.getElementById('confirmModal').setAttribute('hidden','');
  });

  // History selector
  document.getElementById('historySelect').addEventListener('change', e => renderHistoryDetail(e.target.value));

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(x => x.classList.remove('active'));
      chip.classList.add('active');
      state.activeFilter = chip.dataset.filter;
      renderDashboard();
    });
  });

  // Goal edit button
  document.getElementById('editGoalBtn').addEventListener('click', () => {
    document.getElementById('goalModalInput').value = state.profile?.monthly_goal || 160;
    document.getElementById('goalModal').removeAttribute('hidden');
  });
  document.getElementById('goalModalSave').addEventListener('click', () => {
    saveGoal(document.getElementById('goalModalInput').value);
    document.getElementById('goalModal').setAttribute('hidden','');
  });
  document.getElementById('goalModalClose').addEventListener('click', () =>
    document.getElementById('goalModal').setAttribute('hidden',''));

  // Profile — rate save
  document.getElementById('saveRateBtn').addEventListener('click', () => {
    saveRate(document.getElementById('newRateInput').value);
    document.getElementById('newRateInput').value = '';
  });

  // Profile — goal save
  document.getElementById('saveGoalBtn').addEventListener('click', () =>
    saveGoal(document.getElementById('goalInput').value));

  // Color swatches
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', async () => {
      document.querySelectorAll('.color-swatch').forEach(x => x.classList.remove('active'));
      sw.classList.add('active');
      const color = sw.dataset.color;
      applyAccentColor(color);
      await dbSaveProfile({ accent_color: color });
    });
  });

  // Avatar color shortcut (cycles accent colors)
  document.getElementById('changeAvatarColor')?.addEventListener('click', () => {
    const colors = ['#4f8dff','#3ecf8e','#ff6b6b','#ffb347','#b08bff','#ff7eb3','#00d4ff'];
    const cur = state.profile?.accent_color || '#4f8dff';
    const idx = colors.indexOf(cur);
    const next = colors[(idx + 1) % colors.length];
    applyAccentColor(next);
    dbSaveProfile({ accent_color: next });
    document.querySelectorAll('.color-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.color === next);
    });
  });

  // Notifications
  document.getElementById('enableNotifBtn').addEventListener('click', enableNotifications);
  document.getElementById('notifBtn').addEventListener('click', enableNotifications);
  document.getElementById('reminderTime').addEventListener('change', async e => {
    await dbSaveProfile({ notif_time: e.target.value });
    toast('✓ Час за напомняне запазен', 'success');
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', logoutUser);

  // Online/offline
  window.addEventListener('online', () => {
    state.isOnline = true;
    document.getElementById('offlineBanner').setAttribute('hidden', '');
    toast('✓ Онлайн връзка възстановена', 'success');
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    document.getElementById('offlineBanner').removeAttribute('hidden');
    toast('📡 Офлайн режим', 'info');
  });

  // Swipe for calendar
  const calWrap = document.getElementById('calendarWrap');
  if (calWrap) addSwipeSupport(calWrap);

  // Avatar wrap click → go to profile
  document.getElementById('avatarWrap')?.addEventListener('click', () => switchTab('profile'));
}

/* ═══════════════════════════════════════════
   SERVICE WORKER
═══════════════════════════════════════════ */
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .then(() => console.log('[SW] registered'))
      .catch(e => console.warn('[SW] failed:', e));
  }
}

/* ═══════════════════════════════════════════
   INIT
═══════════════════════════════════════════ */
async function init() {
  // Theme
  const settings = LS.loadSettings();
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(typeof settings.darkMode === 'boolean' ? settings.darkMode : prefersDark);

  // Supabase
  initSupabase();

  wireAuthEvents();
  wireAppEvents();
  registerSW();

  // Check existing Supabase session
  if (sb) {
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user) {
      state.user = session.user;
      await bootApp();
      return;
    }
    // Listen for auth state changes
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        state.user = session.user;
        await bootApp();
      }
    });
  }

  showAuthScreen();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
