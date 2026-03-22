/**
 * Shifster Individual — script.js
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
   VERCEL WEB ANALYTICS
═══════════════════════════════════════════ */
import { inject } from '@vercel/analytics';
inject();


/* ═══════════════════════════════════════════
   CONFIG — Environment Variables (Vercel)
═══════════════════════════════════════════ */
/* ═══════════════════════════════════════════
   CONFIG — Environment Variables (Vite/Vercel)
═══════════════════════════════════════════ */
const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY;

/* ═══════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════ */
const DEFAULT_RATE = 11;
const LS_PREFIX = 'tl_';
const MONTHS_BG = [
  'Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни',
  'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'
];
const BADGES_DEF = [
  { id: 'h100', label: '💪 100+ часа', cls: 'gold', check: (h) => h >= 100 },
  { id: 'h160', label: '🏆 160+ часа', cls: 'gold', check: (h) => h >= 160 },
  { id: 'h200', label: '🚀 200+ часа', cls: 'purple', check: (h) => h >= 200 },
  { id: 'd20', label: '📅 20+ дни', cls: 'green', check: (h, d) => d >= 20 },
  { id: 'str5', label: '🔥 5 дни подред', cls: 'gold', check: (h, d, streak) => streak >= 5 },
  { id: 'night', label: '🌙 Нощна сова', cls: 'purple', check: (h, d, s, n) => n >= 3 },
];

