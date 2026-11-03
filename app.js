/**
 * Smart Sawah Guard v2.4 IoT
 * Frontend Application Logic (versi production)
 *
 * Pembagian tugas:
 *  - Dashboard : mengatur jadwal (Firebase /schedules) dan tombol alarm manual (Firebase /status).
 *  - ESP32     : membaca jadwal + status, mengecek waktu sendiri via NTP, lalu memutar suara.
 *  - Alarm manual dikirim sebagai alarm=true + alarm_until (epoch detik) agar tidak
 *    "nyangkut" kalau tab ditutup sebelum alarm dimatikan.
 */

// ==========================================
// 1. KONFIGURASI & STATE
// ==========================================
const FIREBASE_URL = 'https://comproiot-355aa-default-rtdb.asia-southeast1.firebasedatabase.app';
const MANUAL_ALARM_SECONDS = 10;
const HEARTBEAT_MS = 15000;
const MAX_LOGS = 50;

const DEFAULT_SCHEDULES = [
  { id: 1, start: '05:00', end: '07:00', duration: '2 jam', active: true, label: 'Pagi Hari' },
  { id: 2, start: '17:00', end: '19:00', duration: '2 jam', active: true, label: 'Sore Hari' }
];

function safeParse(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

const today = new Date();

const AppState = {
  alarmActive: false,        // alarm manual sedang berjalan
  alarmSource: '',
  alarmTimer: null,
  isScheduleActive: false,   // sedang di dalam rentang jadwal
  activeScheduleInfo: null,
  schedules: safeParse('ssg_schedules', DEFAULT_SCHEDULES),
  logs: safeParse('ssg_logs', []),
  calendar: {
    year: today.getFullYear(),
    month: today.getMonth(),
    selectedDay: today.getDate()
  }
};

// ==========================================
// 2. HELPERS
// ==========================================
function pad2(n) {
  return String(n).padStart(2, '0');
}

function nowTimeStr() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function addLog(event, info, alarmStatus) {
  AppState.logs.push({ time: nowTimeStr(), event, distance: info, alarmStatus });
  if (AppState.logs.length > MAX_LOGS) {
    AppState.logs = AppState.logs.slice(-MAX_LOGS);
  }
  localStorage.setItem('ssg_logs', JSON.stringify(AppState.logs));
  renderLogs();
}

function calculateDuration(start, end) {
  try {
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    let diff = (endH * 60 + endM) - (startH * 60 + startM);
    if (diff < 0) diff += 24 * 60; // lewat tengah malam
    const hours = Math.floor(diff / 60);
    const mins = diff % 60;
    if (hours === 0) return `${mins} menit`;
    if (mins === 0) return `${hours} jam`;
    return `${hours} jam ${mins} menit`;
  } catch {
    return '-';
  }
}

function isTimeInRange(currentTime, startTime, endTime) {
  if (startTime === endTime) return false;
  if (startTime < endTime) {
    return currentTime >= startTime && currentTime < endTime;
  }
  // Lewat tengah malam (mis. 23:00 - 02:00)
  return currentTime >= startTime || currentTime < endTime;
}

// ==========================================
// 3. UI RENDERING
// ==========================================
function renderSchedules() {
  const tbody = document.getElementById('schedule-table-body');
  if (!tbody) return;

  if (AppState.schedules.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-6 text-center text-slate-400">
          <i class="fa-regular fa-clock mb-1 text-base"></i>
          <p>Belum ada jadwal yang dikonfigurasi.</p>
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = AppState.schedules.map((sch, index) => `
      <tr class="hover:bg-slate-50/70 transition">
        <td class="py-3.5 px-3 text-slate-400 font-medium">${index + 1}</td>
        <td class="py-3.5 px-3 font-semibold text-slate-800">
          ${escapeHtml(sch.start)} - ${escapeHtml(sch.end)}
          ${sch.label ? `<div class="text-[11px] font-medium text-slate-400">${escapeHtml(sch.label)}</div>` : ''}
        </td>
        <td class="py-3.5 px-3 text-slate-600">${escapeHtml(sch.duration || calculateDuration(sch.start, sch.end))}</td>
        <td class="py-3.5 px-3 text-center">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
            sch.active
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-slate-100 text-slate-400 border border-slate-200'
          }">
            ${sch.active ? 'Aktif' : 'Mati'}
          </span>
        </td>
        <td class="py-3.5 px-3 text-center">
          <div class="flex items-center justify-center gap-2">
            <label class="switch">
              <input type="checkbox" ${sch.active ? 'checked' : ''} onchange="toggleSchedule(${sch.id})">
              <span class="slider"></span>
            </label>
            <button onclick="deleteSchedule(${sch.id})" title="Hapus Jadwal" class="text-slate-300 hover:text-red-500 transition p-1">
              <i class="fa-solid fa-trash-can text-xs"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  updateActiveSchedulesCount();
  localStorage.setItem('ssg_schedules', JSON.stringify(AppState.schedules));
}

function updateActiveSchedulesCount() {
  const activeSchedules = AppState.schedules.filter(s => s.active);
  const countEl = document.getElementById('active-schedules-count');
  const subtextEl = document.getElementById('active-schedules-subtext');
  const hintEl = document.getElementById('next-schedule-hint');

  if (countEl) countEl.innerText = activeSchedules.length;
  if (subtextEl) {
    subtextEl.innerText = activeSchedules.length > 0 ? 'Berjalan Sesuai Waktu' : 'Semua Jadwal Nonaktif';
  }

  if (hintEl) {
    if (activeSchedules.length === 0) {
      hintEl.innerText = 'Tidak ada jadwal aktif';
      return;
    }
    const d = new Date();
    const nowHm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const sorted = [...activeSchedules].sort((a, b) => a.start.localeCompare(b.start));
    const next = sorted.find(s => s.start > nowHm) || sorted[0];
    hintEl.innerText = `Jadwal berikutnya: ${next.start}`;
  }
}

function renderCalendar() {
  const monthNames = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];

  const monthYearEl = document.getElementById('calendar-month-year');
  const daysGridEl = document.getElementById('calendar-days-grid');
  if (!monthYearEl || !daysGridEl) return;

  const { year, month, selectedDay } = AppState.calendar;
  monthYearEl.innerText = `${monthNames[month]} ${year}`;

  const firstDayIndex = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === month;

  let html = '';
  for (let i = 0; i < firstDayIndex; i++) {
    html += `<div class="calendar-day empty text-transparent">-</div>`;
  }

  for (let day = 1; day <= totalDays; day++) {
    const isSelected = (day === selectedDay);
    const isToday = isCurrentMonth && day === now.getDate();
    let dayClass = 'calendar-day text-slate-700';
    if (isSelected) dayClass = 'calendar-day active';
    else if (isToday) dayClass = 'calendar-day today-ring';
    html += `<div class="${dayClass}" onclick="selectCalendarDay(${day})">${day}</div>`;
  }

  daysGridEl.innerHTML = html;
}

function renderLogs() {
  const tbody = document.getElementById('log-table-body');
  if (!tbody) return;

  if (AppState.logs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="py-12 text-center text-slate-400">
          <div class="w-12 h-12 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-300 mb-2">
            <i class="fa-regular fa-folder-open text-xl"></i>
          </div>
          <p class="text-xs font-medium">Belum ada aktivitas tercatat.</p>
        </td>
      </tr>
    `;
    return;
  }

  const recentLogs = AppState.logs.slice(-5).reverse();
  tbody.innerHTML = recentLogs.map(log => `
    <tr class="hover:bg-slate-50 transition">
      <td class="py-3 px-3 font-mono text-[11px] text-slate-500">${escapeHtml(log.time)}</td>
      <td class="py-3 px-3 font-semibold text-slate-800">
        <div class="flex items-center gap-2">
          <i class="fa-solid fa-bullhorn text-red-500 text-xs"></i>
          <span>${escapeHtml(log.event)}</span>
        </div>
      </td>
      <td class="py-3 px-3 text-slate-600 text-xs">${escapeHtml(log.distance || '-')}</td>
      <td class="py-3 px-3 text-center">
        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-600 border border-red-200">
          ${escapeHtml(log.alarmStatus || 'AKTIF')}
        </span>
      </td>
    </tr>
  `).join('');
}

// Menggambar kartu status alarm berdasarkan state saat ini
function renderAlarmUI() {
  const card = document.getElementById('card-status-alarm');
  const badge = document.getElementById('alarm-status-badge');
  const subtext = document.getElementById('alarm-status-subtext');
  const icon = document.getElementById('alarm-icon');
  const iconContainer = document.getElementById('alarm-icon-container');
  const countdownBar = document.getElementById('alarm-countdown-bar');
  const logicText = document.getElementById('system-logic-text');

  const on = AppState.alarmActive || AppState.isScheduleActive;

  if (on) {
    if (card) card.classList.add('alarm-active-card');
    if (badge) {
      badge.innerText = 'AKTIF';
      badge.className = 'text-3xl font-extrabold text-red-600 tracking-tight animate-pulse';
    }
    if (icon) icon.className = 'fa-solid fa-bell text-red-600 animate-bounce text-base';
    if (iconContainer) iconContainer.className = 'w-9 h-9 rounded-xl bg-red-100 text-red-600 flex items-center justify-center';

    if (AppState.alarmActive) {
      if (subtext) subtext.innerText = `Sirine Berbunyi (${AppState.alarmSource})`;
      if (logicText) logicText.innerText = 'Logika: Sirine berbunyi mengusir hama burung.';
    } else {
      const s = AppState.activeScheduleInfo;
      if (subtext) subtext.innerText = `Menyala Sesuai Jadwal (${s.start} - ${s.end})`;
      if (logicText) logicText.innerText = `Logika: Jadwal keamanan aktif (${s.label || 'Sawah'}), sirine diputar ESP32 secara acak.`;
      if (countdownBar) {
        countdownBar.style.transition = 'none';
        countdownBar.style.width = '100%';
      }
    }
  } else {
    if (card) card.classList.remove('alarm-active-card');
    if (badge) {
      badge.innerText = 'MATI';
      badge.className = 'text-3xl font-extrabold text-slate-800 tracking-tight';
    }
    if (subtext) subtext.innerText = 'Tidak ada alarm aktif';
    if (icon) icon.className = 'fa-solid fa-bell-slash text-slate-400 text-base';
    if (iconContainer) iconContainer.className = 'w-9 h-9 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center';
    if (logicText) logicText.innerText = 'Logika: Sistem dalam keadaan siaga.';
    if (countdownBar) {
      countdownBar.style.transition = 'none';
      countdownBar.style.width = '0%';
    }
  }
}

// Indikator koneksi di footer
function setConnectionStatus(online) {
  const pulse = document.getElementById('connection-pulse');
  const text = document.getElementById('connection-status-text');
  if (!pulse || !text) return;

  const color = online ? 'emerald' : 'red';
  const dot = online ? 'bg-emerald-500' : 'bg-red-500';
  const ping = online ? 'bg-emerald-400' : 'bg-red-400';

  pulse.innerHTML = `
    <span class="animate-ping absolute inline-flex h-full w-full rounded-full ${ping} opacity-75"></span>
    <span class="relative inline-flex rounded-full h-2.5 w-2.5 ${dot}"></span>
  `;
  text.className = `font-semibold ${color === 'emerald' ? 'text-emerald-700' : 'text-red-600'}`;
  text.innerText = online ? 'Terhubung ke server' : 'Tidak terhubung ke server';
}

// ==========================================
// 4. FIREBASE (REST)
// ==========================================
async function fbRequest(path, options) {
  try {
    const res = await fetch(`${FIREBASE_URL}${path}.json`, options);
    setConnectionStatus(res.ok);
    return res;
  } catch (err) {
    console.error(`Firebase ${path} gagal:`, err);
    setConnectionStatus(false);
    return null;
  }
}

// Alarm manual -> ESP32. alarm_until = batas waktu (epoch detik) supaya tidak nyangkut.
async function syncAlarmToFirebase(isActive, reason = '', durationSeconds = 0) {
  const nowSec = Math.floor(Date.now() / 1000);
  return fbRequest('/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      alarm: isActive,
      alarm_until: isActive ? nowSec + durationSeconds : 0,
      last_event: reason,
      updated_at: new Date().toISOString()
    })
  });
}

// Jadwal -> ESP32 (ESP32 membaca /schedules dan menjalankannya sendiri)
async function syncSchedulesToFirebase() {
  return fbRequest('/schedules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(AppState.schedules)
  });
}

// Firebase adalah sumber utama jadwal, supaya membuka dari perangkat lain
// tidak menimpa jadwal dengan data lokal/default.
async function loadSchedulesFromFirebase() {
  const res = await fbRequest('/schedules');
  if (!res || !res.ok) return; // offline: pakai data lokal, JANGAN menimpa server

  try {
    const data = await res.json();
    const list = data ? Object.values(data).filter(s => s && s.start && s.end) : [];
    if (list.length > 0) {
      AppState.schedules = list;
      renderSchedules();
      checkScheduleStatusNow();
    } else {
      // Server belum punya jadwal: kirim yang ada di perangkat ini
      await syncSchedulesToFirebase();
    }
  } catch (err) {
    console.error('Gagal membaca jadwal dari Firebase:', err);
  }
}

// Saat dashboard dibuka: bersihkan alarm manual yang nyangkut dari sesi sebelumnya
async function clearStaleAlarm() {
  const res = await fbRequest('/status');
  if (!res || !res.ok) return;

  try {
    const data = await res.json();
    if (!data || data.alarm !== true) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const expired = !data.alarm_until || data.alarm_until <= nowSec;
    if (expired && !AppState.alarmActive) {
      await syncAlarmToFirebase(false, 'Alarm nyangkut dibersihkan');
    }
  } catch (err) {
    // abaikan
  }
}