function getUUID() {
  try {
    return self.crypto.randomUUID();
  } catch (e) {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
const state = {
  user: null,   // Supabase user object
  profile: null,   // user_profiles row
  demoMode: false,
  isOnline: navigator.onLine,

  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(),
  darkMode: true,
  activeTab: 'dashboard',
  activeFilter: 'all',
  activeShift: 'normal',  // for hour modal
  modalDay: null,
  modalEditingId: null,
  modalParentId: null,

  // cached month entries: { "YYYY-MM-DD": [ { hours, rate, shift_type } ] }
  entries: {},

  charts: { bar: null, line: null, salary: null, shift: null, mini: null },
};

/* ═══════════════════════════════════════════
   ONBOARDING KNOWLEDGE
═══════════════════════════════════════════ */
const INDUSTRY_KNOWLEDGE = {
  "Ресторанти": {
    "Готвач": [
      { name: "Дневна (Готвач)", start: "09:00", end: "21:00", break: 60 },
      { name: "Подготовка", start: "10:00", end: "18:00", break: 30 },
      { name: "Вечерна", start: "16:00", end: "01:00", break: 45 }
    ],
    "Сервитьор": [
      { name: "Първа смяна", start: "08:00", end: "16:00", break: 30 },
      { name: "Втора смяна", start: "16:00", end: "00:00", break: 30 },
      { name: "Междинна", start: "12:00", end: "22:00", break: 60 }
    ],
    "Барман": [
      { name: "Дневна", start: "10:00", end: "18:00", break: 30 },
      { name: "Нощна", start: "18:00", end: "04:00", break: 45 }
    ]
  },
  "Хотели": {
    "Рецепция": [
      { name: "Дневна (Рецепция)", start: "07:00", end: "19:00", break: 60 },
      { name: "Нощна (Рецепция)", start: "19:00", end: "07:00", break: 60 }
    ],
    "Камериерка": [
      { name: "Редовна смяна", start: "08:00", end: "16:30", break: 30 }
    ]
  },
  "Складове": {
    "Складов работник": [
      { name: "Ранна", start: "06:00", end: "14:30", break: 30 },
      { name: "Редовна", start: "08:30", end: "17:30", break: 60 },
      { name: "Нощна", start: "22:00", end: "06:00", break: 45 }
    ]
  },
  "Здравеопазване": {
    "Сестра/Лекар": [
      { name: "Дневно дежурство", start: "07:30", end: "19:30", break: 60 },
      { name: "Нощно дежурство", start: "19:30", end: "07:30", break: 60 },
      { name: "24-часово", start: "08:00", end: "08:00", break: 120 }
    ]
  },
  "Магазини": {
    "Касиер/Продавач": [
      { name: "Сутрешна", start: "07:30", end: "15:30", break: 30 },
      { name: "Следобедна", start: "14:00", end: "22:00", break: 30 }
    ]
  }
};

/* ═══════════════════════════════════════════
   SUPABASE CLIENT
═══════════════════════════════════════════ */
let sb = null; // will be null if creds not set

function initSupabase() {
  if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR_PROJECT')) return;
  try {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    /* silent fail */
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
      const all = raw ? JSON.parse(raw) : {};
      Object.keys(all).forEach(day => {
        if (!Array.isArray(all[day])) all[day] = [all[day]];
      });
      return all;
    } catch { return {}; }
  },

  saveEntries(userId, year, month, data) {
    const ym = ymStr(year, month);
    try {
      // Important: only store as arrays to simplify logic elsewhere
      const cleaned = {};
      Object.keys(data).forEach(day => {
        cleaned[day] = Array.isArray(data[day]) ? data[day] : [data[day]];
      });
      localStorage.setItem(this.key(userId, ym), JSON.stringify(cleaned));
    }
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
  if (state.demoMode || !sb || !state.isOnline) {
    return LS.loadEntries(uid, year, month);
  }
  try {
    const start = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const end = `${year}-${String(month + 1).padStart(2, '0')}-31`;
    const { data, error } = await sb.from('work_entries')
      .select('id,day_key,hours,rate,shift_type,shift_start,shift_end,status,planned_hours,break_minutes,break_is_paid,is_night,parent_shift_id,template_name')
      .eq('user_id', uid)
      .gte('day_key', start)
      .lte('day_key', end);
    if (error) throw error;

    const obj = {};
    (data || []).forEach(r => {
      if (!obj[r.day_key]) obj[r.day_key] = [];
      obj[r.day_key].push({
        id: r.id,
        hours: parseFloat(r.hours),
        rate: parseFloat(r.rate),
        shift_type: r.shift_type || 'normal',
        shift_start: r.shift_start || '',
        shift_end: r.shift_end || '',
        status: r.status || 'actual',
        planned_hours: r.planned_hours !== undefined && r.planned_hours !== null ? parseFloat(r.planned_hours) : parseFloat(r.hours),
        break_minutes: parseInt(r.break_minutes) || 0,
        break_is_paid: !!r.break_is_paid,
        is_night: !!r.is_night,
        parent_shift_id: r.parent_shift_id,
        template_name: r.template_name
      });
    });
    LS.saveEntries(uid, year, month, obj);
    return obj;
  } catch (e) {
    console.warn('dbLoadEntries fallback to local:', e);
    return LS.loadEntries(uid, year, month);
  }
}

async function dbSetEntry(dayKey, hours, rate, shift_type, shift_start = '', shift_end = '', status = 'actual', planned_hours = null, break_minutes = 0, break_is_paid = false, is_night = false, parentId = null, existingId = null, template_name = null) {
  const uid = state.user?.id || 'demo';
  const ph = planned_hours !== null ? planned_hours : hours;
  const [y, m] = dayKey.split('-').map(Number);
  const entries = LS.loadEntries(uid, y, m - 1);

  const id = existingId || getUUID();
  const entry = { id, hours, rate, shift_type, shift_start, shift_end, status, planned_hours: ph, break_minutes, break_is_paid, is_night, parent_shift_id: parentId, template_name };

  if (hours === 0 && !existingId) {
    // legacy behavior: delete whole day if no ID provided
    delete entries[dayKey];
  } else if (hours === 0 && existingId) {
    if (entries[dayKey]) {
      entries[dayKey] = entries[dayKey].filter(x => x.id !== existingId);
      if (entries[dayKey].length === 0) delete entries[dayKey];
    }
  } else {
    if (!entries[dayKey]) entries[dayKey] = [];
    const idx = entries[dayKey].findIndex(x => x.id === id);
    if (idx > -1) entries[dayKey][idx] = entry;
    else entries[dayKey].push(entry);
  }
  LS.saveEntries(uid, y, m - 1, entries);

  if (state.demoMode || !sb || !state.isOnline) return;
  try {
    if (hours === 0) {
      if (existingId) {
        await sb.from('work_entries').delete().eq('user_id', uid).eq('id', existingId);
      } else {
        await sb.from('work_entries').delete().eq('user_id', uid).eq('day_key', dayKey);
      }
    } else {
      const payload = {
        user_id: uid, day_key: dayKey, hours, rate,
        shift_type, shift_start, shift_end, status,
        planned_hours: ph, break_minutes, break_is_paid,
        is_night, parent_shift_id: parentId, template_name
      };
      if (existingId) payload.id = existingId;
      await sb.from('work_entries').upsert(payload);
    }
  } catch (e) { console.warn('dbSetEntry sync failed:', e); }
}

async function dbDeleteShiftGroup(dayKey, id, parentId) {
  const uid = state.user?.id || 'demo';
  const [y, m] = dayKey.split('-').map(Number);
  const entries = LS.loadEntries(uid, y, m - 1);

  if (parentId) {
    // Изтриване на всички части на нощната смяна локално в този месец
    Object.keys(entries).forEach(dk => {
      if (Array.isArray(entries[dk])) {
        entries[dk] = entries[dk].filter(x => x.parent_shift_id !== parentId && x.id !== parentId);
        if (entries[dk].length === 0) delete entries[dk];
      }
    });
  } else {
    // Изтриване на единична смяна локално
    if (entries[dayKey]) {
      entries[dayKey] = entries[dayKey].filter(x => x.id !== id);
      if (entries[dayKey].length === 0) delete entries[dayKey];
    }
  }
  LS.saveEntries(uid, y, m - 1, entries);

  if (state.demoMode || !sb || !state.isOnline) return;
  try {
    if (parentId) {
      await sb.from('work_entries').delete().eq('user_id', uid).or(`parent_shift_id.eq.${parentId},id.eq.${parentId}`);
    } else {
      await sb.from('work_entries').delete().eq('user_id', uid).eq('id', id);
    }
  } catch (e) {
    console.error('dbDeleteShiftGroup error:', e);
  }
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
    const { data, error } = await sb.from('user_profiles').select('*').eq('id', uid).maybeSingle();
    if (error) throw error;

    const localProfile = LS.loadProfile(uid) || defaultProfile(uid);
    const profile = data ? { ...localProfile, ...data } : localProfile;

    // If not found in DB, push it to Supabase now that user is logged in
    if (!data && profile.id === uid) {
      await sb.from('user_profiles').upsert(profile);
    }

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
    custom_shifts: [],
    dark_mode: true
  };
}

async function dbSaveProfile(updates) {
  const uid = state.user?.id || 'demo';
  const profile = { ...state.profile, ...updates };
  state.profile = profile;
  LS.saveProfile(uid, profile);

  if (state.demoMode || !sb || !state.isOnline) return;
  try {
    const dbUpdates = { ...updates, id: uid };
    if (Object.keys(dbUpdates).length > 1) { // more than just 'id'
      await sb.from('user_profiles').upsert(dbUpdates);
    }
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
  let total = 0;
  Object.values(entries).forEach(dayArr => {
    if (!Array.isArray(dayArr)) dayArr = [dayArr];
    dayArr.forEach(v => {
      if (v.status === 'planned') return;
      let hrs = v.hours || 0;
      if (v.break_minutes > 0 && !v.break_is_paid) {
        hrs = Math.max(0, hrs - (v.break_minutes / 60));
      }
      total += hrs;
    });
  });
  return total;
}

function sumSalary(entries) {
  let total = 0;
  Object.values(entries).forEach(dayArr => {
    if (!Array.isArray(dayArr)) dayArr = [dayArr];
    dayArr.forEach(v => {
      if (v.status === 'planned') return;
      let hrs = v.hours || 0;
      if (v.break_minutes > 0 && !v.break_is_paid) {
        hrs = Math.max(0, hrs - (v.break_minutes / 60));
      }
      total += hrs * (v.rate || DEFAULT_RATE);
    });
  });
  return total;
}

function countDays(entries) {
  return Object.values(entries).filter(dayArr => {
    if (!Array.isArray(dayArr)) dayArr = [dayArr];
    return dayArr.some(v => (v.hours || 0) > 0 && v.status !== 'planned');
  }).length;
}

function calcForecast(entries) {
  let total = 0;
  Object.values(entries).forEach(dayArr => {
    if (!Array.isArray(dayArr)) dayArr = [dayArr];
    dayArr.forEach(v => {
      let hrs = v.hours || 0;
      if (v.break_minutes > 0 && !v.break_is_paid) {
        hrs = Math.max(0, hrs - (v.break_minutes / 60));
      }
      total += hrs * (v.rate || DEFAULT_RATE);
    });
  });
  return total;
}

function calcStreak(entries) {
  // Count max consecutive worked days ending today or in current period
  const sorted = Object.keys(entries).sort().reverse();
  let streak = 0;
  let prev = null;
  for (const dk of sorted) {
    const dayArr = entries[dk] || [];
    const hasWorked = dayArr.some(v => (v.hours || 0) > 0 && v.status !== 'planned');
    if (!hasWorked) break;
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
  const filtered = {};
  Object.entries(entries).forEach(([dk, dayArr]) => {
    if (!Array.isArray(dayArr)) dayArr = [dayArr];
    const matches = dayArr.filter(v => {
      if (v.template_name === filter) return true;
      // Legacy or internal filters
      if (filter === 'overtime' && v.shift_type === 'overtime') return true;
      if (filter === 'weekend' && v.shift_type === 'weekend') return true;
      if (!isNaN(filter) && v.hours === parseFloat(filter)) return true;
      return false;
    });
    if (matches.length > 0) filtered[dk] = matches;
  });
  return filtered;
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

async function registerUser(email, password, name) {
  if (!sb) return { error: { message: 'Supabase не е конфигуриран.' } };
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error || !data.user) return { error };

  const rate = DEFAULT_RATE;
  const profileData = {
    id: data.user.id,
    full_name: name,
    hourly_rate: rate,
    accent_color: '#4f8dff',
    monthly_goal: 160,
    role: 'user',
    industry: null,
    position: null,
    rate_history: [{ rate, date: new Date().toISOString().split('T')[0] }],
    notif_time: '20:00',
    custom_shifts: [],
    dark_mode: true
  };

  // Save locally in case email confirmation is required (no active session yet)
  LS.saveProfile(data.user.id, profileData);

  // If session is immediately available (email confirm off), insert to DB
  if (data.session) {
    await sb.from('user_profiles').insert(profileData);
  }

  return { data };
}

async function logoutUser() {
  LS.saveSettings({ ...LS.loadSettings(), demo_mode: false });
  if (sb) await sb.auth.signOut();
  state.user = null;
  state.profile = null;
  state.demoMode = false;
  window.location.href = 'index.html';
}

function enterDemoMode() {
  state.demoMode = true;
  state.user = { id: 'demo', email: 'demo@shifster.local' };
  state.profile = {
    id: 'demo',
    full_name: 'Демо Потребител',
    hourly_rate: DEFAULT_RATE,
    accent_color: '#4f8dff',
    monthly_goal: 160,
    role: 'user',
    rate_history: [{ rate: DEFAULT_RATE, date: new Date().toISOString().split('T')[0] }],
    notif_time: '20:00',
    custom_shifts: []
  };

  if (window.location.pathname.includes('app.html')) {
    bootApp();
  } else {
    LS.saveSettings({ ...LS.loadSettings(), demo_mode: true });
    window.location.href = 'app.html';
  }
}

/* ═══════════════════════════════════════════
   SCREEN MANAGEMENT
═══════════════════════════════════════════ */
function showAuthScreen() {
  const auth = document.getElementById('authScreen');
  const app = document.getElementById('appShell');
  if (auth) auth.style.display = '';
  if (app) app.setAttribute('hidden', '');
}

function showApp() {
  const auth = document.getElementById('authScreen');
  const app = document.getElementById('appShell');
  if (auth) auth.style.display = 'none';
  if (app) app.removeAttribute('hidden');
}

/* ═══════════════════════════════════════════
   BOOT APP (after login)
═══════════════════════════════════════════ */
async function bootApp() {
  showApp();
  state.profile = await dbLoadProfile();
  
  // Задължителен Onboarding за нови потребители с липсваща индустрия
  const hasIndustry = state.profile.industry && state.profile.industry.trim().length > 0;
  if (!hasIndustry && !state.demoMode && window.location.pathname.includes('app.html')) {
    showOnboarding();
  }

  if (state.profile.dark_mode !== undefined) applyTheme(state.profile.dark_mode);
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
   ONBOARDING
═══════════════════════════════════════════ */
function showOnboarding() {
  const overlay = document.getElementById('onboardingOverlay');
  if (!overlay) return;
  
  overlay.style.opacity = '0';
  overlay.removeAttribute('hidden');
  void overlay.offsetWidth; // Trigger reflow
  overlay.style.transition = 'opacity 0.5s ease';
  overlay.style.opacity = '1';
  
  const grid = document.getElementById('industryGrid');
  if (grid) {
    const industries = [
      { id: "Ресторанти", icon: "🍴" },
      { id: "Хотели", icon: "🏨" },
      { id: "Магазини", icon: "🛍️" },
      { id: "Складове", icon: "📦" },
      { id: "Здравеопазване", icon: "🏥" },
      { id: "Транспорт", icon: "🚚" },
      { id: "Производство", icon: "🏭" },
      { id: "Друга", icon: "✨" }
    ];
    grid.innerHTML = industries.map(info => `
      <div class="onboarding-item" onclick="onboardingSelectIndustry('${info.id}')">
        <div class="onboarding-icon">${info.icon}</div>
        <div class="onboarding-label">${info.id}</div>
      </div>
    `).join('');
  }
}

function onboardingSelectIndustry(id) {
  state._onboardingIndustry = id;
  const positions = INDUSTRY_KNOWLEDGE[id] ? Object.keys(INDUSTRY_KNOWLEDGE[id]) : ["Друга"];
  const list = document.getElementById('rolesList');
  const step1 = document.getElementById('onboardingStep1');
  const step2 = document.getElementById('onboardingStep2');
  
  if (list) {
    list.innerHTML = positions.map(posName => `
      <button class="btn btn-primary btn-full onboarding-role-btn" 
              onclick="onboardingSelectRole('${posName}')">${posName}</button>
    `).join('');
  }
  
  if (step1) step1.setAttribute('hidden', '');
  if (step2) {
    step2.removeAttribute('hidden');
    step2.classList.add('fade-in');
  }
};

function onboardingBack() {
  document.getElementById('onboardingStep2').setAttribute('hidden', '');
  document.getElementById('onboardingStep1').removeAttribute('hidden');
};

async function onboardingSelectRole(posName) {
  const industryId = state._onboardingIndustry;
  const industryData = INDUSTRY_KNOWLEDGE[industryId] || {};
  const roleShifts = industryData[posName] || [];
  
  const btn = document.querySelector(`.onboarding-role-btn[onclick*="${posName}"]`);
  if (btn) btn.innerHTML = '<span class="spinner"></span>';

  // Silent Template Injection - Mapping to standard format
  const templates = roleShifts.map(s => ({
    id: getUUID(),
    name: s.name,
    start: s.start,
    end: s.end,
    break_minutes: s.break || 0,
    isDefault: false
  }));
  if (templates.length > 0) templates[0].isDefault = true;

  try {
    const updates = {
      industry: industryId,
      position: posName,
      custom_shifts: templates
    };
    
    // Save to user_profiles (existing logic)
    await dbSaveProfile(updates);
    
    state.profile = { ...state.profile, ...updates };
    
    // Smooth hide
    const overlay = document.getElementById('onboardingOverlay');
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.setAttribute('hidden', '');
      overlay.style.opacity = '1';
    }, 600);

    renderProfile();
    await refreshAll();
    
    // Незабавен старт на туториала след избиране на роля
    const settings = LS.loadSettings();
    if (!settings.tutorial_done) {
        startTutorial();
    }
    
    toast('Готово! Твоите шаблони са заредени 🚀', 'success');
  } catch (e) {
    console.error(e);
    toast('Възникна грешка при запазването.', 'error');
    if (btn) btn.textContent = posName;
  }
};


/* ═══════════════════════════════════════════
   ACCENT COLOR
═══════════════════════════════════════════ */
function applyAccentColor(color) {
  // Parse hex to rgb
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
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
  const total = sumHours(filtered);
  const salary = sumSalary(state.entries); // salary always from all entries (unfiltered)
  const days = countDays(filtered);
  const avg = days > 0 ? total / days : 0;
  const forecast = calcForecast(state.entries);

  // Генериране на Empty State ако няма записи за месеца
  const dashWelcome = document.getElementById('dashWelcomeBanner');
  if (dashWelcome) {
    if (days === 0 && !state.demoMode) {
      dashWelcome.style.display = 'flex';
      const roleName = state.profile.position || 'твоята роля';
      document.getElementById('welcomeRoleName').textContent = roleName;
      
      document.getElementById('btnStartFirstShift').onclick = () => {
        switchTab('calendar');
      };
    } else {
      dashWelcome.style.display = 'none';
    }
  }

  // Night hours calculation
  let nightHours = 0;
  Object.values(state.entries).forEach(dayArr => {
    dayArr.forEach(v => {
      if (v.is_night) {
        let nh = v.hours || 0;
        if (v.break_minutes > 0 && !v.break_is_paid) nh = Math.max(0, nh - (v.break_minutes / 60));
        nightHours += nh;
      }
    });
  });

  animateValue(document.getElementById('statHours'), fmt(total));
  document.getElementById('statHours').closest('.stat-card').querySelector('.stat-sub').innerHTML =
    `за месеца ${nightHours > 0 ? `<span style="color:#b08bff" title="Общо нощни часове">| 🌙 ${fmt(nightHours)}ч</span>` : ''}`;

  animateValue(document.getElementById('statSalary'), `${fmt(salary)} лв.`);
  animateValue(document.getElementById('statDays'), days);
  animateValue(document.getElementById('statAvg'), fmt(avg));

  const forecastEl = document.getElementById('statForecast');
  if (forecastEl) {
    forecastEl.textContent = `Очаквани: ${fmt(forecast)} лв.`;
  }

  // Quick Confirm Widget Logic
  const todayStr = new Date().toISOString().split('T')[0];
  const widget = document.getElementById('plannedWidget');
  const todayEntries = state.entries[todayStr] || [];
  const plannedEntry = todayEntries.find(v => v.status === 'planned' && (v.hours || 0) > 0);

  if (plannedEntry) {
    let netHrs = plannedEntry.hours;
    if (plannedEntry.break_minutes > 0 && !plannedEntry.break_is_paid) {
      netHrs = Math.max(0, netHrs - (plannedEntry.break_minutes / 60));
    }
    document.getElementById('plannedWidgetText').textContent = `Ранна смяна: ${plannedEntry.shift_start || ''} - ${plannedEntry.shift_end || ''} (${fmt(netHrs)}ч)`;
    widget.style.display = 'block';

    document.getElementById('btnConfirmPlanned').onclick = async () => {
      widget.style.animation = 'toastOut 0.3s ease both';
      setTimeout(() => widget.style.display = 'none', 300);

      const cardIds = ['cardHours', 'cardSalary', 'cardDays', 'cardAvg'];
      cardIds.forEach((id, idx) => {
        setTimeout(() => {
          const card = document.getElementById(id);
          if (card) {
            card.classList.remove('magic-confirm');
            void card.offsetWidth; // trigger reflow
            card.classList.add('magic-confirm');
            card.addEventListener('animationend', () => card.classList.remove('magic-confirm'), { once: true });
          }
        }, idx * 300);
      });

      // Update to actual
      await dbSetEntry(todayStr, plannedEntry.hours, plannedEntry.rate, plannedEntry.shift_type, plannedEntry.shift_start, plannedEntry.shift_end, 'actual', plannedEntry.planned_hours || plannedEntry.hours, plannedEntry.break_minutes || 0, plannedEntry.break_is_paid || false, plannedEntry.is_night, plannedEntry.parent_shift_id, plannedEntry.id);
      state.entries = await dbLoadEntries(state.viewYear, state.viewMonth);
      await refreshAll();
      toast('Часовете са потвърдени!', 'success');
    };

    document.getElementById('btnCorrectPlanned').onclick = () => {
      openHourModal(todayStr, parseInt(todayStr.split('-')[2], 10));
    };
  } else {
    widget.style.display = 'none';
  }

  const rate = state.profile?.hourly_rate || DEFAULT_RATE;
  document.getElementById('statRateSub').textContent = `при ${fmt(rate)} лв./час`;
  document.getElementById('dashMonthLabel').textContent = `${MONTHS_BG[state.viewMonth]} ${state.viewYear}`;

  const nightCount = Object.values(state.entries).filter(dayArr => dayArr.some(v => v.is_night)).length;
  renderGoalProgress(total);
  renderBadges(total, days, nightCount);
  renderMiniChart();
  checkUnconfirmedShifts();

  // Dynamic filters from templates
  const filterRow = document.getElementById('dashboardFilters');
  if (filterRow) {
    const label = filterRow.querySelector('.filter-label');
    filterRow.innerHTML = '';
    if (label) filterRow.appendChild(label);

    const filters = [{ name: 'Всички', value: 'all' }];
    if (state.profile?.custom_shifts) {
      state.profile.custom_shifts.forEach(tpl => filters.push({ name: tpl.name, value: tpl.name }));
    }
    // Also add shift types if they are common
    filters.push({ name: 'Извънреден', value: 'overtime' });

    filters.forEach(f => {
      const btn = document.createElement('button');
      btn.className = `filter-chip ${state.activeFilter === f.value ? 'active' : ''}`;
      btn.textContent = f.name;
      btn.onclick = () => {
        state.activeFilter = f.value;
        renderDashboard();
      };
      filterRow.appendChild(btn);
    });
  }
  checkTutorialTrigger();
}

function checkTutorialTrigger() {
  const settings = LS.loadSettings();
  // По-проста проверка: Ако профилът е готов, но туториалът не е отбелязан като завършен
  if (state.profile?.industry && !settings.tutorial_done && !state.demoMode) {
    if (document.getElementById('tutorialOverlay') && !document.getElementById('tutorialOverlay').hasAttribute('hidden')) return;
    
    console.log('✨ Shifster: Starting auto-walkthrough...');
    setTimeout(startTutorial, 1500);
  }
}

// Полезна функция за тестване (може да се вика от конзолата или бутон)
window.resetTutorial = function() {
  const settings = LS.loadSettings();
  LS.saveSettings({ ...settings, tutorial_done: false });
  location.reload();
};


/* ── Unconfirmed Shifts Logic ── */
function checkUnconfirmedShifts() {
  const todayStr = new Date().toISOString().split('T')[0];
  const unconfirmed = [];

  Object.keys(state.entries).forEach(dk => {
    if (dk < todayStr) {
      const dayArr = state.entries[dk] || [];
      dayArr.forEach(v => {
        if (v.status === 'planned') {
          unconfirmed.push({ date: dk, entry: v });
        }
      });
    }
  });

  const banner = document.getElementById('unconfirmedBanner');
  if (!banner) return;

  if (unconfirmed.length === 0) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';
  const textEl = banner.querySelector('.unconfirmed-text');
  const actionsEl = banner.querySelector('.unconfirmed-actions');

  if (unconfirmed.length === 1) {
    const shiftDate = new Date(unconfirmed[0].date);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = shiftDate.toDateString() === yesterday.toDateString();

    textEl.textContent = `Имате 1 непотвърдена смяна от ${isYesterday ? 'вчера' : unconfirmed[0].date}.`;
    actionsEl.innerHTML = `
      <button onclick="confirmBulkShifts(true)">Потвърди с 1 клик</button>
      <button onclick="openHourModal('${unconfirmed[0].date}', ${parseInt(unconfirmed[0].date.split('-')[2])})">Коригирай</button>
    `;
  } else {
    textEl.textContent = `Имате ${unconfirmed.length} непотвърдени смени.`;
    actionsEl.innerHTML = `<button onclick="confirmBulkShifts(false)">Потвърди всички</button>`;
  }
}

window.confirmBulkShifts = async function (single) {
  const todayStr = new Date().toISOString().split('T')[0];
  const toConfirm = [];

  Object.keys(state.entries).forEach(dk => {
    if (dk < todayStr) {
      const dayArr = state.entries[dk] || [];
      dayArr.forEach(v => {
        if (v.status === 'planned') {
          toConfirm.push({ date: dk, entry: v });
        }
      });
    }
  });

  for (const item of toConfirm) {
    const v = item.entry;
    await dbSetEntry(
      item.date, v.hours, v.rate, v.shift_type,
      v.shift_start, v.shift_end, 'actual',
      v.planned_hours || v.hours, v.break_minutes || 0,
      v.break_is_paid || false, v.is_night,
      v.parent_shift_id, v.id, v.template_name
    );
  }

  state.entries = await dbLoadEntries(state.viewYear, state.viewMonth);
  await refreshAll();
  toast(single ? '✓ Смяната е потвърдена!' : `✓ ${toConfirm.length} смени са потвърдени!`, 'success');
};

/* ── Goal Progress ── */
function renderGoalProgress(total) {
  const goal = state.profile?.monthly_goal || 160;
  const pct = Math.min(100, (total / goal) * 100);
  document.getElementById('goalFill').style.width = pct + '%';
  document.getElementById('goalPct').textContent = pct.toFixed(1) + '%';
  document.getElementById('goalValue').textContent = `${fmt(total)} / ${goal} ч`;
}

/* ── Badges ── */
function renderBadges(totalHours, totalDays, nightCount = 0) {
  const streak = calcStreak(state.entries);
  const row = document.getElementById('badgesRow');
  row.innerHTML = '';
  BADGES_DEF.forEach((b, i) => {
    if (b.check(totalHours, totalDays, streak, nightCount)) {
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
  const ctx = document.getElementById('weekMiniChart')?.getContext('2d');
  if (!ctx) return;
  if (state.charts.mini) state.charts.mini.destroy();

  const labels = ['Пон', 'Вт', 'Ср', 'Чет', 'Пет', 'Съб', 'Нед'];
  const values = [0, 0, 0, 0, 0, 0, 0];

  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const start = new Date(now.setDate(diff));

  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const dk = d.toISOString().split('T')[0];
    const dayArr = state.entries[dk] || [];
    dayArr.forEach(entry => {
      let nh = entry.hours || 0;
      if (entry.break_minutes > 0 && !entry.break_is_paid) {
        nh = Math.max(0, nh - (entry.break_minutes / 60));
      }
      values[i] += nh;
    });
  }

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
        y: {
          beginAtZero: true, grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
          ticks: { color: isDark ? '#7777aa' : '#5555aa', font: { size: 10 } }
        }
      }
    }
  });

  // Toggle Placeholder if no data this week
  const hasWeekData = values.some(v => v > 0);
  const placeholder = document.getElementById('chartPlaceholderText');
  if (placeholder) {
    placeholder.style.display = hasWeekData ? 'none' : 'block';
  }
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
    const dk = dayKeyStr(year, month, d);
    const dayArr = state.entries[dk] || [];
    const dow = new Date(year, month, d).getDay(); // 0=Sun,6=Sat
    const isWeekend = (dow === 0 || dow === 6);
    const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;

    const cell = document.createElement('div');
    let cls = 'cal-day';
    if (isToday) cls += ' today';
    if (isWeekend && dayArr.length === 0) cls += ' weekend-day';
    cell.className = cls;
    cell.dataset.key = dk;

    const numEl = document.createElement('div');
    numEl.className = 'day-num';
    numEl.textContent = d;
    cell.appendChild(numEl);

    if (dayArr && dayArr.length > 0) {
      let dayNetTotal = 0;
      let hasPlanned = false;
      let hasActual = false;
      let hasNight = false;
      let mainShift = 'normal';

      dayArr.forEach(entry => {
        let nh = entry.hours || 0;
        if (entry.break_minutes > 0 && !entry.break_is_paid) {
          nh = Math.max(0, nh - (entry.break_minutes / 60));
        }
        dayNetTotal += nh;
        if (entry.status === 'planned') hasPlanned = true;
        else hasActual = true;
        if (entry.is_night) hasNight = true;
        if (entry.shift_type !== 'normal') mainShift = entry.shift_type;
      });

      if (hasNight) cell.classList.add('night-shift');
      if (hasActual) cell.classList.add('worked', 'actual');
      else if (hasPlanned) cell.classList.add('planned');
      if (mainShift === 'overtime') cell.classList.add('overtime-day');

      const hoursCont = document.createElement('div');
      hoursCont.className = 'day-hours-list';

      dayArr.forEach(entry => {
        let text = '-';
        if (entry.shift_start && entry.shift_end) {
          text = `${entry.shift_start} - ${entry.shift_end}`;
        } else if (entry.hours) {
          text = `${fmt(entry.hours)}ч`;
        }

        if (text !== '-') {
          const hEl = document.createElement('div');
          hEl.className = 'day-hours';
          hEl.textContent = text;
          hoursCont.appendChild(hEl);
        }
      });

      if (hoursCont.childNodes.length > 0) {
        cell.appendChild(hoursCont);
      }

      // indicators (top right)
      const indCont = document.createElement('div');
      indCont.className = 'day-indicators';

      const hasUnpaidBreak = dayArr.some(entry => entry.break_minutes > 0 && !entry.break_is_paid);

      if (hasUnpaidBreak) {
        const breakDot = document.createElement('div');
        breakDot.className = 'break-dot';
        breakDot.title = 'С неплатена почивка';
        indCont.appendChild(breakDot);
      }

      const dot = document.createElement('div');
      let dotClass = `dot-${mainShift}`;
      if (hasNight) {
        dotClass = 'dot-night';
      }
      dot.className = `day-shift-dot ${dotClass}`;
      indCont.appendChild(dot);
      cell.appendChild(indCont);
    }

    cell.addEventListener('click', () => openHourModal(dk, d));
    grid.appendChild(cell);
  }
}