// ==========================================
// 5. ALARM LOGIC
// ==========================================
function triggerAlarm(durationSeconds, sourceEvent) {
  if (AppState.alarmActive) return;

  AppState.alarmActive = true;
  AppState.alarmSource = sourceEvent;
  renderAlarmUI();

  // Animasi bar hitung mundur
  const countdownBar = document.getElementById('alarm-countdown-bar');
  if (countdownBar) {
    countdownBar.style.transition = 'none';
    countdownBar.style.width = '100%';
    setTimeout(() => {
      countdownBar.style.transition = `width ${durationSeconds}s linear`;
      countdownBar.style.width = '0%';
    }, 20);
  }

  addLog(sourceEvent, 'Manual', `AKTIF (${durationSeconds}s)`);
  syncAlarmToFirebase(true, sourceEvent, durationSeconds);

  clearTimeout(AppState.alarmTimer);
  AppState.alarmTimer = setTimeout(resetAlarmState, durationSeconds * 1000);
}

function resetAlarmState() {
  AppState.alarmActive = false;
  AppState.alarmSource = '';
  clearTimeout(AppState.alarmTimer);
  renderAlarmUI();
  syncAlarmToFirebase(false, 'Alarm manual selesai');
}

// Jadwal: hanya mengubah tampilan + log. Suara dipegang ESP32.
function checkScheduleStatusNow() {
  const d = new Date();
  const currentHm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const match = AppState.schedules.find(sch => sch.active && isTimeInRange(currentHm, sch.start, sch.end));

  const currentId = AppState.activeScheduleInfo ? AppState.activeScheduleInfo.id : null;

  if (match && match.id !== currentId) {
    AppState.isScheduleActive = true;
    AppState.activeScheduleInfo = match;
    addLog(`Jadwal Dimulai (${match.start} - ${match.end})`, 'Terjadwal', 'MENYALA');
    renderAlarmUI();
  } else if (!match && AppState.isScheduleActive) {
    const prev = AppState.activeScheduleInfo;
    AppState.isScheduleActive = false;
    AppState.activeScheduleInfo = null;
    addLog(`Jadwal Berakhir (${prev ? prev.end : ''})`, 'Terjadwal', 'SELESAI (MATI)');
    renderAlarmUI();
  }
}

// ==========================================
// 6. AKSI JADWAL & MODAL
// ==========================================
window.toggleSchedule = function (id) {
  const sch = AppState.schedules.find(s => s.id === id);
  if (sch) {
    sch.active = !sch.active;
    renderSchedules();
    syncSchedulesToFirebase();
    checkScheduleStatusNow();
  }
};

window.deleteSchedule = function (id) {
  if (confirm('Apakah Anda yakin ingin menghapus jadwal ini?')) {
    AppState.schedules = AppState.schedules.filter(s => s.id !== id);
    renderSchedules();
    syncSchedulesToFirebase();
    checkScheduleStatusNow();
  }
};

window.selectCalendarDay = function (day) {
  AppState.calendar.selectedDay = day;
  renderCalendar();
};

function setupScheduleModal() {
  const modal = document.getElementById('modal-schedule');
  const btnOpen = document.getElementById('btn-add-schedule');
  const btnClose = document.getElementById('btn-close-schedule-modal');
  const btnCancel = document.getElementById('btn-cancel-schedule');
  const form = document.getElementById('form-add-schedule');

  const openModal = () => modal.classList.remove('hidden');
  const closeModal = () => modal.classList.add('hidden');

  btnOpen.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const startTime = document.getElementById('input-start-time').value;
    const endTime = document.getElementById('input-end-time').value;
    const label = document.getElementById('input-schedule-label').value.trim() || 'Jadwal Baru';
    const isActive = document.getElementById('input-schedule-active').checked;

    if (startTime === endTime) {
      alert('Jam mulai dan jam selesai tidak boleh sama.');
      return;
    }

    AppState.schedules.push({
      id: Date.now(),
      start: startTime,
      end: endTime,
      duration: calculateDuration(startTime, endTime),
      active: isActive,
      label: label
    });

    renderSchedules();
    syncSchedulesToFirebase();
    checkScheduleStatusNow();
    closeModal();
    form.reset();
  });
}