/* ═══════════════════════════════════════════
   HOUR MODAL
═══════════════════════════════════════════ */
function calcShiftHours(startVal, endVal) {
  if (!startVal || !endVal) return null;
  const [sh, sm] = startVal.split(':').map(Number);
  const [eh, em] = endVal.split(':').map(Number);
  let startMin = sh * 60 + sm;
  let endMin = eh * 60 + em;
  if (endMin <= startMin) endMin += 24 * 60; // overnight shift
  const diffMin = endMin - startMin;
  return Math.round(diffMin / 60 * 100) / 100;
}

function updateHoursPreview() {
  const startVal = document.getElementById('shiftStart').value;
  const endVal = document.getElementById('shiftEnd').value;
  const totalHours = calcShiftHours(startVal, endVal);

  const breakMin = parseInt(document.getElementById('breakMinutes')?.value) || 0;
  const breakType = document.querySelector('input[name="breakType"]:checked')?.value || 'unpaid';

  const preview = document.getElementById('hoursPreviewNum');
  const badge = document.getElementById('hoursPreview');
  const breakPreview = document.getElementById('breakPreviewText');

  // Theme checking
  const [sh, sm] = (startVal || '00:00').split(':').map(Number);
  const [eh, em] = (endVal || '00:00').split(':').map(Number);
  const isOvernight = startVal && endVal && ((eh < sh) || (eh === sh && em < sm));

  const modalEl = document.querySelector('.modal');
  const themeIcon = document.getElementById('modalThemeIcon');
  if (modalEl && themeIcon) {
    if (isOvernight) {
      modalEl.classList.add('night-theme');
      themeIcon.className = 'modal-header-icon icon-moon';
      themeIcon.textContent = '🌙';
    } else {
      modalEl.classList.remove('night-theme');
      themeIcon.className = 'modal-header-icon icon-sun';
      themeIcon.textContent = '☀️';
    }
  }

  const rate = parseFloat(document.getElementById('modalShiftRate').value) || 0;

  if (totalHours === null || totalHours <= 0) {
    preview.textContent = '—';
    if (badge) badge.classList.remove('has-value');
    if (breakPreview) breakPreview.style.display = 'none';
    const label = badge?.querySelector('.hours-preview-label');
    if (label) label.textContent = 'ч';
  } else {
    let netHours = totalHours;
    if (breakMin > 0 && breakType === 'unpaid') {
      netHours = Math.max(0, totalHours - (breakMin / 60));
    }

    preview.textContent = fmt(netHours);
    if (badge) {
      badge.classList.add('has-value');
      const label = badge.querySelector('.hours-preview-label');
      if (label) label.textContent = 'ч';
    }

    if (breakPreview) {
      if (breakMin > 0) {
        breakPreview.textContent = `Общо: ${fmt(totalHours)}ч | Почивка: ${breakMin}м (${breakType === 'paid' ? 'платена' : 'неплатена'}) | Нето: ${fmt(netHours)}ч`;
        breakPreview.style.display = 'block';
      } else {
        breakPreview.style.display = 'none';
      }
    }
  }

  // Auto-toggle active state for custom templates matching the time
  document.querySelectorAll('.custom-tpl').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.start === startVal && btn.dataset.end === endVal);
  });
}