// ==========================================
// 7. JAM & PENGECEK JADWAL
// ==========================================
function startSchedulerEngine() {
  const tick = () => {
    const clockEl = document.getElementById('realtime-clock');
    if (clockEl) clockEl.innerText = `${nowTimeStr()} WIB`;
    checkScheduleStatusNow();
  };
  tick();
  setInterval(tick, 1000);
}

// ==========================================
// 8. INIT
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  renderSchedules();
  renderCalendar();
  renderLogs();
  renderAlarmUI();
  setupScheduleModal();
  startSchedulerEngine();

  // Sinkron dengan server
  loadSchedulesFromFirebase();
  clearStaleAlarm();
  setInterval(() => fbRequest('/status'), HEARTBEAT_MS); // cek koneksi berkala

  // Tombol alarm manual
  const btnManual = document.getElementById('btn-manual-alarm');
  if (btnManual) {
    btnManual.addEventListener('click', () => {
      triggerAlarm(MANUAL_ALARM_SECONDS, 'Tombol Sirine Manual');
    });
  }

  // Reset log
  const btnResetLog = document.getElementById('btn-reset-log');
  if (btnResetLog) {
    btnResetLog.addEventListener('click', () => {
      if (AppState.logs.length === 0) return;
      if (confirm('Hapus seluruh riwayat log aktivitas?')) {
        AppState.logs = [];
        localStorage.removeItem('ssg_logs');
        renderLogs();
      }
    });
  }

  // Navigasi kalender
  const btnPrev = document.getElementById('btn-prev-month');
  const btnNext = document.getElementById('btn-next-month');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      AppState.calendar.month--;
      if (AppState.calendar.month < 0) {
        AppState.calendar.month = 11;
        AppState.calendar.year--;
      }
      renderCalendar();
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      AppState.calendar.month++;
      if (AppState.calendar.month > 11) {
        AppState.calendar.month = 0;
        AppState.calendar.year++;
      }
      renderCalendar();
    });
  }

  const footerYear = document.getElementById('footer-year');
  if (footerYear) footerYear.innerText = new Date().getFullYear();
});