function openHourModal(dk, dayNum) {
  state.modalDay = dk;
  const [y, m] = dk.split('-').map(Number);
  const dayArr = state.entries[dk] || [];
  const entry = dayArr[0]; // Assuming for now we edit the first occurrence in this modal

  state.modalEditingId = entry?.id || null;
  state.modalParentId = entry?.parent_shift_id || null;

  const existingHours = entry?.hours || 0;
  const curShift = entry?.shift_type || 'normal';

  document.getElementById('modalTitle').textContent =
    existingHours > 0 ? `Редактирай — ${fmt(existingHours)}ч` : 'Добави смяна';
  document.getElementById('modalDate').textContent = `${dayNum} ${MONTHS_BG[m - 1]} ${y}`;

  // Shift state
  state.activeShift = curShift;

  // Determine initial times
  let storedStart = entry?.shift_start || '';
  let storedEnd = entry?.shift_end || '';

  if (existingHours === 0 && !storedStart && !storedEnd && state.profile?.custom_shifts) {
    const defTpl = state.profile.custom_shifts.find(t => t.isDefault);
    if (defTpl) {
      storedStart = defTpl.start;
      storedEnd = defTpl.end;
    }
  }

  document.getElementById('shiftStart').value = storedStart;
  document.getElementById('shiftEnd').value = storedEnd;

  // Break state
  let storedBreak = entry?.break_minutes || 0;
  let storedBreakType = entry?.break_is_paid ? 'paid' : 'unpaid';

  if (existingHours === 0 && !entry?.break_minutes && state.profile?.custom_shifts) {
    const defTpl = state.profile.custom_shifts.find(t => t.isDefault);
    if (defTpl) {
      storedBreak = defTpl.break_minutes || 0;
      storedBreakType = defTpl.break_is_paid ? 'paid' : 'unpaid';
    }
  }

  const breakInput = document.getElementById('breakMinutes');
  if (breakInput) breakInput.value = storedBreak > 0 ? storedBreak : '';

  const unpaidRadio = document.getElementById('breakUnpaid');
  const paidRadio = document.getElementById('breakPaid');
  if (unpaidRadio && paidRadio) {
    if (storedBreakType === 'paid') paidRadio.checked = true;
    else unpaidRadio.checked = true;
  }

  // Update quick select buttons state based on loaded value
  document.querySelectorAll('.btn-break-quick').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.min === String(storedBreak));
  });

  updateHoursPreview();

  // Render quick templates
  const tplContainer = document.getElementById('modalTemplates');
  if (tplContainer) {
    tplContainer.innerHTML = '';
    if (state.profile?.custom_shifts) {
      state.profile.custom_shifts.forEach(tpl => {
        const btn = document.createElement('button');
        btn.className = 'shift-tag custom-tpl';
        btn.dataset.start = tpl.start;
        btn.dataset.end = tpl.end;
        btn.dataset.name = tpl.name;
        btn.style.whiteSpace = 'nowrap';
        btn.style.flexShrink = '0';
        btn.textContent = tpl.name;
        btn.onclick = () => {
          state.activeShift = 'normal'; // implicitly normal

          document.getElementById('shiftStart').value = tpl.start;
          document.getElementById('shiftEnd').value = tpl.end;

          const bMin = tpl.break_minutes || 0;
          const bPaid = tpl.break_is_paid || false;
          const tRate = tpl.rate || state.profile?.hourly_rate || DEFAULT_RATE;

          const breakInp = document.getElementById('breakMinutes');
          if (breakInp) breakInp.value = bMin > 0 ? bMin : '';

          const rateInp = document.getElementById('modalShiftRate');
          if (rateInp) rateInp.value = tRate;

          const unpaidRadio = document.getElementById('breakUnpaid');
          const paidRadio = document.getElementById('breakPaid');
          if (unpaidRadio && paidRadio) {
            if (bPaid) paidRadio.checked = true;
            else unpaidRadio.checked = true;
          }

          document.querySelectorAll('.btn-break-quick').forEach(b => {
            b.classList.toggle('active', b.dataset.min === String(bMin));
          });

          updateHoursPreview();
        };
        tplContainer.appendChild(btn);
      });
    }

    // Append the + Create Template button at the end of the horizontal list
    const createBtn = document.createElement('button');
    createBtn.className = 'shift-tag';
    createBtn.style.whiteSpace = 'nowrap';
    createBtn.style.flexShrink = '0';
    createBtn.style.borderStyle = 'dashed';
    createBtn.style.opacity = '0.7';
    createBtn.textContent = '+ Създай шаблон';
    createBtn.onclick = () => {
      closeHourModal();
      switchTab('profile');
      setTimeout(() => {
        document.getElementById('saveTplBtn')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 200);
    };
    tplContainer.appendChild(createBtn);
  }

  const defaultRate = state.profile?.hourly_rate || DEFAULT_RATE;
  const entryRate = entry?.rate || defaultRate;
  const rateInput = document.getElementById('modalShiftRate');
  if (rateInput) rateInput.value = entryRate;

  document.getElementById('hourModal').removeAttribute('hidden');
  setTimeout(() => document.getElementById('shiftStart').focus(), 50);
}

function closeHourModal() {
  document.getElementById('hourModal').setAttribute('hidden', '');
  state.modalDay = null;
  state.modalEditingId = null;
  state.modalParentId = null;
}

/**
 * Проверява за застъпване със съществуващи смени в state.entries.
 */
function isOverlapping(newShift, existingEntries) {
  const intervals = [];
  const [shN, smN] = (newShift.start || "").split(':').map(Number);
  const [ehN, emN] = (newShift.end || "").split(':').map(Number);
  if (isNaN(shN) || isNaN(ehN)) return null;

  const startN = shN * 60 + smN;
  let endN = ehN * 60 + emN;

  // Дефиниране на интервалите за новата смяна (вкл. при разделяне в полунощ)
  if (endN < startN || (endN === startN && startN !== 0)) {
    intervals.push({ dk: newShift.dayKey, s: startN, e: 1440 });
    const nd = new Date(newShift.dayKey);
    nd.setDate(nd.getDate() + 1);
    intervals.push({ dk: nd.toISOString().split('T')[0], s: 0, e: endN });
  } else {
    intervals.push({ dk: newShift.dayKey, s: startN, e: endN });
  }

  // Проверка за всеки от интервалите на новата смяна
  for (const iv of intervals) {
    const dayArr = existingEntries[iv.dk] || [];
    for (const ext of dayArr) {
      if (!ext.shift_start || !ext.shift_end) continue;
      
      // Пропускаме, ако е същата смяна, която редактираме (ID или ParentID за нощни смени)
      if (newShift.id && (ext.id === newShift.id || ext.parent_shift_id === newShift.id)) continue;
      if (newShift.parentId && (ext.id === newShift.parentId || ext.parent_shift_id === newShift.parentId)) continue;

      const [shE, smE] = ext.shift_start.split(':').map(Number);
      const [ehE, emE] = ext.shift_end.split(':').map(Number);
      const startE = shE * 60 + smE;
      const endE = ehE * 60 + emE;

      // Формула за застъпване: max(s1, s2) < min(e1, e2)
      // Позволява E1 == S2 (едната свършва, другата започва)
      if (Math.max(iv.s, startE) < Math.min(iv.e, endE)) {
        return ext;
      }
    }
  }
  return null;
}

async function saveHours() {
  const saveBtn = document.getElementById('customSave');
  if (!state.modalDay || saveBtn.disabled) return;
  const dk = state.modalDay;
  const startInp = document.getElementById('shiftStart');
  const endInp = document.getElementById('shiftEnd');
  
  // Рестартиране на стиловете за грешка
  startInp.style.borderColor = '';
  endInp.style.borderColor = '';

  const startVal = startInp.value;
  const endVal = endInp.value;

  // Проверка за застъпване преди всички други изчисления
  const collision = isOverlapping({
    dayKey: dk,
    start: startVal,
    end: endVal,
    id: state.modalEditingId || null,
    parentId: state.modalParentId || null
  }, state.entries);

  if (collision) {
    const colTime = `${collision.shift_start} - ${collision.shift_end}`;
    const collisionDay = collision.day_key && collision.day_key !== dk ? ` за ${collision.day_key}` : '';
    toast(`⚠️ Внимание: Тази смяна се застъпва с вече съществуваща (${colTime}${collisionDay})!`, 'error');
    
    startInp.style.borderColor = 'var(--red)';
    endInp.style.borderColor = 'var(--red)';
    return;
  }

  const totalHours = calcShiftHours(startVal, endVal);

  const breakMin = parseInt(document.getElementById('breakMinutes').value) || 0;
  const breakIsPaid = document.getElementById('breakPaid').checked;

  const rate = parseFloat(document.getElementById('modalShiftRate').value) || state.profile?.hourly_rate || DEFAULT_RATE;

  if (totalHours === null || totalHours <= 0 || totalHours > 24) {
    toast('Въведи валидни часове за начало и край на смяната', 'error');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span>';

  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const uid = state.user?.id || 'demo';

    // АКО Е РЕДАКЦИЯ: Първо изтриваме старата версия, за да не остават дубликати
    if (state.modalEditingId) {
      await dbDeleteShiftGroup(dk, state.modalEditingId, state.modalParentId);
    }

    // Check if overnight
    const [sh, sm] = startVal.split(':').map(Number);
    const [eh, em] = endVal.split(':').map(Number);
    const isOvernight = (eh < sh) || (eh === sh && em < sm);

    // Detect template name
    const activeTpl = document.querySelector('.custom-tpl.active');
    const templateName = activeTpl ? activeTpl.dataset.name : null;

    // Improved Night detection
    // Crossing midnight OR starting between 22:00-05:00 OR ending between 00:00-06:00
    const isNight = isOvernight || (sh >= 22 || sh <= 5);

    if (!isOvernight) {
      // Standard single shift
      let targetStatus = (dk > todayStr) ? 'planned' : 'actual';
      await dbSetEntry(dk, totalHours, rate, state.activeShift, startVal, endVal, targetStatus, null, breakMin, breakIsPaid, isNight, null, null, templateName);
    } else {
      // Split shift
      const parentId = getUUID();

      // Day 1: Start to 00:00
      const d1Hours = 24 - (sh + sm / 60);
      const d1Status = (dk > todayStr) ? 'planned' : 'actual';

      // Day 2: 00:00 to End
      const d2Hours = eh + em / 60;
      const nextDay = new Date(dk);
      nextDay.setDate(nextDay.getDate() + 1);
      const dk2 = nextDay.toISOString().split('T')[0];

      // If Day 1 is starting today or in past, mark Day 2 also as actual 
      // so the full overnight hours are counted immediately in dashboard.
      const d2Status = d1Status;

      // Split break
      const b1 = (breakMin * (d1Hours / totalHours));
      const b2 = breakMin - b1;

      await dbSetEntry(dk, d1Hours, rate, state.activeShift, startVal, '23:59', d1Status, null, Math.round(b1), breakIsPaid, true, parentId, null, templateName);
      await dbSetEntry(dk2, d2Hours, rate, state.activeShift, '00:00', endVal, d2Status, null, Math.round(b2), breakIsPaid, true, parentId, null, templateName);
    }

    state.entries = await dbLoadEntries(state.viewYear, state.viewMonth);
    closeHourModal();
    await refreshAll();
    toast(`✓ Записана ${isOvernight ? 'нощна' : 'смяна'} за ${dk}`, 'success');
  } catch (e) {
    console.error('saveHours error:', e);
    toast('Грешка при запис', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '✓ Запази смяната';
  }
}

/* ═══════════════════════════════════════════
   HISTORY
═══════════════════════════════════════════ */
async function populateHistorySelect() {
  const sel = document.getElementById('historySelect');
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
  const total = sumHours(entries);
  const salary = sumSalary(entries);
  const days = countDays(entries);
  const detail = document.getElementById('historyDetail');

  if (days === 0) {
    detail.innerHTML = '<p class="empty-state">Няма данни за избрания месец.</p>';
    return;
  }

  const sortedKeys = Object.keys(entries).sort();
  const allShifts = [];
  sortedKeys.forEach(dk => {
    const dayArr = entries[dk] || [];
    dayArr.forEach(v => {
      allShifts.push({ dayKey: dk, ...v });
    });
  });

  const rows = allShifts.map(v => {
    const [yS, mS, dS] = v.dayKey.split('-').map(Number);
    const shiftLabel = { normal: '—', overtime: '🔴 Извън.' }[v.shift_type] || '—';

    let netHrs = v.hours || 0;
    let breakText = '—';
    if (v.break_minutes > 0) {
      if (!v.break_is_paid) netHrs = Math.max(0, netHrs - (v.break_minutes / 60));
      breakText = `${v.break_minutes}м (${v.break_is_paid ? 'платена' : 'неплатена'})`;
    }

    let timeRange = '—';
    if (v.shift_start && v.shift_end) {
      timeRange = `${v.shift_start} - ${v.shift_end}`;
    }

    return `<tr>
      <td data-label="Дата">${dS} ${MONTHS_BG[mS - 1]} ${yS} ${v.is_night ? '<span title="Нощна смяна">🌙</span>' : ''}</td>
      <td data-label="Часове" style="font-family:var(--mono); font-size:0.9rem">${timeRange}</td>
      <td data-label="Бруто/Нето">${fmt(v.hours)} ч / <span style="font-size:0.8rem;color:var(--text-dim)">Нето: ${fmt(netHrs)}ч</span></td>
      <td data-label="Почивка">${breakText}</td>
      <td data-label="Ставка">${fmt(v.rate || DEFAULT_RATE)} лв.</td>
      <td data-label="Заплата">${fmt(netHrs * (v.rate || DEFAULT_RATE))} лв.</td>
      <td data-label="Смяна">${shiftLabel}</td>
    </tr>`;
  }).join('');

  detail.innerHTML = `
    <div class="history-stats">
      <div class="history-stat"><div class="hs-label">Общо часове (Нето)</div><div class="hs-value">${fmt(total)}</div></div>
      <div class="history-stat"><div class="hs-label">Заплата</div><div class="hs-value">${fmt(salary)} лв.</div></div>
      <div class="history-stat"><div class="hs-label"> Работни дни</div><div class="hs-value">${days}</div></div>
      <div class="history-stat"><div class="hs-label">Среден (Нето)</div><div class="hs-value">${fmt(days > 0 ? total / days : 0)} ч/ден</div></div>
    </div>
    <div class="table-responsive">
      <table class="history-table">
        <thead><tr><th>Дата</th><th>Часове</th><th>Бруто / Нето</th><th>Почивка</th><th>Ставка</th><th>Заплата</th><th>Смяна</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
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
  const grid = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  const tick = isDark ? '#7777aa' : '#5555aa';
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
    const dayArr = state.entries[dk] || [];
    let h = 0;
    dayArr.forEach(entry => {
      let nh = entry.hours || 0;
      if (entry.break_minutes > 0 && !entry.break_is_paid) {
        nh = Math.max(0, nh - (entry.break_minutes / 60));
      }
      h += nh;
    });
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
    data: {
      labels, datasets: [{
        label: 'Часове', data: valH, borderColor: '#3ecf8e',
        backgroundColor: 'rgba(62,207,142,0.10)', borderWidth: 2.5,
        pointBackgroundColor: '#3ecf8e', pointRadius: 5, tension: 0.4, fill: true,
      }]
    },
    options: chartBaseOpts('Месец', 'Часове'),
  });

  const ctxS = document.getElementById('salaryChart');
  if (state.charts.salary) state.charts.salary.destroy();
  state.charts.salary = new Chart(ctxS, {
    type: 'bar',
    data: {
      labels, datasets: [{
        label: 'Заплата', data: valS, backgroundColor: 'rgba(176,139,255,0.7)',
        borderColor: '#b08bff', borderWidth: 2, borderRadius: 6
      }]
    },
  });

  // Shift distribution chart (Templates)
  const shiftCounts = {};
  const templates = state.profile?.custom_shifts || [];
  const processedParents = new Set();

  Object.values(state.entries).forEach(dayArr => {
    dayArr.forEach(v => {
      // Deduplicate split shifts using parent_shift_id
      if (v.parent_shift_id) {
        if (processedParents.has(v.parent_shift_id)) return;
        processedParents.add(v.parent_shift_id);
      }

      let key = v.template_name;

      // If template_name is missing, try matching by time
      if (!key) {
        const match = templates.find(t => t.start === v.shift_start && t.end === v.shift_end);
        key = match ? match.name : 'Custom';
      }

      shiftCounts[key] = (shiftCounts[key] || 0) + 1;
    });
  });

  const chartLabels = Object.keys(shiftCounts);
  const chartValues = Object.values(shiftCounts);

  // Assign colors based on template type (Day or Night)
  const chartColors = chartLabels.map(name => {
    if (name === 'Custom') return 'rgba(119, 119, 170, 0.7)'; // --text-dim
    const tpl = templates.find(t => t.name === name);
    if (!tpl) return 'rgba(79, 141, 255, 0.7)'; // Default accent

    // Check if it's overnight
    const [sh, sm] = (tpl.start || '00:00').split(':').map(Number);
    const [eh, em] = (tpl.end || '00:00').split(':').map(Number);
    const isNight = (eh < sh) || (eh === sh && em < sm);

    return isNight ? 'rgba(59, 130, 246, 0.8)' : 'rgba(62, 207, 142, 0.8)'; // Blue for night, Green for day
  });

  const chartBorders = chartColors.map(c => c.replace('0.8', '1').replace('0.7', '1'));

  const ctxP = document.getElementById('shiftChart');
  if (state.charts.shift) state.charts.shift.destroy();
  state.charts.shift = new Chart(ctxP, {
    type: 'doughnut',
    data: {
      labels: chartLabels,
      datasets: [{
        data: chartValues,
        backgroundColor: chartColors,
        borderColor: chartBorders,
        borderWidth: 2,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: document.body.classList.contains('dark-mode') ? '#7777aa' : '#5555aa',
            font: { size: 11, family: "'Outfit', sans-serif" },
            padding: 15,
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 30, 0.9)',
          titleFont: { family: "'Outfit', sans-serif" },
          bodyFont: { family: "'Outfit', sans-serif" },
          padding: 10,
          displayColors: false
        }
      }
    },
  });
}

/* ═══════════════════════════════════════════
   PROFILE
═══════════════════════════════════════════ */
function renderProfile() {
  if (!state.profile) return;
  const p = state.profile;
  const initials = (p.full_name || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  const avatars = document.querySelectorAll('.user-avatar, #profileAvatar');
  avatars.forEach(el => {
    if (p.avatar_url) {
      el.style.backgroundImage = `url(${p.avatar_url})`;
      el.textContent = '';
    } else {
      el.style.backgroundImage = 'none';
      el.textContent = initials;
    }
  });

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
        perm === 'denied' ? '❌ Известията са блокирани' :
          '⚪ Известията не са активирани';
    } else {
      ns.textContent = '⚠️ Браузърът не поддържа известия';
    }
  }

  // Theme mode radios
  const darkRadio = document.getElementById('themeDark');
  const lightRadio = document.getElementById('themeLight');
  if (darkRadio && lightRadio) {
    if (state.darkMode) darkRadio.checked = true;
    else lightRadio.checked = true;
  }

  renderCustomShifts();
}

function renderCustomShifts() {
  const container = document.getElementById('tplList');
  if (!container) return;
  const shifts = state.profile?.custom_shifts || [];
  if (shifts.length === 0) {
    container.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim);text-align:center;">Няма добавени шаблони</div>';
    return;
  }
  container.innerHTML = shifts.map(s => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius-sm)">
      <div>
        <div style="font-size:0.85rem;font-weight:600">${s.name} ${s.isDefault ? '<span style="color:var(--accent);font-size:0.7rem;margin-left:4px">(Подразбиране)</span>' : ''}</div>
        <div style="font-size:0.75rem;color:var(--text-dim);font-family:var(--mono)">${s.start} - ${s.end} ${s.break_minutes > 0 ? `<span style="opacity:0.7;margin-left:5px">☕ ${s.break_minutes}м (${s.break_is_paid ? 'пл.' : 'непл.'})</span>` : ''}</div>
      </div>
      <div style="display:flex;gap:0.3rem">
        ${!s.isDefault ? `<button class="btn btn-outline btn-sm" style="padding:0.25rem 0.6rem" onclick="appSetDefaultCustomShift('${s.id}')" title="Направи по подразбиране">⭐</button>` : ''}
        <button class="btn btn-outline btn-sm" style="padding:0.25rem 0.6rem" onclick="appEditCustomShift('${s.id}')" title="Редактирай">✏️</button>
        <button class="btn btn-danger btn-sm" style="padding:0.25rem 0.6rem" onclick="appDeleteCustomShift('${s.id}')" title="Изтрий">🗑</button>
      </div>
    </div>
  `).join('');
}

window.appEditCustomShift = function (id) {
  const shifts = state.profile?.custom_shifts || [];
  const s = shifts.find(x => x.id === id);
  if (!s) return;
  document.getElementById('tplName').value = s.name;
  document.getElementById('tplStart').value = s.start;
  document.getElementById('tplEnd').value = s.end;
  document.getElementById('tplBreak').value = s.break_minutes || '';
  if (s.break_is_paid) document.getElementById('tplBreakPaid').checked = true;
  else document.getElementById('tplBreakUnpaid').checked = true;

  document.getElementById('saveTplBtn').dataset.editingId = id;
  document.getElementById('saveTplBtn').textContent = '💾 Обнови шаблон';
  document.getElementById('tplName').focus();
};

window.appSetDefaultCustomShift = async function (id) {
  const shifts = state.profile?.custom_shifts || [];
  shifts.forEach(s => s.isDefault = (s.id === id));
  await dbSaveProfile({ custom_shifts: shifts });
  renderCustomShifts();
  toast('Стандартният шаблон е обновен', 'info');
};

window.appDeleteCustomShift = async function (id) {
  const shifts = state.profile?.custom_shifts || [];
  const filtered = shifts.filter(s => s.id !== id);
  // Re-elect default if we deleted default
  if (!filtered.find(s => s.isDefault) && filtered.length > 0) {
    filtered[0].isDefault = true;
  }

  // Clear edit state if we delete the currently edited template
  const btn = document.getElementById('saveTplBtn');
  if (btn.dataset.editingId === id) {
    document.getElementById('tplName').value = '';
    document.getElementById('tplStart').value = '';
    document.getElementById('tplEnd').value = '';
    delete btn.dataset.editingId;
    btn.textContent = '➕ Добави шаблон';
  }

  await dbSaveProfile({ custom_shifts: filtered });
  renderCustomShifts();
  toast('Шаблонът е изтрит', 'info');
};

async function saveCustomShiftTemplate() {
  const tplNameEl = document.getElementById('tplName');
  const start = document.getElementById('tplStart').value;
  const end = document.getElementById('tplEnd').value;
  let name = tplNameEl.value;

  if (name.length > 0 && name.trim().length === 0) {
    toast('Името на шаблона не може да бъде само интервали', 'error');
    tplNameEl.value = '';
    tplNameEl.focus();
    return;
  }

  name = name.trim();

  if (!name || !start || !end) { toast('Попълнете всички полета', 'error'); return; }

  const shifts = state.profile?.custom_shifts || [];
  const btn = document.getElementById('saveTplBtn');
  const editingId = btn.dataset.editingId;

  const breakMin = parseInt(document.getElementById('tplBreak').value) || 0;
  const breakIsPaid = document.querySelector('input[name="tplBreakType"]:checked').value === 'paid';
  const tplRate = parseFloat(document.getElementById('tplRate').value) || null;

  if (editingId) {
    const s = shifts.find(x => x.id === editingId);
    if (s) {
      s.name = name; s.start = start; s.end = end;
      s.break_minutes = breakMin; s.break_is_paid = breakIsPaid;
      s.rate = tplRate;
    }
    delete btn.dataset.editingId;
    btn.textContent = '➕ Добави шаблон';
    toast('Шаблонът е обновен', 'success');
  } else {
    const isDefault = shifts.length === 0; // first one is default
    shifts.push({
      id: Date.now().toString(),
      name, start, end, isDefault,
      break_minutes: breakMin,
      break_is_paid: breakIsPaid,
      rate: tplRate
    });
    toast('Шаблонът е добавен', 'success');
  }

  await dbSaveProfile({ custom_shifts: shifts });

  document.getElementById('tplName').value = '';
  document.getElementById('tplBreak').value = '0';
  document.getElementById('tplRate').value = '';
  renderCustomShifts();
}

async function handleAvatarUpload(file) {
  if (!file) return;
  if (file.size > 1024 * 1024) {
    toast('❌ Снимката е твърде голяма (макс. 1MB)', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result;
    state.profile.avatar_url = base64;
    toast('⌛ Запазване...', 'info');
    await dbSaveProfile({ avatar_url: base64 });
    renderProfile();
    toast('✅ Снимката е обновена', 'success');
  };
  reader.readAsDataURL(file);
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
  const total = sumHours(entries);
  const salary = sumSalary(entries);

  let csv = '\uFEFFДата,Часове,Ставка (лв.),Заплата (лв.),Тип смяна\n';
  Object.keys(entries).sort().forEach(dk => {
    const v = entries[dk];
    const shiftBG = { normal: 'Нормален', overtime: 'Извънреден', weekend: 'Уикенд' }[v.shift_type] || 'Нормален';
    csv += `${dk},${fmt(v.hours)},${fmt(v.rate || DEFAULT_RATE)},${fmt(v.hours * (v.rate || DEFAULT_RATE))},${shiftBG}\n`;
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
    const total = sumHours(entries);
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
    doc.text('Shifster Solo', 14, 18);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.setTextColor(119, 119, 170);
    doc.text(`Отчет за работни часове — ${monthName}`, 14, 27);
    doc.text(`Потребител: ${userName}  |  Генериран: ${new Date().toLocaleDateString('bg-BG')}`, 14, 34);

    // Accent line
    doc.setFillColor(79, 141, 255);
    doc.rect(0, 43, 210, 2, 'F');

    // Summary cards
    const boxes = [
      { label: 'Общо часове', value: `${fmt(total)} ч`, color: [79, 141, 255] },
      { label: 'Заплата', value: `${fmt(salary)} лв.`, color: [62, 207, 142] },
      { label: 'Работни дни', value: countDays(entries), color: [255, 179, 71] },
    ];
    let bx = 14;
    boxes.forEach(b => {
      doc.setFillColor(22, 22, 40);
      doc.roundedRect(bx, 50, 58, 22, 4, 4, 'F');
      doc.setDrawColor(...b.color); doc.setLineWidth(0.5);
      doc.roundedRect(bx, 50, 58, 22, 4, 4, 'S');
      doc.setFontSize(7); doc.setFont('helvetica', 'normal');
      doc.setTextColor(119, 119, 170);
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
    doc.setTextColor(160, 160, 200); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    doc.text('Дата', 18, tt + 5.5); doc.text('Часове', 70, tt + 5.5);
    doc.text('Ставка', 100, tt + 5.5); doc.text('Заплата', 132, tt + 5.5); doc.text('Смяна', 168, tt + 5.5);

    let ty = tt + 8;
    const shiftLabel = { normal: 'Нормален', overtime: 'Извънреден', weekend: 'Уикенд' };
    sorted.forEach((dk, i) => {
      const v = entries[dk];
      if (i % 2 === 0) { doc.setFillColor(16, 16, 30); doc.rect(14, ty, 182, 7, 'F'); }
      doc.setTextColor(200, 200, 220); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      doc.text(dk, 18, ty + 4.8);
      doc.text(`${fmt(v.hours)} ч`, 70, ty + 4.8);
      doc.text(`${fmt(v.rate || DEFAULT_RATE)} лв.`, 100, ty + 4.8);
      doc.text(`${fmt(v.hours * (v.rate || DEFAULT_RATE))} лв.`, 132, ty + 4.8);
      doc.text(shiftLabel[v.shift_type] || 'Нормален', 168, ty + 4.8);
      ty += 7;
      if (ty > 272) { doc.addPage(); ty = 20; }
    });

    // Footer
    ty += 3;
    doc.setDrawColor(79, 141, 255); doc.setLineWidth(0.5); doc.line(14, ty, 196, ty);
    ty += 7;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(79, 141, 255);
    doc.text(`ОБЩО: ${fmt(total)} ч = ${fmt(salary)} лв.`, 18, ty);

    doc.save(`work-hours-${ym}.pdf`);
    toast('✓ PDF изтеглен', 'success');
  } catch (e) {
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
      ['Shifster Solo — Отчет за работни часове'],
      [`Месец: ${monthName}  |  Потребител: ${state.profile?.full_name || 'Потребител'}`],
      [],
      ['Дата', 'Часове', 'Ставка (лв./ч)', 'Заплата (лв.)', 'Тип смяна'],
    ];

    const shiftLabel = { normal: 'Нормален', overtime: 'Извънреден', weekend: 'Уикенд' };
    sorted.forEach(dk => {
      const v = entries[dk];
      wsData.push([dk, v.hours, v.rate || DEFAULT_RATE, v.hours * (v.rate || DEFAULT_RATE), shiftLabel[v.shift_type] || 'Нормален']);
    });

    wsData.push([]);
    wsData.push(['ОБЩО', sumHours(entries), '', sumSalary(entries), '']);

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, monthName);
    XLSX.writeFile(wb, `work-hours-${ym}.xlsx`);
    toast('✓ Excel изтеглен', 'success');
  } catch (e) {
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
  // Check every hour for missed past days
  setInterval(checkMissedDay, 3600 * 1000);
  checkMissedDay();

  // Check every 5 minutes for planned shift wrap-up
  setInterval(checkSmartNotifications, 5 * 60 * 1000);
  checkSmartNotifications();
}

function checkSmartNotifications() {
  if (Notification.permission !== 'granted') return;
  const today = new Date().toISOString().split('T')[0];
  const entry = state.entries[today];
  // If today is a planned shift and has an end time
  if (entry && entry.status === 'planned' && entry.shift_end) {
    const [eh, em] = entry.shift_end.split(':').map(Number);
    const now = new Date();
    // Planned end time exact Date object
    const endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh, em, 0).getTime();

    // We notify 30 minutes AFTER the shift ends. So target is endMs + 30 mins
    const targetMs = endMs + (30 * 60 * 1000);

    const notifKey = `notif_planned_${today}`;
    if (now.getTime() >= targetMs && !localStorage.getItem(notifKey)) {
      new Notification('LÚMËVAR', {
        body: 'Време е да потвърдите изработените часове за днес!',
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
      });
      localStorage.setItem(notifKey, '1');
    }
  }
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
  const yk = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  const entry = state.entries[yk];
  if (!entry || entry.hours <= 0) {
    new Notification('Shifster Solo ⏱', {
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
  document.querySelectorAll('.nav-btn, .avatar-wrap').forEach(el => el.classList.remove('active'));

  const targetTab = document.getElementById(`tab-${tabId}`);
  if (targetTab) targetTab.classList.add('active');

  const btn = document.querySelector(`[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');

  if (tabId === 'dashboard') await renderDashboard();
  if (tabId === 'calendar') renderCalendar();
  if (tabId === 'history') await populateHistorySelect();
  if (tabId === 'charts') await renderCharts();
  if (tabId === 'profile') renderProfile();
}

/* ═══════════════════════════════════════════
   THEME
═══════════════════════════════════════════ */
function applyTheme(dark) {
  state.darkMode = dark;
  document.body.classList.toggle('dark-mode', dark);
  document.body.classList.toggle('light-mode', !dark);

  const darkRadio = document.getElementById('themeDark');
  const lightRadio = document.getElementById('themeLight');
  if (darkRadio && lightRadio) {
    if (dark) darkRadio.checked = true;
    else lightRadio.checked = true;
  }

  LS.saveSettings({ ...LS.loadSettings(), darkMode: dark });

  // Sync to Supabase if logged in
  if (state.user && !state.demoMode && state.profile) {
    dbSaveProfile({ dark_mode: dark });
  }
}

/* ═══════════════════════════════════════════
   MONTH NAVIGATION
═══════════════════════════════════════════ */
async function changeMonth(delta) {
  let m = state.viewMonth + delta;
  let y = state.viewYear;
  if (m > 11) { m = 0; y++; }
  if (m < 0) { m = 11; y--; }
  state.viewMonth = m;
  state.viewYear = y;
  state.entries = await dbLoadEntries(y, m);
  await refreshAll();
}

/* ═══════════════════════════════════════════
   REFRESH
═══════════════════════════════════════════ */
async function refreshAll() {
  if (state.activeTab === 'dashboard' || true) await renderDashboard();
  renderCalendar();
  if (state.activeTab === 'charts') await renderCharts();
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
      const targetId = `auth${t.dataset.auth.charAt(0).toUpperCase()}${t.dataset.auth.slice(1)}`;
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  // Login
  const loginBtn = document.getElementById('loginBtn');
  loginBtn?.addEventListener('click', async () => {
    const email = document.getElementById('loginEmail')?.value.trim();
    const pass = document.getElementById('loginPassword')?.value;
    const msg = document.getElementById('authMsg');
    if (!email || !pass) {
      if (msg) { msg.textContent = 'Попълни всички полета.'; msg.className = 'auth-msg error'; }
      return;
    }
    loginBtn.innerHTML = '<span class="spinner"></span>';
    const { error } = await loginUser(email, pass);
    if (error) {
      if (msg) { msg.textContent = error.message; msg.className = 'auth-msg error'; }
      loginBtn.textContent = 'Влез в акаунта';
    } else {
      window.location.href = 'app.html';
    }
  });

  // Register
  const regBtn = document.getElementById('registerBtn');
  regBtn?.addEventListener('click', async () => {
    const name = document.getElementById('regName')?.value.trim();
    const email = document.getElementById('regEmail')?.value.trim();
    const pass = document.getElementById('regPassword')?.value;
    const msg = document.getElementById('authMsg');
    if (!name || !email || !pass) {
      if (msg) { msg.textContent = 'Попълни всички полета.'; msg.className = 'auth-msg error'; }
      return;
    }
    regBtn.innerHTML = '<span class="spinner"></span>';
    const { error } = await registerUser(email, pass, name);
    if (error) {
      if (msg) { msg.textContent = error.message; msg.className = 'auth-msg error'; }
      regBtn.textContent = 'Създай акаунт';
    } else {
      if (msg) {
        msg.textContent = '✓ Акаунтът е създаден! Провери имейла си за потвърждение.';
        msg.className = 'auth-msg success';
      }
      regBtn.textContent = 'Създай акаунт';
    }
  });

  // Demo
  document.getElementById('demoBtn')?.addEventListener('click', enterDemoMode);
}

function wireAppEvents() {
  if (!document.getElementById('dashPrev')) return;

  // Nav tabs
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Dark mode
  document.getElementById('darkToggle')?.addEventListener('click', () => applyTheme(!state.darkMode));

  // Month nav (calendar)
  document.getElementById('prevMonth')?.addEventListener('click', () => changeMonth(-1));
  document.getElementById('nextMonth')?.addEventListener('click', () => changeMonth(+1));

  // Dashboard month nav
  document.getElementById('dashPrev')?.addEventListener('click', () => changeMonth(-1));
  document.getElementById('dashNext')?.addEventListener('click', () => changeMonth(+1));


  // Time picker — live preview
  document.getElementById('shiftStart')?.addEventListener('input', updateHoursPreview);
  document.getElementById('shiftEnd')?.addEventListener('input', updateHoursPreview);
  document.getElementById('modalShiftRate')?.addEventListener('input', updateHoursPreview);

  // Save shift button
  document.getElementById('customSave')?.addEventListener('click', saveHours);

  // Custom templates setting
  document.getElementById('saveTplBtn')?.addEventListener('click', saveCustomShiftTemplate);

  // Clear day
  document.getElementById('clearDay')?.addEventListener('click', async () => {
    if (!state.modalDay) return;
    await dbSetEntry(state.modalDay, 0, 0, 'normal');
    state.entries = await dbLoadEntries(state.viewYear, state.viewMonth);
    closeHourModal();
    await refreshAll();
  });

  // Close hour modal
  document.getElementById('closeModal')?.addEventListener('click', closeHourModal);
  document.getElementById('hourModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('hourModal')) closeHourModal();
  });

  // Exports
  document.getElementById('exportCSV')?.addEventListener('click', exportCSV);
  document.getElementById('exportPDF')?.addEventListener('click', exportPDF);
  document.getElementById('exportXLSX')?.addEventListener('click', exportXLSX);

  // Reset month
  document.getElementById('resetMonth')?.addEventListener('click', confirmReset);
  document.getElementById('confirmOK')?.addEventListener('click', doReset);
  document.getElementById('confirmCancel')?.addEventListener('click', () =>
    document.getElementById('confirmModal')?.setAttribute('hidden', ''));
  document.getElementById('confirmModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('confirmModal'))
      document.getElementById('confirmModal')?.setAttribute('hidden', '');
  });

  // History selector
  document.getElementById('historySelect')?.addEventListener('change', e => renderHistoryDetail(e.target.value));

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
  document.getElementById('editGoalBtn')?.addEventListener('click', () => {
    const input = document.getElementById('goalModalInput');
    if (input) input.value = state.profile?.monthly_goal || 160;
    document.getElementById('goalModal')?.removeAttribute('hidden');
  });
  document.getElementById('goalModalSave')?.addEventListener('click', () => {
    const input = document.getElementById('goalModalInput');
    if (input) saveGoal(input.value);
    document.getElementById('goalModal')?.setAttribute('hidden', '');
  });
  document.getElementById('goalModalClose')?.addEventListener('click', () =>
    document.getElementById('goalModal')?.setAttribute('hidden', ''));

  // Profile — rate save
  document.getElementById('saveRateBtn')?.addEventListener('click', () => {
    const input = document.getElementById('newRateInput');
    if (input) {
      saveRate(input.value);
      input.value = '';
    }
  });

  // Profile — goal save
  document.getElementById('saveGoalBtn')?.addEventListener('click', () => {
    const input = document.getElementById('goalInput');
    if (input) saveGoal(input.value);
  });

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
    const colors = ['#4f8dff', '#3ecf8e', '#ff6b6b', '#ffb347', '#b08bff', '#ff7eb3', '#00d4ff'];
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
  document.getElementById('enableNotifBtn')?.addEventListener('click', enableNotifications);
  document.getElementById('notifBtn')?.addEventListener('click', enableNotifications);
  document.getElementById('reminderTime')?.addEventListener('change', async e => {
    await dbSaveProfile({ notif_time: e.target.value });
    toast('✓ Час за напомняне запазен', 'success');
  });

  // Logout
  document.getElementById('logoutBtn')?.addEventListener('click', logoutUser);

  // Avatar photo upload
  document.getElementById('triggerAvatarUpload')?.addEventListener('click', () => {
    document.getElementById('avatarFileInput')?.click();
  });
  document.getElementById('avatarFileInput')?.addEventListener('change', e => {
    if (e.target.files && e.target.files[0]) handleAvatarUpload(e.target.files[0]);
  });

  // Theme Mode selector
  document.querySelectorAll('input[name="themeMode"]').forEach(radio => {
    radio.addEventListener('change', () => applyTheme(radio.value === 'dark'));
  });

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

  // Break Section Events
  document.getElementById('breakToggleHeader')?.addEventListener('click', () => {
    const content = document.getElementById('breakCollapseContent');
    const btn = document.getElementById('breakExpandBtn');
    if (!content || !btn) return;

    if (content.style.display === 'none' || content.style.display === '') {
      content.style.display = 'flex';
      btn.textContent = '−';
    } else {
      content.style.display = 'none';
      btn.textContent = '+';
    }
  });

  document.querySelectorAll('.btn-break-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-break-quick').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('breakMinutes').value = btn.dataset.min;
      updateHoursPreview();
    });
  });

  document.getElementById('breakMinutes')?.addEventListener('input', () => {
    const val = document.getElementById('breakMinutes').value;
    document.querySelectorAll('.btn-break-quick').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.min === val);
    });
    updateHoursPreview();
  });

  document.querySelectorAll('input[name="breakType"]').forEach(radio => {
    radio.addEventListener('change', updateHoursPreview);
  });

  // Rate Section Events
  document.getElementById('rateToggleHeader')?.addEventListener('click', () => {
    const content = document.getElementById('rateCollapseContent');
    const btn = document.getElementById('rateExpandBtn');
    if (!content || !btn) return;

    if (content.style.display === 'none' || content.style.display === '') {
      content.style.display = 'flex';
      btn.textContent = '−';
    } else {
      content.style.display = 'none';
      btn.textContent = '+';
    }
  });
}

/* ═══════════════════════════════════════════
   SERVICE WORKER
═══════════════════════════════════════════ */
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .catch(() => {}); // Silent fail for SW
  }
}

/* ═══════════════════════════════════════════
   INIT
═══════════════════════════════════════════ */
async function init() {
  window.scrollTo(0, 0); // Винаги започвай от най-отгоре при рефреш
  const isAppPage = window.location.pathname.includes('app.html');
  const settings = LS.loadSettings();
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(typeof settings.darkMode === 'boolean' ? settings.darkMode : prefersDark);

  initSupabase();

  if (isAppPage) {
    wireAppEvents();
  } else {
    wireAuthEvents();
  }

  let session = null;
  if (sb) {
    try {
      const { data, error } = await sb.auth.getSession();
      if (!error) session = data?.session;
    } catch (e) { /* silent catch */ }
  }

  const isDemo = settings.demo_mode === true;

  if (isAppPage) {
    if (session?.user || isDemo) {
      state.user = session?.user || { id: 'demo', email: 'demo@shifster.local' };
      state.demoMode = isDemo;
      await bootApp();
    } else {
      window.location.href = 'index.html';
    }
  } else {
    // Auth page: if already logged in, go to app
    if (session?.user || isDemo) {
      window.location.href = 'app.html';
    }
  }

  registerSW();
}

/* ═══════════════════════════════════════════
   WALKTHROUGH TUTORIAL
═══════════════════════════════════════════ */
function getTutorialSteps() {
  const isMobile = window.innerWidth < 768;
  const steps = [];
  
  if (isMobile) {
    // На мобилен разделяме статистиките на 2 стъпки за по-малка "дупка"
    steps.push({ 
      ids: ['cardHours', 'cardSalary'], 
      text: 'Тук ще виждаш колко пари си изработил и колко часа си направил в реално време.' 
    });
    steps.push({ 
      ids: ['cardDays', 'cardAvg'], 
      text: 'Тук виждаш статистиката за работните дни и средната продължителност на смените си.' 
    });
  } else {
    // На десктоп подчертаваме всичко заедно
    steps.push({ 
      id: 'statsGrid', 
      text: 'Това са твоите живи данни. Когато добавиш смяна, тук ще видиш часовете и парите си в реално време.' 
    });
  }
  
  // Общи стъпки
  steps.push({ 
    id: 'dashboardFilters', 
    text: 'Това са твоите бързи шаблони. Shifster ги зареди автоматично за твоята роля, за да спестиш време.' 
  });
  steps.push({ 
    selector: '.nav-btn[data-tab="calendar"]', 
    text: 'Тук се случва магията. Отиди в календара, за да впишеш първата си смяна и да планираш месеца!' 
  });
  
  return steps;
}

let tutorialIdx = 0;
let activeTutorialSteps = [];

function startTutorial() {
  const overlay = document.getElementById('tutorialOverlay');
  if (!overlay) return;

  activeTutorialSteps = getTutorialSteps();
  tutorialIdx = 0;
  
  document.body.classList.add('tutorial-active');
  overlay.removeAttribute('hidden');
  overlay.style.opacity = '1';
  
  document.getElementById('btnTutorialNext').onclick = nextTutorialStep;
  showTutorialStep(0);
}



function showTutorialStep(idx) {
  const step = activeTutorialSteps[idx];
  let target;
  let rect;
  
  if (step.ids) {
    // Union rect за масив от елементи
    const boxes = step.ids.map(id => document.getElementById(id).getBoundingClientRect());
    const top = Math.min(...boxes.map(b => b.top));
    const left = Math.min(...boxes.map(b => b.left));
    const bottom = Math.max(...boxes.map(b => b.bottom));
    const right = Math.max(...boxes.map(b => b.right));
    rect = { top, left, bottom, right, width: right - left, height: bottom - top };
    target = document.getElementById(step.ids[0]); // ползваме за скрол
  } else {
    target = step.id ? document.getElementById(step.id) : document.querySelector(step.selector);
    if (!target) return nextTutorialStep();
    rect = target.getBoundingClientRect();
  }
  
  // Първо скролваме до елемента
  // На мобилен центрираме по-агресивно
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  setTimeout(() => {
    const spotlight = document.getElementById('tutorialSpotlight');
    // Опресняваме rect след скрола
    if (step.ids) {
      const boxes = step.ids.map(id => document.getElementById(id).getBoundingClientRect());
      const top = Math.min(...boxes.map(b => b.top));
      const left = Math.min(...boxes.map(b => b.left));
      const bottom = Math.max(...boxes.map(b => b.bottom));
      const right = Math.max(...boxes.map(b => b.right));
      rect = { top, left, bottom, right, width: right - left, height: bottom - top };
    } else {
      rect = target.getBoundingClientRect();
    }
    
    // ПОЗИЦИОНИРАНЕ НА НЕОНОВИЯ РИНГ
    spotlight.style.width = `${rect.width + 16}px`;
    spotlight.style.height = `${rect.height + 16}px`;
    spotlight.style.top = `${rect.top - 8}px`;
    spotlight.style.left = `${rect.left - 8}px`;
    
    // МАГИЯТА: Изрязване на "кристална дупка" в overlay-я
    const overlay = document.getElementById('tutorialOverlay');
    const hx1 = rect.left - 8;
    const hy1 = rect.top - 8;
    const hx2 = rect.right + 8;
    const hy2 = rect.bottom + 8;
    
    // Инвертиран полигон (Дупка в центъра)
    overlay.style.clipPath = `polygon(0% 0%, 0% 100%, ${hx1}px 100%, ${hx1}px ${hy1}px, ${hx2}px ${hy1}px, ${hx2}px ${hy2}px, ${hx1}px ${hy2}px, ${hx1}px 100%, 100% 100%, 100% 0%)`;
    
    // ИНТЕЛИГЕНТНО ПОЗИЦИОНИРАНЕ НА ПОДСКАЗКАТА
    const tooltip = document.getElementById('tutorialTooltip');
    const isMobile = window.innerWidth < 768;
    const gap = isMobile ? 12 : 30; 
    const tipWidth = tooltip.offsetWidth || 340;
    const tipHeight = tooltip.offsetHeight || 180;
    
    // 1. Мобилна логика: Специализирани позиции
    if (isMobile) {
      if (idx === 0) {
        // Първа стъпка - Текстът отива най-отгоре
        tooltip.style.bottom = 'auto';
        tooltip.style.top = '15%'; 
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translate(-50%, 0)';
      } else if (idx === activeTutorialSteps.length - 1) {
        // ПОСЛЕДНА СТЪПКА - Точно под Календара (да не е баш долу)
        tooltip.style.bottom = 'auto';
        tooltip.style.top = `${rect.bottom + 20}px`;
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translateX(-50%)';
      } else if (rect.top < 350) {
        // Ако подчертаваме нещо в горната част, подсказката отива долу
        tooltip.style.top = 'auto';
        tooltip.style.bottom = '40px';
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translateX(-50%)';
      } else {
        // Стандартно за мобилни (Центрирано горе)
        tooltip.style.bottom = 'auto';
        tooltip.style.top = '120px';
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translateX(-50%)';
      }
    } else {
      // Стандартна логика за десктоп (Над или Под)
      tooltip.style.bottom = 'auto';
      tooltip.style.transform = 'translate(-50%, -50%)';
      
      let finalLeft = rect.left + rect.width / 2;
      finalLeft = Math.max(tipWidth / 2 + 16, Math.min(window.innerWidth - tipWidth / 2 - 16, finalLeft));
      
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      let finalTop;
      
      if (spaceBelow > tipHeight + gap * 2) {
        finalTop = rect.bottom + gap + tipHeight / 2;
      } else {
        finalTop = rect.top - gap - tipHeight / 2;
      }
      
      tooltip.style.left = `${finalLeft}px`;
      tooltip.style.top = `${finalTop}px`;
    }
    
    
    // Обновяване на текста
    document.getElementById('tutorialText').textContent = step.text;
    document.getElementById('tutorialStepCount').textContent = `${idx + 1}/${activeTutorialSteps.length}`;
    document.getElementById('btnTutorialNext').textContent = idx === activeTutorialSteps.length - 1 ? 'Разбрах!' : 'Напред →';
  }, 400);
}

function nextTutorialStep() {
  tutorialIdx++;
  if (tutorialIdx >= activeTutorialSteps.length) {
    finishTutorial();
  } else {
    showTutorialStep(tutorialIdx);
  }
}

async function finishTutorial() {
  const overlay = document.getElementById('tutorialOverlay');
  overlay.style.opacity = '0';
  overlay.style.clipPath = 'none'; // Ресет на дупката
  
  document.body.classList.remove('tutorial-active');
  
  setTimeout(() => {
    overlay.setAttribute('hidden', '');
    overlay.style.opacity = '1';
  }, 400);

  // Persistence (Локално е достатъчно)
  const settings = LS.loadSettings();
  LS.saveSettings({ ...settings, tutorial_done: true });
  
  toast('Супер! Сега си господар на своето време. 👋', 'success');
}


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Излагаме функциите към Window за съвместимост с HTML (onclick и т.н.)
window.onboardingBack = onboardingBack;
window.switchTab = switchTab;
window.resetTutorial = resetTutorial;
window.startTutorial = startTutorial;
window.finishTutorial = finishTutorial;
window.openHourModal = openHourModal;
window.closeHourModal = closeHourModal;
window.onboardingSelectIndustry = onboardingSelectIndustry;
window.onboardingSelectRole = onboardingSelectRole;
window.showOnboarding = showOnboarding;
window.onboardingBack = onboardingBack;
window.saveHours = saveHours;
window.saveGoal = saveGoal;
window.saveRate = saveRate;
window.exportCSV = exportCSV;
window.exportPDF = exportPDF;
window.exportXLSX = exportXLSX;
window.confirmReset = confirmReset;
window.doReset = doReset;
window.renderHistoryDetail = renderHistoryDetail;
window.saveCustomShiftTemplate = saveCustomShiftTemplate;
