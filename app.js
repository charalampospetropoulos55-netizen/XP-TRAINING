// All screens of the XP Training app. Data and rules come from the server through window.api.
var DISC = { w: { name: 'Βάρη', cls: 'Προπόνηση με βάρη' }, p: { name: 'Πιλάτες', cls: 'Πιλάτες' } };
var LEVELS = ['Αρχάριοι', 'Μέτριοι', 'Προχωρημένοι'];
var DAY = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];
var DAYS = ['Κυρ', 'Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ'];
var WARN_DAYS = 3;
var LOGO = '<span class="logo"><svg viewBox="50 170 950 640" role="img" aria-label="XP Training">' +
  '<path fill="#F2F2F2" d="M610 267H775C815 267 842 295 842 340C842 392 815 428 768 428H616L655 437L648 506H600L590 462L598 373H765C780 373 790 362 790 345C790 330 780 318 765 318H612Z"/>' +
  '<path fill="#CDF270" d="M317 178H441L481 252L562 178H688L483 378L534 353L610 507H485L439 418L343 507H207L395 335Z"/>' +
  '<text x="525" y="725" text-anchor="middle" textLength="920" lengthAdjust="spacingAndGlyphs" fill="#F2F2F2" font-family="Archivo,Arial Black,Arial,sans-serif" font-style="italic" font-weight="900" font-size="205">training</text></svg></span>';

/* ---------- Helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function p2(n) { return (n < 10 ? '0' : '') + n; }
function keyOf(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
function dateOf(k) { var a = k.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
function addDays(k, n) { var d = dateOf(k); d.setDate(d.getDate() + n); return keyOf(d); }
function todayKey() { return keyOf(new Date()); }
function daysUntil(k) { return Math.round((dateOf(k) - dateOf(todayKey())) / 864e5); }
function shortDate(k) { var d = dateOf(k); return d.getDate() + '/' + (d.getMonth() + 1); }
function niceDate(k) { var d = dateOf(k); return DAY[d.getDay()] + ' ' + shortDate(k); }
function fmtMoment(t) { return DAYS[t.getDay()] + ' ' + t.getDate() + '/' + (t.getMonth() + 1) + ', ' + p2(t.getHours()) + ':' + p2(t.getMinutes()); }
function addMonths(k, n) { var d = dateOf(k), day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return keyOf(d); }
function monday() { var d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return keyOf(d); }
function fullName(m) { return m.first_name + ' ' + m.last_name; }
function byId(id) { return document.getElementById(id); }

/* ---------- State ---------- */
var D = { me: null, subs: {}, rules: {}, classes: [], recurring: [], members: [], allSubs: {} };
var UI = { screen: 'loading', authMode: 'login', authErr: '', mode: 'member', tab: 'program', admin: 'today', disc: 'w', day: null, aDay: null, sView: 'week', wk: null, q: '', filter: 'active', mdisc: 'all', more: '', sheet: null, imp: null, invites: null };
var busy = false, toastTimer = null;

function normalizeClass(c) {
  var t = new Date(c.starts_at);
  return { id: c.id, d: c.discipline, level: c.level, start: t, date: keyOf(t), time: p2(t.getHours()) + ':' + p2(t.getMinutes()), dur: c.duration_min, cap: c.capacity, coach: c.coach, booked: c.booked_count, waits: c.wait_count, iBooked: c.i_booked, waitPos: c.wait_pos };
}
async function refresh() {
  D.me = await api.me();
  var results = await Promise.all([api.mySubscriptions(D.me.id), api.rules(), api.classes(dateOf(monday()), dateOf(addDays(monday(), 70))), api.recurring(D.me.id), api.notifications(D.me.id)]);
  D.notes = results[4];
  D.subs = {}; results[0].forEach(function (s) { D.subs[s.discipline] = s; });
  D.rules = {}; results[1].forEach(function (r) { D.rules[r.discipline] = r; });
  D.classes = results[2].map(normalizeClass);
  D.recurring = results[3];
  if (D.me.is_admin) {
    var a = await Promise.all([api.members(), api.allSubscriptions()]);
    D.members = a[0];
    D.allSubs = {};
    a[1].forEach(function (s) { (D.allSubs[s.member_id] = D.allSubs[s.member_id] || {})[s.discipline] = s; });
  }
}
/* ---------- Live updates: screens refresh themselves, without leaving the app ---------- */
var FALLBACK_REFRESH_MS = 5 * 6e4, stopLive = null, liveTimer = null, fallbackTimer = null, pendingRender = false;
function isEditing() {
  var el = document.activeElement, tag = el && el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (UI.imp || UI.invites) return true;
  return !!(UI.sheet && UI.sheet.kind !== 'class');
}
async function softRefresh() {
  if (busy || UI.screen !== 'app' || document.hidden) return;
  try {
    await refresh();
    if (isEditing()) { pendingRender = true; return; }
    pendingRender = false;
    render();
    if (UI.sheet && UI.sheet.kind === 'class') await loadPeople(UI.sheet.id);
  } catch (e) { /* A dropped connection is retried at the next signal. */ }
}
function scheduleRefresh(scope) {
  // Members do not hold the member list, so changes to it are not theirs to reload.
  if (scope === 'members' && !(D.me && D.me.is_admin)) return;
  // A small random delay keeps every phone from reloading at the same moment.
  clearTimeout(liveTimer);
  liveTimer = setTimeout(softRefresh, 400 + Math.random() * (D.me && D.me.is_admin ? 600 : 2600));
}
function startLive() {
  stopLiveUpdates();
  stopLive = api.onChange(scheduleRefresh);
  fallbackTimer = setInterval(softRefresh, FALLBACK_REFRESH_MS);
}
function stopLiveUpdates() {
  if (stopLive) stopLive();
  stopLive = null;
  clearInterval(fallbackTimer); clearTimeout(liveTimer);
}
function friendlyError(e) {
  var m = (e && e.message) || '';
  if (/duplicate key|unique constraint/i.test(m)) return 'Αυτό το κινητό ανήκει ήδη σε άλλο μέλος.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Δεν υπάρχει σύνδεση στο internet. Δοκίμασε ξανά.';
  return /[Α-Ωα-ωΆ-ώ]/.test(m) ? m : 'Κάτι πήγε στραβά. Δοκίμασε ξανά.';
}
async function run(fn, okMsg, opts) {
  if (busy) return;
  busy = true;
  try {
    var r = await fn();
    if (opts && opts.closeSheet) UI.sheet = null;
    await refresh();
    if (opts && opts.after) await opts.after(r);
    render();
    var msg = typeof okMsg === 'function' ? okMsg(r) : okMsg;
    if (msg) toast(msg);
  } catch (e) {
    toast(friendlyError(e));
    try { await refresh(); render(); } catch (e2) {}
  } finally { busy = false; }
}
function toast(msg) {
  var t = byId('toast');
  t.innerHTML = '<div>' + esc(msg) + '</div>';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.innerHTML = ''; }, 4500);
}

/* ---------- Rules, for display. The server has the final say. ---------- */
function classTitle(c) { return c.d === 'p' ? 'Πιλάτες ' + c.level : DISC.w.cls; }
function isStarted(c) { return c.start.getTime() <= Date.now(); }
function regClosed(c) { return c.start.getTime() - D.rules[c.d].register_minutes * 6e4 <= Date.now(); }
function cancelDeadline(c) { return new Date(c.start.getTime() - D.rules[c.d].cancel_hours * 36e5); }
function isLateCancel(c) { return cancelDeadline(c).getTime() <= Date.now(); }
function planProblem(c) {
  var s = D.subs[c.d];
  if (D.me.status !== 'active') return 'Η συνδρομή σου δεν έχει ενεργοποιηθεί ακόμα';
  if (!s) return 'Δεν έχεις συνδρομή για ' + DISC[c.d].name;
  if (daysUntil(s.expires_on) < 0) return 'Η συνδρομή σου για ' + DISC[c.d].name + ' έχει λήξει';
  if (c.date > s.expires_on) return 'Η συνδρομή σου λήγει στις ' + shortDate(s.expires_on) + ', πριν από αυτό το μάθημα';
  if (s.kind === 'count' && s.visits_left <= 0) return 'Δεν έχεις επισκέψεις στο υπόλοιπο για ' + DISC[c.d].name;
  return null;
}
function planText(s) { return s.kind === 'unlimited' ? 'Απεριόριστα' : s.visits_left + ' από ' + s.visits_total; }
function planSub(s) { return (daysUntil(s.expires_on) < 0 ? 'Έληξε στις ' : 'Λήγει στις ') + shortDate(s.expires_on); }
function memberAlerts(m) {
  var out = [], subs = D.allSubs[m.id] || {};
  if (m.status === 'pending') out.push({ t: 'Νέα εγγραφή', c: 'warn', k: 'new' });
  if (m.status === 'inactive') out.push({ t: 'Ανενεργό', c: '', k: 'off' });
  ['w', 'p'].forEach(function (d) {
    var s = subs[d]; if (!s) return;
    var left = daysUntil(s.expires_on);
    if (left < 0) out.push({ t: DISC[d].name + ': έληξε', c: 'bad', k: 'exp' });
    else if (left <= 7) out.push({ t: DISC[d].name + ': λήγει σε ' + left + (left === 1 ? ' μέρα' : ' μέρες'), c: 'warn', k: 'exp' });
    if (left >= 0 && s.kind === 'count' && s.visits_left <= 1) out.push({ t: DISC[d].name + ': ' + (s.visits_left === 1 ? 'μένει 1' : 'μένουν 0'), c: 'warn', k: 'exp' });
  });
  if (m.status === 'active' && m.last_visit_at) {
    var idle = Math.round((Date.now() - new Date(m.last_visit_at).getTime()) / 864e5);
    if (idle > 21) out.push({ t: idle + ' μέρες χωρίς επίσκεψη', c: '', k: 'idle' });
  }
  if (!m.auth_user_id && m.status === 'active') out.push({ t: 'Δεν έχει συνδεθεί', c: '', k: 'noacc' });
  if (!m.phone) out.push({ t: 'Χωρίς κινητό', c: Object.keys(subs).length ? 'bad' : '', k: 'nophone' });
  return out;
}

/* ---------- Shared pieces ---------- */
function pips(c) {
  var h = '', i, n = Math.min(c.cap, 40);
  for (i = 0; i < n; i++) h += '<i' + (i < c.booked ? ' class="on"' : '') + '></i>';
  return '<div class="pips" aria-hidden="true">' + h + '</div>';
}
function countText(c) {
  var free = c.cap - c.booked;
  var extra = free > 0 ? (free === 1 ? '1 ελεύθερη' : free + ' ελεύθερες') : 'Γεμάτο' + (c.waits ? ', ' + c.waits + ' σε αναμονή' : '');
  return '<div class="count"><b>' + c.booked + '/' + c.cap + '</b> · ' + extra + '</div>';
}
function installHint() {
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
  if (standalone) return '';
  return '<div class="panel"><h2 class="sec">Βάλε το στην αρχική οθόνη</h2><div class="small"><b>iPhone</b></div><ol class="steps"><li>Άνοιξε τη σελίδα στο Safari</li><li>Πάτα Κοινοποίηση</li><li>Διάλεξε «Προσθήκη στην οθόνη αφετηρίας»</li></ol><div class="small"><b>Android</b></div><ol class="steps"><li>Άνοιξε τη σελίδα στο Chrome</li><li>Πάτα το μενού με τις τρεις τελείες</li><li>Διάλεξε «Εγκατάσταση εφαρμογής»</li></ol></div>';
}
function modeBar() {
  if (!D.me.is_admin) return '';
  function b(m, l) { return '<button type="button" data-a="mode" data-v="' + m + '" aria-pressed="' + (UI.mode === m) + '">' + l + '</button>'; }
  return '<div class="seg">' + b('member', 'Μέλος') + b('admin', 'Διαχείριση') + '</div>';
}

/* ---------- Sign-in screens ---------- */
function viewAuth() {
  function tab(v, l) { return '<button type="button" data-a="auth-mode" data-v="' + v + '" aria-pressed="' + (UI.authMode === v) + '">' + l + '</button>'; }
  var err = UI.authErr ? '<p class="err" role="alert">' + esc(UI.authErr) + '</p>' : '';
  var consent = '<label class="check"><input type="checkbox" id="auConsent"><span>Διάβασα την <a href="privacy.html" target="_blank" rel="noopener">ενημέρωση απορρήτου</a> και συμφωνώ να κρατά ο σύλλογος τα στοιχεία μου για τις κρατήσεις και τη συνδρομή μου.</span></label>';
  var phone = '<div class="field"><label for="auPhone">Κινητό</label><input id="auPhone" inputmode="numeric" autocomplete="tel" placeholder="69XXXXXXXX"></div>';
  var h = LOGO + '<div class="seg">' + tab('login', 'Σύνδεση') + tab('claim', 'Έχω πρόσκληση') + tab('register', 'Νέο μέλος') + '</div>';
  if (UI.authMode === 'login') {
    h += '<form class="panel" id="loginForm" novalidate><h1 class="page">Σύνδεση</h1>' + phone +
      '<div class="field"><label for="auPass">Κωδικός</label><input id="auPass" type="password" autocomplete="current-password"></div>' + err +
      '<button class="btn full" type="submit">Σύνδεση</button><button type="button" class="linkbtn" data-a="forgot">Ξέχασα τον κωδικό μου</button><p class="small muted">Γράψε το κινητό σου και πάτα «Ξέχασα τον κωδικό μου». Θα σου έρθει νέος κωδικός στο email σου.</p></form>';
  } else if (UI.authMode === 'claim') {
    h += '<form class="panel" id="claimForm" novalidate><h1 class="page">Ενεργοποίηση λογαριασμού</h1>' + (UI.authInfo ? '<div class="notice">' + esc(UI.authInfo) + '</div>' : '') + '<p class="small muted">Η συνδρομή και το υπόλοιπό σου έχουν ήδη περαστεί. Γράψε το κινητό σου και πάτα «Στείλε μου κωδικό». Θα σου έρθει κωδικός στο email σου. Γράψ\' τον εδώ και πάτα Ενεργοποίηση. Αυτός θα είναι ο κωδικός σου για να μπαίνεις.</p>' + phone +
      '<button type="button" class="btn ghost full" data-a="forgot">Στείλε μου κωδικό στο email μου για να συνδεθώ</button><div class="field"><label for="auCode">Κωδικός από το email</label><input id="auCode" autocomplete="one-time-code" autocapitalize="characters"></div>' +
      '' + consent + err +
      '<button class="btn full" type="submit">Ενεργοποίηση</button></form>';
  } else {
    h += '<form class="panel" id="registerForm" novalidate><h1 class="page">Φτιάξε τον λογαριασμό σου</h1>' +
      '<div class="grid2"><div class="field"><label for="auFirst">Όνομα</label><input id="auFirst" autocomplete="given-name"></div><div class="field"><label for="auLast">Επώνυμο</label><input id="auLast" autocomplete="family-name"></div></div>' + phone +
      '<div class="field"><label for="auPass">Κωδικός (τουλάχιστον 6 χαρακτήρες)</label><input id="auPass" type="password" autocomplete="new-password"></div>' +
      '<div class="field"><label for="auEmail">Email (προαιρετικό, για ειδοποιήσεις)</label><input id="auEmail" type="email" autocomplete="email"></div>' +
      '<div class="field"><label for="auLevel">Επίπεδο στα πιλάτες</label><select id="auLevel"><option value="">Δεν κάνω πιλάτες</option>' + LEVELS.map(function (l) { return '<option>' + l + '</option>'; }).join('') + '</select></div>' + consent + err +
      '<button class="btn full" type="submit">Εγγραφή</button><p class="small muted">Η συνδρομή ενεργοποιείται από τον σύλλογο μετά την εγγραφή.</p></form>';
  }
  return h;
}
function cleanPhone(v) { var s = String(v || '').replace(/[^\d]/g, '').replace(/^00/, ''); if (s.length === 12 && s.indexOf('30') === 0) s = s.slice(2); return s; }
function phoneValue() { return cleanPhone(byId('auPhone').value); }
async function authSubmit(fn) {
  if (busy) return;
  busy = true; UI.authErr = '';
  try {
    await fn();
    await refresh();
    UI.screen = 'app'; UI.mode = 'member'; UI.tab = 'program';
    render();
    startLive();
  } catch (e) {
    UI.authErr = friendlyError(e);
    render();
  } finally { busy = false; }
}
function submitLogin() {
  var phone = phoneValue(), pass = byId('auPass').value;
  authSubmit(function () { return api.login(phone, pass); });
}
function submitClaim() {
  var d = { phone: phoneValue(), code: byId('auCode').value, password: '', consent: byId('auConsent').checked };
  authSubmit(function () { return api.claim(d); });
}
function submitRegister() {
  var d = { first_name: byId('auFirst').value.trim(), last_name: byId('auLast').value.trim(), phone: phoneValue(), password: byId('auPass').value, email: byId('auEmail').value.trim(), level: byId('auLevel').value, consent: byId('auConsent').checked };
  authSubmit(function () { return api.register(d); });
}

/* ---------- Member screens ---------- */
function memberDays(d) {
  var out = [], t = todayKey();
  for (var i = 0; i < D.rules[d].visible_days; i++) out.push(addDays(t, i));
  return out;
}
function expiryNotices() {
  return ['w', 'p'].map(function (d) {
    var s = D.subs[d]; if (!s) return '';
    var left = daysUntil(s.expires_on);
    if (left < 0 || left > WARN_DAYS) return '';
    var when = left === 0 ? 'λήγει σήμερα' : left === 1 ? 'λήγει αύριο' : 'λήγει σε ' + left + ' μέρες, στις ' + shortDate(s.expires_on);
    return '<div class="notice" role="alert"><b>Η συνδρομή σου για ' + DISC[d].name + ' ' + when + '.</b> Μίλησε με τη γραμματεία για ανανέωση.</div>';
  }).join('');
}
function notesHtml() {
  var notes = D.notes || [];
  if (!notes.length) return '';
  return '<div class="notice" role="alert"><div class="stack">' + notes.map(function (n) { return '<div>' + esc(n.body) + '</div>'; }).join('') + '<div><button type="button" class="btn ghost tiny" data-a="notes-read">Εντάξει</button></div></div></div>';
}
function classCard(c) {
  var started = isStarted(c), action;
  if (c.iBooked) {
    action = '<span class="pill d">Έχεις κράτηση</span>' + (started ? '' : '<button type="button" class="btn ghost tiny" data-a="ask-cancel" data-id="' + c.id + '">Ακύρωση</button>');
  } else if (c.waitPos) {
    action = '<span class="pill warn">Αναμονή: σειρά ' + c.waitPos + '</span><button type="button" class="btn ghost tiny" data-a="leave-wait" data-id="' + c.id + '">Έξοδος</button>';
  } else if (started) {
    action = '<span class="hint">Ολοκληρώθηκε ή ξεκίνησε</span>';
  } else if (regClosed(c)) {
    action = '<span class="hint">Οι κρατήσεις έκλεισαν</span>';
  } else {
    var why = planProblem(c);
    if (why) action = '<span class="hint">' + esc(why) + '</span>';
    else if (c.booked >= c.cap) action = '<span class="hint">Αν ανοίξει θέση, κλείνεται αυτόματα για σένα</span><button type="button" class="btn ghost" data-a="join-wait" data-id="' + c.id + '">Μπες στην αναμονή</button>';
    else action = '<button type="button" class="btn right" data-a="ask-book" data-id="' + c.id + '">Κλείσε θέση</button>';
  }
  return '<article class="cls d-' + c.d + (c.iBooked ? ' mine' : '') + (started && !c.iBooked ? ' dim' : '') + '"><div class="time">' + c.time + '</div><div class="cinfo"><div class="ctitle">' + esc(classTitle(c)) + '</div><div class="cmeta">' + esc(c.coach) + ' · ' + c.dur + ' λεπτά</div>' + pips(c) + countText(c) + '</div><div class="cact">' + action + '</div></article>';
}

/* Countdown to subscription and health-card expiry, shown in red to the member. */
function daysLeftTo(k) {
  var p = String(k).slice(0, 10).split('-'), t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(+p[0], +p[1] - 1, +p[2]) - t) / 864e5);
}
function leftText(n) {
  if (n > 1) return 'σε ' + n + ' μέρες';
  if (n === 1) return 'αύριο';
  if (n === 0) return 'σήμερα';
  return 'έληξε πριν ' + (-n) + (n === -1 ? ' μέρα' : ' μέρες');
}
function countdownRow(title, n, tail) {
  var big = n >= 0 ? n : 0;
  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;background:var(--bad-soft);color:var(--bad)">' +
    '<div style="min-width:0"><b>' + esc(title) + (n >= 0 ? ' λήγει ' : ' ') + esc(leftText(n)) + '</b><div style="font-size:13px">' + esc(tail) + '</div></div>' +
    '<div style="text-align:center;flex:none"><div style="font:800 34px/1 var(--display)">' + big + '</div><div style="font-size:12px">' + (big === 1 ? 'μέρα' : 'μέρες') + '</div></div></div>';
}
function countdownHtml() {
  var me = D.me || {}, rows = [];
  Object.keys(D.subs || {}).forEach(function (d) {
    var s = D.subs[d];
    if (s && s.expires_on) rows.push(countdownRow('Η συνδρομή σου στα ' + (DISC[d] ? DISC[d].name : ''), daysLeftTo(s.expires_on), 'Πέρασε από τη γραμματεία για ανανέωση.'));
  });
  if (me.health_cert_expires) rows.push(countdownRow('Η κάρτα υγείας σου', daysLeftTo(me.health_cert_expires), 'Πέρασε από τη γραμματεία με νέα κάρτα υγείας.'));
  var lim = me.weekly_limit != null ? '<div class="small muted">Το πακέτο σου: ' + me.weekly_limit + (me.weekly_limit === 1 ? ' φορά' : ' φορές') + ' την εβδομάδα</div>' : '';
  return (rows.length ? '<div class="stack" style="gap:8px">' + rows.join('') + '</div>' : '') + lim;
}
function viewProgram() {
  var d = UI.disc, days = memberDays(d), me = D.me;
  if (!UI.day || days.indexOf(UI.day) < 0) {
    UI.day = days.filter(function (k) { return D.classes.some(function (c) { return c.d === d && c.date === k && !regClosed(c); }); })[0] || days[0];
  }
  var list = D.classes.filter(function (c) { return c.d === d && c.date === UI.day; });
  var h = '<div class="top">' + LOGO + '<div class="hello">Γεια σου, ' + esc(me.first_name) + '</div></div>';
  if (me.status === 'pending') h += '<div class="notice">Η εγγραφή σου έγινε. Μόλις ο σύλλογος ενεργοποιήσει τη συνδρομή σου, θα μπορείς να κλείνεις θέσεις.</div>';
  if (me.status === 'inactive') h += '<div class="notice">Ο λογαριασμός σου δεν είναι ενεργός. Μίλησε με τη γραμματεία.</div>';
  h += countdownHtml();
  h += notesHtml() + expiryNotices();
  h += '<div class="seg big">' + ['w', 'p'].map(function (x) { return '<button type="button" class="d-' + x + '" data-a="disc" data-v="' + x + '" aria-pressed="' + (d === x) + '">' + DISC[x].name + '</button>'; }).join('') + '</div>';
  var s = D.subs[d];
  if (s) {
    var warn = daysUntil(s.expires_on) <= WARN_DAYS;
    h += '<div class="balance"><div><strong>' + planText(s) + '</strong>' + (s.kind === 'count' ? ' <span class="small">επισκέψεις</span>' : '') + '</div><span class="small' + (warn ? ' pill warn' : '') + '">' + planSub(s) + '</span></div>';
  } else if (me.status === 'active') {
    h += '<div class="balance"><span class="small">Δεν έχεις συνδρομή για ' + DISC[d].name + '. Μίλησε με τη γραμματεία.</span></div>';
  }
  h += '<div class="days" id="dayStrip">' + days.map(function (k) { var x = dateOf(k); return '<button type="button" data-a="day" data-v="' + k + '" aria-pressed="' + (k === UI.day) + '" aria-label="' + niceDate(k) + '"><small>' + (k === todayKey() ? 'Σήμερα' : DAYS[x.getDay()]) + '</small><span>' + x.getDate() + '</span></button>'; }).join('') + '</div>';
  if (!list.length) {
    h += '<div class="empty"><span>Δεν υπάρχουν μαθήματα για ' + DISC[d].name + ' την ' + niceDate(UI.day) + '.</span></div>';
  } else if (d === 'p' && me.level) {
    var mine = list.filter(function (c) { return c.level === me.level; }), other = list.filter(function (c) { return c.level !== me.level; });
    if (mine.length) h += '<h2 class="sec">Το επίπεδό σου: ' + esc(me.level) + '</h2><div class="stack">' + mine.map(classCard).join('') + '</div>';
    if (other.length) h += '<h2 class="sec">Άλλα επίπεδα</h2><div class="stack">' + other.map(classCard).join('') + '</div>';
  } else {
    h += '<div class="stack">' + list.map(classCard).join('') + '</div>';
  }
  return h;
}
function viewBookings() {
  var up = D.classes.filter(function (c) { return !isStarted(c) && c.iBooked; });
  var wa = D.classes.filter(function (c) { return !isStarted(c) && c.waitPos; });
  function group(list) { return '<div class="stack">' + list.map(function (c) { return '<div class="stack"><div class="small muted">' + niceDate(c.date) + '</div>' + classCard(c) + '</div>'; }).join('') + '</div>'; }
  var h = '<h1 class="page">Οι κρατήσεις μου</h1>' + notesHtml();
  if (!up.length && !wa.length) h += '<div class="empty"><span>Δεν έχεις κρατήσεις ακόμα.</span><button type="button" class="btn" data-a="tab" data-v="program">Δες το πρόγραμμα</button></div>';
  if (up.length) h += group(up);
  if (wa.length) h += '<h2 class="sec">Σε αναμονή</h2>' + group(wa);
  h += '<h2 class="sec">Σταθερές κρατήσεις κάθε εβδομάδα</h2>';
  if (D.recurring.length) {
    h += '<div class="panel"><div class="list">' + D.recurring.map(function (r) {
      return '<div class="row"><div class="grow"><b>' + DAY[r.weekday] + ' ' + esc(r.at_time) + '</b><br><span class="small muted">' + esc(r.discipline === 'p' ? 'Πιλάτες ' + r.level : DISC.w.cls) + '</span></div><button type="button" class="btn ghost tiny" data-a="rec-del" data-id="' + r.id + '">Διακοπή</button></div>';
    }).join('') + '</div></div>';
  } else {
    h += '<p class="small muted">Όταν κλείνεις θέση, τσέκαρε «Κάθε εβδομάδα» και η ώρα θα κρατιέται αυτόματα.</p>';
  }
  return h;
}
function viewProfile() {
  function card(d) {
    var s = D.subs[d];
    return '<div class="plan d-' + d + '"><span class="small muted">' + DISC[d].name + '</span>' + (s ? '<strong>' + planText(s) + '</strong><span class="small">' + (s.kind === 'count' ? 'επισκέψεις · ' : '') + planSub(s) + '</span>' : '<span class="small muted">Χωρίς συνδρομή</span>') + '</div>';
  }
  var m = D.me;
  return '<h1 class="page">' + esc(fullName(m)) + '</h1>' + expiryNotices() +
    '<div class="panel">' + card('w') + card('p') + '</div>' +
    '<div class="panel"><dl class="facts"><dt>Κινητό</dt><dd>' + esc(m.phone) + '</dd><dt>Email</dt><dd>' + esc(m.email || 'Δεν έχει δηλωθεί') + '</dd>' + (D.subs.p || m.level ? '<dt>Επίπεδο πιλάτες</dt><dd>' + esc(m.level || 'Δεν έχει οριστεί') + '</dd>' : '') + '</dl></div>' +
    installHint() + '<p class="small"><a href="privacy.html" target="_blank" rel="noopener">Ενημέρωση απορρήτου</a></p>' +
    '<button type="button" class="btn ghost full" data-a="logout">Αποσύνδεση</button>';
}
function memberNav() {
  function b(t, l) { return '<button type="button" data-a="tab" data-v="' + t + '"' + (UI.tab === t ? ' aria-current="page"' : '') + '>' + l + '</button>'; }
  return '<nav class="nav" aria-label="Μενού μέλους"><div>' + b('program', 'Πρόγραμμα') + b('bookings', 'Κρατήσεις') + b('profile', 'Προφίλ') + '</div></nav>';
}

/* ---------- Admin screens ---------- */
function classesOn(k) { return D.classes.filter(function (c) { return c.date === k; }); }
function adminClassRow(c) {
  return '<article class="cls d-' + c.d + '"><div class="time">' + c.time + '</div><div class="cinfo"><div class="ctitle">' + esc(classTitle(c)) + '</div>' + pips(c) + countText(c) + '</div><div class="cact"><span class="hint">' + esc(c.coach) + '</span><button type="button" class="btn ghost tiny" data-a="open-class" data-id="' + c.id + '">Άνοιγμα</button></div></article>';
}
/* Subscription state of a member, across both disciplines, the way the front desk thinks of it. */
function subState(m, only) {
  var subs = D.allSubs[m.id] || {}, best = null;
  (only && only !== 'all' ? [only] : ['w', 'p']).forEach(function (d) { var s = subs[d]; if (s && (!best || s.expires_on > best.expires_on)) best = s; });
  if (!best) return { k: 'none', left: null };
  var left = daysUntil(best.expires_on);
  return { k: left < 0 ? 'expired' : left <= 7 ? 'soon' : 'active', left: left, exp: best.expires_on };
}
function subLine(m) {
  var subs = D.allSubs[m.id] || {}, parts = [];
  ['w', 'p'].forEach(function (d) {
    var s = subs[d]; if (!s) return;
    var left = daysUntil(s.expires_on);
    parts.push('<span class="sub ' + (left < 0 ? 'bad' : left <= 7 ? 'warn' : 'ok') + '">' + DISC[d].name + (left < 0 ? ' · έληξε ' : ' · έως ') + shortDate(s.expires_on) + '</span>');
  });
  return parts.length ? parts.join('') : '<span class="sub">Χωρίς συνδρομή</span>';
}
function memberRow(m) {
  var al = memberAlerts(m).filter(function (a) { return a.k !== 'exp'; });
  return '<button type="button" class="memberbtn" data-a="open-member" data-id="' + m.id + '"><span class="grow"><b>' + esc(fullName(m)) + '</b><br><span class="small muted">' + esc(m.phone || 'Χωρίς κινητό') + '</span></span><span class="subs">' + subLine(m) + '</span>' + (al.length ? '<span class="pills">' + al.map(function (a) { return '<span class="pill ' + a.c + '">' + esc(a.t) + '</span>'; }).join('') + '</span>' : '') + '</button>';
}
function countBy(k, d) { return D.members.filter(function (m) { return subState(m, d).k === k; }).length; }
function viewToday() {
  var t = todayKey(), k = t, i;
  for (i = 0; i < 7 && !classesOn(k).length; i++) k = addDays(k, 1);
  var list = classesOn(k), booked = 0, free = 0;
  list.forEach(function (c) { booked += c.booked; free += c.cap - c.booked; });
  var soon = D.members.filter(function (m) { return subState(m).k === 'soon'; }).sort(function (a, b) { return subState(a).left - subState(b).left; });
  var lately = D.members.filter(function (m) { var x = subState(m); return x.k === 'expired' && x.left >= -30; });
  var fresh = D.members.filter(function (m) { return m.status === 'pending'; });
  var active = countBy('active') + soon.length;
  function tile(n, l, f, c) { return '<button type="button" class="tile' + (c ? ' ' + c : '') + '" data-a="goto-filter" data-v="' + f + '"><b>' + n + '</b><span>' + l + '</span></button>'; }
  var h = '<div class="top">' + LOGO + '<div class="hello">' + niceDate(t) + '</div></div>';
  h += '<div class="tiles">' + tile(active, 'Ενεργές συνδρομές', 'active') + tile(soon.length, 'Λήγουν σε 7 μέρες', 'soon', soon.length ? 'warn' : '') + tile(lately.length, 'Έληξαν τον τελευταίο μήνα', 'expired', lately.length ? 'bad' : '') + tile(D.members.length, 'Όλα τα μέλη', 'all') + '</div>';
  if (fresh.length) h += '<div class="notice">' + (fresh.length === 1 ? '1 νέα εγγραφή περιμένει' : fresh.length + ' νέες εγγραφές περιμένουν') + ' ενεργοποίηση. <button type="button" class="linkbtn" style="color:inherit" data-a="goto-more" data-v="new">Δες τις</button></div>';
  h += '<h2 class="sec">' + (k === t ? 'Σήμερα' : niceDate(k) + ' (επόμενη μέρα με μαθήματα)') + '</h2>';
  h += '<div class="panel stats"><div><b>' + list.length + '</b><span>Μαθήματα</span></div><div><b>' + booked + '</b><span>Κρατήσεις</span></div><div><b>' + free + '</b><span>Ελεύθερες θέσεις</span></div></div>';
  h += list.length ? '<div class="stack">' + list.map(adminClassRow).join('') + '</div>' : '<div class="empty"><span>Δεν υπάρχουν μαθήματα ακόμα.</span><button type="button" class="btn" data-a="atab" data-v="schedule">Φτιάξε το πρόγραμμα</button></div>';
  h += '<h2 class="sec">Λήγουν σύντομα (' + soon.length + ')</h2><p class="small muted">Το μέλος βλέπει ειδοποίηση ' + WARN_DAYS + ' μέρες πριν από τη λήξη. Πάτα ένα μέλος για ανανέωση.</p><div class="panel">' + (soon.slice(0, 8).map(memberRow).join('') || '<span class="muted">Κανείς αυτή την εβδομάδα.</span>') + (soon.length > 8 ? '<button type="button" class="btn ghost tiny" data-a="goto-filter" data-v="soon">Δες όλους</button>' : '') + '</div>';
  return h;
}
function weekStart(k) { return addDays(k, -((dateOf(k).getDay() + 6) % 7)); }
function weekView() {
  var t = todayKey(), first = UI.wk || weekStart(t), i, cols = '', total = 0, booked = 0;
  for (i = 0; i < 7; i++) {
    var k = addDays(first, i), x = dateOf(k), list = classesOn(k);
    list.forEach(function (c) { total += c.cap; booked += c.booked; });
    cols += '<div class="wkcol' + (k === t ? ' today' : '') + '"><button type="button" class="wkhead" data-a="aday-day" data-v="' + k + '"><small>' + DAYS[x.getDay()] + '</small><span>' + x.getDate() + '</span></button>' +
      (list.length ? list.map(function (c) {
        var full = c.booked >= c.cap, pct = Math.min(100, Math.round(c.booked / c.cap * 100));
        return '<button type="button" class="wkc d-' + c.d + (isStarted(c) ? ' past' : '') + '" data-a="open-class" data-id="' + c.id + '" aria-label="' + esc(classTitle(c)) + ', ' + niceDate(c.date) + ' ' + c.time + ', ' + c.booked + ' από ' + c.cap + '">' +
          '<b>' + c.time + '</b><span class="wkt">' + esc(c.d === 'p' ? 'Πιλάτες' : 'Βάρη') + (c.d === 'p' && c.level ? ' · ' + esc(c.level.slice(0, 4)) + '.' : '') + '</span>' +
          '<span class="wkn' + (full ? ' full' : '') + '">' + c.booked + '/' + c.cap + (c.waits ? ' +' + c.waits : '') + '</span><i style="width:' + pct + '%"></i></button>';
      }).join('') : '<span class="wkempty">—</span>') + '</div>';
  }
  var last = addDays(first, 6);
  var h = '<div class="wknav"><button type="button" class="btn ghost tiny" data-a="wk" data-v="-7" aria-label="Προηγούμενη εβδομάδα">‹</button><div><b>' + shortDate(first) + ' – ' + shortDate(last) + '</b><span class="small muted">' + (total ? ' · Πληρότητα ' + Math.round(booked / total * 100) + '% (' + booked + '/' + total + ')' : '') + '</span></div>' + (first !== weekStart(t) ? '<button type="button" class="btn ghost tiny" data-a="wk" data-v="0">Σήμερα</button>' : '') + '<button type="button" class="btn ghost tiny" data-a="wk" data-v="7" aria-label="Επόμενη εβδομάδα">›</button></div>';
  h += '<div class="wkgrid">' + cols + '</div>';
  h += '<div class="acts"><button type="button" class="btn" data-a="new-class">Νέο μάθημα</button><button type="button" class="btn ghost" data-a="copy-week">Αντιγραφή εβδομάδας στην επόμενη</button></div>';
  return h;
}
function viewSchedule() {
  var t = todayKey(), keys = [], i, first = monday();
  for (i = 0; i < 28; i++) keys.push(addDays(first, i));
  if (!UI.aDay) UI.aDay = t;
  function v(m, l) { return '<button type="button" data-a="sview" data-v="' + m + '" aria-pressed="' + (UI.sView === m) + '">' + l + '</button>'; }
  var h = '<h1 class="page">Ημερολόγιο</h1><div class="seg">' + v('week', 'Εβδομάδα') + v('day', 'Ημέρα') + '</div>';
  if (UI.sView === 'week') h += weekView();
  else {
    var list = classesOn(UI.aDay);
    h += '<div class="days" id="dayStrip">' + keys.map(function (k) { var x = dateOf(k); return '<button type="button" data-a="aday" data-v="' + k + '" aria-pressed="' + (k === UI.aDay) + '" aria-label="' + niceDate(k) + '"><small>' + (k === t ? 'Σήμερα' : DAYS[x.getDay()]) + '</small><span>' + x.getDate() + '</span></button>'; }).join('') + '</div>';
    h += '<div class="acts"><button type="button" class="btn" data-a="new-class">Νέο μάθημα</button><button type="button" class="btn ghost" data-a="copy-day"' + (list.length ? '' : ' disabled') + '>Αντιγραφή ημέρας στην επόμενη εβδομάδα</button><button type="button" class="btn ghost" data-a="copy-week">Αντιγραφή όλης της εβδομάδας</button></div>';
    h += list.length ? '<div class="stack">' + list.map(adminClassRow).join('') + '</div>' : '<div class="empty"><span>Δεν υπάρχουν μαθήματα την ' + niceDate(UI.aDay) + '.</span></div>';
  }
  h += '<h2 class="sec">Κανόνες ανά είδος</h2>';
  ['w', 'p'].forEach(function (d) {
    var r = D.rules[d];
    function f(field, label, min, max) { return '<div class="field"><label for="r-' + d + '-' + field + '">' + label + '</label><input id="r-' + d + '-' + field + '" type="number" min="' + min + '" max="' + max + '" value="' + r[field] + '" data-rule="' + d + ':' + field + '"></div>'; }
    h += '<div class="panel"><b>' + DISC[d].name + '</b><div class="grid2">' + f('cancel_hours', 'Ακύρωση χωρίς χρέωση (ώρες πριν)', 0, 72) + f('register_minutes', 'Τέλος κρατήσεων (λεπτά πριν)', 0, 1440) + f('visible_days', 'Φαίνεται στα μέλη (μέρες μπροστά)', 1, 60) + '</div></div>';
  });
  return h;
}
function filteredMembers() {
  var q = UI.q.trim().toLowerCase();
  var list = D.members.filter(function (m) {
    if (q && (fullName(m) + ' ' + (m.phone || '') + ' ' + (m.email || '')).toLowerCase().indexOf(q) < 0) return false;
    if (UI.more) return memberAlerts(m).some(function (a) { return a.k === UI.more; });
    var k = subState(m, UI.mdisc).k;
    // In one discipline, "all" means everyone who has or had a subscription there.
    if (UI.filter === 'all') return UI.mdisc === 'all' || k !== 'none';
    return UI.filter === 'active' ? k === 'active' || k === 'soon' : k === UI.filter;
  });
  var d = UI.mdisc;
  // Expiring and expired members are most useful soonest first.
  if (UI.filter === 'soon' || UI.filter === 'active') list.sort(function (a, b) { return subState(a, d).left - subState(b, d).left; });
  if (UI.filter === 'expired') list.sort(function (a, b) { return subState(b, d).left - subState(a, d).left; });
  return list;
}
function memberListHtml() {
  var l = filteredMembers();
  return l.length ? l.map(memberRow).join('') : '<span class="muted">Δεν βρέθηκαν μέλη.</span>';
}
function viewMembers() {
  var d = UI.mdisc;
  var n = { active: countBy('active', d) + countBy('soon', d), soon: countBy('soon', d), expired: countBy('expired', d), none: countBy('none', d) };
  n.all = d === 'all' ? D.members.length : n.active + n.expired;
  function g(v, l) { return '<button type="button" data-a="mdisc" data-v="' + v + '" aria-pressed="' + (d === v) + '">' + l + '</button>'; }
  function f(v, l) { return '<button type="button" data-a="filter" data-v="' + v + '" aria-pressed="' + (!UI.more && UI.filter === v) + '">' + l + '<small>' + n[v] + '</small></button>'; }
  function o(v, l) { return '<button type="button" class="pill' + (UI.more === v ? ' d' : '') + '" data-a="more" data-v="' + v + '" aria-pressed="' + (UI.more === v) + '">' + l + '</button>'; }
  return '<h1 class="page">Μέλη</h1><div class="field"><label for="memberSearch">Αναζήτηση</label><input id="memberSearch" type="search" placeholder="Όνομα, κινητό ή email" value="' + esc(UI.q) + '"></div>' +
    '<div class="seg big d-' + (d === 'p' ? 'p' : 'w') + '">' + g('all', 'Όλοι') + g('w', 'Βάρη') + g('p', 'Πιλάτες') + '</div>' +
    '<div class="seg counts">' + f('all', 'Όλα') + f('active', 'Ενεργοί') + f('soon', 'Λήγουν') + f('expired', 'Έληξαν') + (d === 'all' ? f('none', 'Χωρίς') : '') + '</div>' +
    '<div class="pills">' + o('new', 'Νέες εγγραφές') + o('idle', 'Απόντες') + o('noacc', 'Δεν έχουν συνδεθεί') + o('nophone', 'Χωρίς κινητό') + '</div>' +
    '<div class="panel"><div class="small muted" id="memberCount">' + filteredMembers().length + ' μέλη</div><div id="memberList">' + memberListHtml() + '</div></div>' +
    '<div class="panel"><b>Αρχείο μελών και υπολοίπων</b><p class="small muted">Κατέβασέ το τακτικά, ώστε να ξέρεις τι είχε κάθε μέλος αν χαθούν δεδομένα. Δεν αντικαθιστά πλήρες αντίγραφο ασφαλείας. Έχει προσωπικά στοιχεία, οπότε φύλαξέ το με ασφάλεια.</p><button type="button" class="btn ghost" data-a="export-members">Κατέβασε αρχείο</button></div>';
}
function downloadCsv(filename, header, rows) {
  var c = xpImport.csvCell;
  var text = '﻿' + [header.map(c).join(',')].concat(rows.map(function (r) { return r.map(c).join(','); })).join('\r\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
function exportMembers() {
  function plan(s) {
    if (!s) return ['', '', '', ''];
    return s.kind === 'unlimited' ? ['Απεριόριστα', '', '', s.expires_on] : ['Επισκέψεις', s.visits_left, s.visits_total, s.expires_on];
  }
  var rows = D.members.map(function (m) {
    var subs = D.allSubs[m.id] || {};
    return [m.last_name, m.first_name, m.phone, m.email, m.level, m.status].concat(plan(subs.w), plan(subs.p));
  });
  downloadCsv('xp-training-meli-' + todayKey() + '.csv',
    ['Επώνυμο', 'Όνομα', 'Κινητό', 'Email', 'Επίπεδο', 'Κατάσταση',
      'Βάρη: τύπος', 'Βάρη: υπόλοιπο', 'Βάρη: σύνολο', 'Βάρη: λήξη',
      'Πιλάτες: τύπος', 'Πιλάτες: υπόλοιπο', 'Πιλάτες: σύνολο', 'Πιλάτες: λήξη'], rows);
  return rows.length;
}
function viewImport() {
  var imp = UI.imp;
  var h = '<h1 class="page">Εισαγωγή από Bookyway</h1>';
  if (!imp) {
    h += '<div class="panel"><p>Διάλεξε το αρχείο <b>Users Registry Report</b> από τις αναφορές του Bookyway. Το αρχείο διαβάζεται μόνο σε αυτόν τον browser και τίποτα δεν αποθηκεύεται πριν το εγκρίνεις.</p><p class="small muted">Περνούν μόνο όνομα, κινητό, email, λήξη συνδρομής. Σημειώσεις, διεύθυνση και ημερομηνία γέννησης δεν διαβάζονται.</p><div class="field"><label for="impFile">Αρχείο .xlsx</label><input id="impFile" type="file" accept=".xlsx"></div></div>';
  } else {
    var rows = imp.rows, undecided = rows.filter(function (r) { return !r.choice; }).length, chosen = rows.filter(function (r) { return r.choice && r.choice !== 'skip'; }).length;
    var issues = rows.filter(function (r) { return r.issues.length; }).length;
    h += '<div class="panel"><p><b>' + rows.length + '</b> μέλη στο αρχείο. <b>' + (rows.length - imp.inactive) + '</b> έχουν ενεργή συνδρομή και <b>' + imp.inactive + '</b> περνούν χωρίς συνδρομή.' + (issues ? ' <b>' + issues + '</b> θέλουν έλεγχο.' : '') + '</p>' +
      '<p class="small muted">Το Bookyway δεν ξεχωρίζει βάρη και πιλάτες, οπότε το είδος βγαίνει από τις παρουσίες ή το διαλέγεις εσύ. Όσοι έχουν λήξη από σήμερα και μετά περνούν ως «Απεριόριστα» με την ημερομηνία λήξης τους. Τα credits δεν μεταφέρονται. Όσοι δεν έχουν συνδρομή μπαίνουν στη λίστα, αλλά δεν κλείνουν θέση μέχρι να ανανεώσουν.</p>' +
      '<div class="field"><label for="impAtt">Αναφορά παρουσιών (Attendance Report Activities)</label><input id="impAtt" type="file" accept=".xlsx"></div>' +
      (imp.totals ? '<p class="small"><b>Από τις παρουσίες:</b> Βάρη ' + imp.totals.w + ' · Πιλάτες ' + imp.totals.p + ' · Και τα δύο ' + imp.totals.both + ' · Θέλουν επιλογή από σένα ' + undecided + '</p>' : '') +
      '<div class="acts"><button type="button" class="btn ghost tiny" data-a="imp-all" data-v="w">Όσα λείπουν: Βάρη</button><button type="button" class="btn ghost tiny" data-a="imp-all" data-v="p">Όσα λείπουν: Πιλάτες</button></div></div>';
    h += '<div class="tablewrap" tabindex="0"><table><thead><tr><th>Μέλος</th><th>Κινητό</th><th>Είδος</th><th>Παρουσίες</th><th>Επίπεδο</th><th>Πακέτο</th><th>Λήξη</th><th>Έλεγχος</th></tr></thead><tbody>' + rows.map(function (r, i) {
      function opt(v, l) { return '<option value="' + v + '"' + (r.choice === v ? ' selected' : '') + '>' + l + '</option>'; }
      var kindOpts = r.plan ? opt('', 'Διάλεξε') + opt('w', 'Βάρη') + opt('p', 'Πιλάτες') + (r.plan.kind === 'unlimited' ? opt('both', 'Και τα δύο') : '') : opt('none', 'Χωρίς συνδρομή');
      return '<tr><td>' + esc(r.last_name + ' ' + r.first_name) + '</td><td>' + esc(r.phone || '-') + '</td><td><select data-imp="' + i + '" aria-label="Είδος για ' + esc(r.last_name) + '">' + kindOpts + opt('skip', 'Να μην περαστεί') + '</select></td><td>' + (r.seen ? r.seen.w + ' βάρη, ' + r.seen.p + ' πιλάτες' : '-') + '</td><td>' + esc(r.level || '-') + '</td><td>' + (!r.plan ? '-' : r.plan.kind === 'count' ? r.plan.visits + ' επισκέψεις' : 'Απεριόριστα') + '</td><td>' + (r.plan ? shortDate(r.plan.expires) + '/' + r.plan.expires.slice(0, 4) : '-') + '</td><td>' + (r.issues.map(function (x) { return '<span class="pill warn">' + esc(x) + '</span>'; }).join(' ') || '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    h += '<div class="acts"><button type="button" class="btn ghost" data-a="imp-cancel">Άκυρο</button><button type="button" class="btn" data-a="imp-ask"' + (undecided || !chosen ? ' disabled' : '') + '>' + (undecided ? 'Μένουν ' + undecided + ' χωρίς επιλογή' : 'Έλεγχος και εισαγωγή (' + chosen + ')') + '</button></div>';
  }
  if (UI.impResult) {
    var res = UI.impResult;
    h += '<div class="panel"><b>Η εισαγωγή ολοκληρώθηκε</b><p>Νέα μέλη: ' + res.created + ' · Ενημερώθηκαν: ' + res.updated + ' · Με πρόβλημα: ' + res.errors.length + '</p>' + res.errors.map(function (e) { return '<div class="err">Bookyway ' + esc(e.bookyway_id) + ': ' + esc(e.reason) + '</div>'; }).join('') + '</div>';
  }
  var waiting = inviteCandidates();
  h += '<h2 class="sec">Κωδικοί πρόσκλησης</h2><div class="panel"><p>' + waiting.length + ' ενεργά μέλη με κινητό δεν έχουν ακόμα λογαριασμό ούτε έγκυρο κωδικό.</p><button type="button" class="btn ghost" data-a="invites"' + (waiting.length ? '' : ' disabled') + '>Φτιάξε κωδικούς</button>';
  if (UI.invites) {
    h += '<div class="notice">Οι κωδικοί φαίνονται μόνο τώρα. Κατέβασέ τους, δώσε τους στα μέλη και σβήσε το αρχείο όταν τελειώσεις.</div><button type="button" class="btn" data-a="invites-csv">Κατέβασε αρχείο (' + UI.invites.length + ')</button>' +
      '<div class="tablewrap" tabindex="0"><table><thead><tr><th>Μέλος</th><th>Κινητό</th><th>Email</th><th>Κωδικός</th></tr></thead><tbody>' + UI.invites.map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.phone) + '</td><td>' + esc(x.email || '-') + '</td><td><b>' + esc(x.code) + '</b></td></tr>'; }).join('') + '</tbody></table></div>';
  }
  return h + '</div>';
}
function inviteCandidates() {
  return D.members.filter(function (m) {
    return m.status === 'active' && m.phone && !m.auth_user_id && (!m.invite_expires || new Date(m.invite_expires) < new Date());
  });
}
function adminNav() {
  function b(t, l) { return '<button type="button" data-a="atab" data-v="' + t + '"' + (UI.admin === t ? ' aria-current="page"' : '') + '>' + l + '</button>'; }
  return '<nav class="nav" aria-label="Μενού διαχείρισης"><div>' + b('today', 'Αρχική') + b('schedule', 'Ημερολόγιο') + b('members', 'Μέλη') + b('import', 'Εισαγωγή') + '</div></nav>';
}

/* ---------- Sheets ---------- */
function classById(id) { return D.classes.filter(function (c) { return c.id === id; })[0]; }
function memberById(id) { return D.members.filter(function (m) { return m.id === id; })[0]; }
function sheetHtml() {
  var s = UI.sheet; if (!s) return '';
  var c = s.id ? classById(s.id) : null, h = '', dc = c ? c.d : 'w';
  if (s.kind === 'book' && c) {
    var sub = D.subs[c.d];
    h = '<h2 id="sheetTitle">' + esc(classTitle(c)) + '</h2><dl class="facts"><dt>Πότε</dt><dd>' + niceDate(c.date) + ', ' + c.time + '</dd><dt>Με</dt><dd>' + esc(c.coach) + '</dd><dt>Χρέωση</dt><dd>' + (sub.kind === 'count' ? '1 επίσκεψη (θα μείνουν ' + (sub.visits_left - 1) + ')' : 'Καμία, έχεις απεριόριστα') + '</dd><dt>Ακύρωση</dt><dd>' + (sub.kind !== 'count' ? 'Ελεύθερα πριν ξεκινήσει' : isLateCancel(c) ? 'Αν ακυρώσεις, η επίσκεψη δεν επιστρέφεται' : 'Χωρίς χρέωση μέχρι ' + fmtMoment(cancelDeadline(c))) + '</dd></dl>' +
      '<label class="check"><input type="checkbox" id="repeatBox"><span>Κάθε εβδομάδα, ' + DAY[c.start.getDay()] + ' ' + c.time + '</span></label>' +
      '<div class="acts"><button type="button" class="btn ghost" data-a="close">Πίσω</button><button type="button" class="btn" data-a="do-book" data-id="' + c.id + '">Κλείσε θέση</button></div>';
  } else if (s.kind === 'cancel' && c) {
    var pc = D.subs[c.d], late = isLateCancel(c);
    h = '<h2 id="sheetTitle">Ακύρωση κράτησης;</h2><p>' + esc(classTitle(c)) + ', ' + niceDate(c.date) + ' στις ' + c.time + '</p>' +
      (late && pc && pc.kind === 'count' ? '<div class="notice">Το όριο δωρεάν ακύρωσης πέρασε (' + fmtMoment(cancelDeadline(c)) + '). Η επίσκεψη δεν θα επιστραφεί.</div>' : '<p class="muted">' + (pc && pc.kind === 'count' ? 'Η επίσκεψη θα επιστραφεί στο υπόλοιπό σου.' : 'Η θέση θα ανοίξει για άλλο μέλος.') + '</p>') +
      '<div class="acts"><button type="button" class="btn ghost" data-a="close">Κράτα τη θέση</button><button type="button" class="btn danger" data-a="do-cancel" data-id="' + c.id + '">Ακύρωση κράτησης</button></div>';
  } else if (s.kind === 'class' && c) h = classSheet(c, s);
  else if (s.kind === 'member') h = memberSheet(memberById(s.id), s);
  else if (s.kind === 'new-class') h = newClassSheet(s);
  else if (s.kind === 'imp-confirm') {
    var payload = xpImport.toPayload(UI.imp.rows);
    h = '<h2 id="sheetTitle">Εισαγωγή ' + payload.length + ' μελών;</h2><p>Θα αποθηκευτούν όνομα, κινητό, email, είδος, υπόλοιπο και λήξη. Αν ένα μέλος έχει ήδη περαστεί, τα στοιχεία και το υπόλοιπό του θα αντικατασταθούν από το αρχείο.</p><p class="small muted">Κανένα μήνυμα δεν στέλνεται στα μέλη.</p><div class="acts"><button type="button" class="btn ghost" data-a="close">Πίσω</button><button type="button" class="btn" data-a="imp-go">Εισαγωγή</button></div>';
  } else if (s.kind === 'invites-confirm') {
    h = '<h2 id="sheetTitle">Κωδικοί για ' + inviteCandidates().length + ' μέλη;</h2><p>Κάθε κωδικός ισχύει 30 μέρες. Δεν στέλνεται τίποτα αυτόματα: εσύ αποφασίζεις πότε θα τους δώσεις.</p><div class="acts"><button type="button" class="btn ghost" data-a="close">Πίσω</button><button type="button" class="btn" data-a="invites-go">Φτιάξε κωδικούς</button></div>';
  }
  if (!h) return '';
  return '<div class="overlay" data-a="backdrop"><div class="sheet d-' + dc + '" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1">' + h + '</div></div>';
}
function classSheet(c, s) {
  var people = s.people;
  var body = '<p class="muted">Φόρτωση...</p>';
  if (people) {
    var rows = people.booked.map(function (b) {
      var m = memberById(b.member_id); if (!m) return '';
      var sub = (D.allSubs[m.id] || {})[c.d], bad = !sub || daysUntil(sub.expires_on) < 0;
      return '<div class="row"><div class="grow"><b>' + esc(fullName(m)) + '</b>' + (bad ? ' <span class="pill bad">Συνδρομή: έληξε</span>' : '') + '</div><div class="pills"><button type="button" class="btn tiny ' + (b.attended ? '' : 'ghost') + '" data-a="present" data-id="' + c.id + '" data-m="' + m.id + '" data-v="' + (b.attended ? '0' : '1') + '" aria-pressed="' + b.attended + '">' + (b.attended ? 'Ήρθε ✓' : 'Ήρθε') + '</button><button type="button" class="btn ghost tiny" data-a="admin-remove" data-id="' + c.id + '" data-m="' + m.id + '">Αφαίρεση</button></div></div>';
    }).join('');
    var waits = people.wait.map(function (w, i) { var m = memberById(w.member_id); return m ? '<div>' + (i + 1) + '. ' + esc(fullName(m)) + '</div>' : ''; }).join('');
    var taken = {}; people.booked.concat(people.wait).forEach(function (x) { taken[x.member_id] = 1; });
    var options = D.members.filter(function (m) { return !taken[m.id] && m.status === 'active'; }).map(function (m) { return '<option value="' + m.id + '">' + esc(fullName(m)) + '</option>'; }).join('');
    body = '<h3 class="sec" style="font-size:12.5px">Κρατήσεις</h3><div class="list">' + (rows || '<span class="muted">Καμία κράτηση ακόμα.</span>') + '</div>' +
      (waits ? '<h3 class="sec" style="font-size:12.5px">Λίστα αναμονής</h3><div class="stack small">' + waits + '</div>' : '') +
      '<div class="field"><label for="addMember">Κράτηση για μέλος</label><select id="addMember">' + options + '</select></div><button type="button" class="btn ghost" data-a="admin-add" data-id="' + c.id + '"' + (options ? '' : ' disabled') + '>' + (c.booked >= c.cap ? 'Προσθήκη στην αναμονή' : 'Προσθήκη') + '</button>';
  }
  return '<h2 id="sheetTitle">' + esc(classTitle(c)) + '</h2><div class="small muted">' + niceDate(c.date) + ', ' + c.time + ' · ' + esc(c.coach) + '</div>' + pips(c) + countText(c) + body +
    (s.confirmDel ? '<div class="notice">Θα ακυρωθούν ' + c.booked + ' κρατήσεις και θα επιστραφούν οι επισκέψεις. Τα μέλη θα δουν ειδοποίηση όταν ανοίξουν την εφαρμογή.</div><div class="acts"><button type="button" class="btn ghost" data-a="del-class-no">Πίσω</button><button type="button" class="btn danger" data-a="del-class" data-id="' + c.id + '">Ναι, ακύρωσε το μάθημα</button></div>' : '<div class="acts"><button type="button" class="btn ghost" data-a="close">Κλείσιμο</button><button type="button" class="btn danger" data-a="del-class-ask">Ακύρωση μαθήματος</button></div>');
}
function memberSheet(m, s) {
  if (!m) return '';
  var subs = D.allSubs[m.id] || {};
  function ed(d) {
    var pl = subs[d], kind = pl ? pl.kind : 'unlimited';
    var base = pl && pl.expires_on >= todayKey() ? pl.expires_on : todayKey();
    var left = pl ? daysUntil(pl.expires_on) : null;
    var status = pl ? '<strong>' + (left < 0 ? 'Έληξε' : planText(pl)) + '</strong><span class="small">' + (pl.kind === 'count' && left >= 0 ? 'επισκέψεις · ' : '') + planSub(pl) + (left >= 0 ? ' (' + leftText(left) + ')' : '') + '</span>' : '<span class="small muted">Χωρίς συνδρομή</span>';
    return '<div class="plan d-' + d + '"><b>' + DISC[d].name + '</b>' + status +
      '<div class="quick" role="group" aria-label="Γρήγορη ανανέωση ' + DISC[d].name + '">' + [[1, '+1 μήνας'], [3, '+3 μήνες'], [6, '+6 μήνες'], [12, '+1 χρόνος']].map(function (q) { return '<button type="button" class="btn ghost tiny" data-a="plan-add" data-v="' + d + '" data-n="' + q[0] + '" data-base="' + base + '">' + q[1] + '</button>'; }).join('') + '</div>' +
      '<div class="grid2"><div class="field"><label for="x-' + d + '">Λήξη</label><input id="x-' + d + '" type="date" value="' + (pl ? pl.expires_on : addMonths(todayKey(), 1)) + '"></div><div class="field"><label for="k-' + d + '">Τύπος</label><select id="k-' + d + '" data-kind="' + d + '"><option value="unlimited"' + (kind === 'unlimited' ? ' selected' : '') + '>Απεριόριστα</option><option value="count"' + (kind === 'count' ? ' selected' : '') + '>Επισκέψεις</option></select></div><div class="field"' + (kind === 'count' ? '' : ' hidden') + ' id="nf-' + d + '"><label for="n-' + d + '">Επισκέψεις</label><input id="n-' + d + '" type="number" min="1" max="999" value="' + (pl && pl.kind === 'count' ? pl.visits_left : 8) + '"></div></div>' +
      '<div class="acts"><button type="button" class="btn tiny" data-a="save-plan" data-id="' + m.id + '" data-v="' + d + '">' + (pl ? 'Αποθήκευση' : 'Ενεργοποίηση') + ' ' + DISC[d].name + '</button>' + (pl && left >= 0 ? '<button type="button" class="btn danger tiny" data-a="plan-stop" data-id="' + m.id + '" data-v="' + d + '">Διακοπή</button>' : '') + '</div></div>';
  }
  function bookingsHtml() {
    if (!s.bookings) return '<p class="small muted">Φόρτωση κρατήσεων...</p>';
    var mine = s.bookings.map(function (b) { var c = classById(b.class_id); return c ? { c: c, b: b } : null; }).filter(Boolean).sort(function (a, b) { return a.c.start - b.c.start; });
    var next = mine.filter(function (x) { return !isStarted(x.c); }), past = mine.filter(function (x) { return isStarted(x.c); });
    return '<div class="panel"><b>Επόμενες κρατήσεις (' + next.length + ')</b>' + (next.length ? '<div class="list">' + next.map(function (x) { return '<div class="row"><div class="grow">' + esc(classTitle(x.c)) + '<br><span class="small muted">' + niceDate(x.c.date) + ', ' + x.c.time + '</span></div><button type="button" class="btn ghost tiny" data-a="member-unbook" data-id="' + x.c.id + '" data-m="' + m.id + '">Αφαίρεση</button></div>'; }).join('') + '</div>' : '<span class="small muted">Καμία.</span>') +
      (past.length ? '<span class="small muted">Αυτή την εβδομάδα: ' + past.length + (past.length === 1 ? ' κράτηση' : ' κρατήσεις') + ', ήρθε σε ' + past.filter(function (x) { return x.b.attended; }).length + '.</span>' : '') + '</div>';
  }
  var al = memberAlerts(m);
  return '<h2 id="sheetTitle">' + esc(fullName(m)) + '</h2>' + (m.health_cert_expires ? '<div class="small" style="color:' + (daysLeftTo(m.health_cert_expires) <= 30 ? 'var(--bad)' : 'var(--muted)') + '">Κάρτα υγείας: λήγει ' + esc(leftText(daysLeftTo(m.health_cert_expires))) + ' (' + esc(String(m.health_cert_expires).split('-').reverse().join('/')) + ')</div>' : '<div class="small muted">Κάρτα υγείας: δεν έχει καταχωρηθεί</div>') + (al.length ? '<div class="pills">' + al.map(function (a) { return '<span class="pill ' + a.c + '">' + esc(a.t) + '</span>'; }).join('') + '</div>' : '') +
    ed('w') + ed('p') + bookingsHtml() + '<h3 class="sec" style="font-size:12.5px">Στοιχεία</h3>' +
    '<form class="stack" id="memberForm" data-id="' + m.id + '" novalidate><div class="grid2">' +
      '<div class="field"><label for="mfFirst">Όνομα</label><input id="mfFirst" value="' + esc(m.first_name) + '"></div>' +
      '<div class="field"><label for="mfLast">Επώνυμο</label><input id="mfLast" value="' + esc(m.last_name) + '"></div>' +
      '<div class="field"><label for="mfPhone">Κινητό</label><input id="mfPhone" inputmode="numeric" placeholder="69XXXXXXXX" value="' + esc(m.phone || '') + '"></div>' +
      '<div class="field"><label for="mfEmail">Email</label><input id="mfEmail" type="email" value="' + esc(m.email || '') + '"></div>' +
      '<div class="field"><label for="mfLimit">Όριο ανά εβδομάδα</label><select id="mfLimit"><option value=""' + (m.weekly_limit == null ? ' selected' : '') + '>Απεριόριστα</option>' + [1, 2, 3, 4, 5, 6, 7].map(function (n) { return '<option value="' + n + '"' + (m.weekly_limit === n ? ' selected' : '') + '>' + n + (n === 1 ? ' φορά' : ' φορές') + ' την εβδομάδα</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="mfCert">Λήξη κάρτας υγείας</label><input id="mfCert" type="date" value="' + esc(m.health_cert_expires ? String(m.health_cert_expires).slice(0, 10) : '') + '"></div></div>' +
      (s.err ? '<span class="err">' + esc(s.err) + '</span>' : '') +
      '<div class="acts"><button type="button" class="btn ghost tiny" data-a="swap-name">Αντιμετάθεση ονόματος και επωνύμου</button><button type="submit" class="btn tiny">Αποθήκευση στοιχείων</button></div>' +
      (m.auth_user_id ? '<p class="small muted">Αν αλλάξεις το κινητό, το μέλος χρειάζεται νέο κωδικό πρόσκλησης για να ξανασυνδεθεί.</p>' : '') + '</form>' +
    '<div class="field"><label for="memberLevel">Επίπεδο στα πιλάτες</label><select id="memberLevel" data-level="' + m.id + '"><option value="">Δεν έχει οριστεί</option>' + LEVELS.map(function (l) { return '<option' + (m.level === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select></div>' +
    '<div class="panel"><b>Κωδικός πρόσκλησης</b><p class="small muted">Για πρώτη ενεργοποίηση ή όταν το μέλος ξεχάσει τον κωδικό του. Ισχύει 30 μέρες.</p>' + (s.code ? '<div class="code">' + esc(s.code) + '</div><p class="small muted">Φαίνεται μόνο τώρα.</p>' : '<button type="button" class="btn ghost tiny" data-a="one-invite" data-id="' + m.id + '"' + (m.phone ? '' : ' disabled') + '>Νέος κωδικός</button>') + '</div>' +
    (m.id === D.me.id ? '' : s.confirmDelete ? '<div class="notice"><b>Οριστική διαγραφή: ' + esc(fullName(m)) + '</b><br>Σβήνονται το μέλος, οι συνδρομές, οι κρατήσεις και η λίστα αναμονής του. Δεν γίνεται αναίρεση.</div><div class="acts"><button type="button" class="btn ghost" data-a="del-member-no">Πίσω</button><button type="button" class="btn danger" data-a="del-member" data-id="' + m.id + '">Ναι, διαγραφή</button></div>' : '<button type="button" class="btn danger" data-a="del-member-ask">Διαγραφή μέλους</button>') +
    '<button type="button" class="btn ghost" data-a="close">Κλείσιμο</button>';
}
function newClassSheet(s) {
  return '<h2 id="sheetTitle">Νέο μάθημα</h2><form class="stack" id="newClassForm" novalidate>' +
    '<div class="grid2"><div class="field"><label for="ncD">Είδος</label><select id="ncD"><option value="w">Βάρη</option><option value="p">Πιλάτες</option></select></div><div class="field"><label for="ncLevel">Επίπεδο (για πιλάτες)</label><select id="ncLevel">' + LEVELS.map(function (l) { return '<option>' + l + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label for="ncDate">Ημέρα</label><input id="ncDate" type="date" value="' + (UI.aDay || todayKey()) + '"></div><div class="field"><label for="ncTime">Ώρα</label><input id="ncTime" type="time" value="18:00"></div>' +
    '<div class="field"><label for="ncDur">Διάρκεια (λεπτά)</label><input id="ncDur" type="number" min="10" max="240" value="60"></div><div class="field"><label for="ncCap">Θέσεις</label><input id="ncCap" type="number" min="1" max="100" value="10"></div></div>' +
    '<div class="field"><label for="ncCoach">Προπονητής</label><input id="ncCoach"></div>' + (s.err ? '<span class="err">' + esc(s.err) + '</span>' : '') +
    '<div class="acts"><button type="button" class="btn ghost" data-a="close">Πίσω</button><button type="submit" class="btn">Αποθήκευση</button></div></form>';
}

/* ---------- Render ---------- */
function render() {
  var body, nav = '', cls = 'wrap';
  if (UI.screen === 'setup') {
    body = LOGO + '<div class="notice">Η εφαρμογή δεν έχει συνδεθεί ακόμα με τη βάση δεδομένων. Συμπλήρωσε το αρχείο config.js σύμφωνα με τις οδηγίες.</div>';
    cls += ' bare';
  } else if (UI.screen === 'offline') {
    body = LOGO + '<div class="notice">' + esc(UI.authErr || 'Δεν υπάρχει σύνδεση στο internet.') + '</div>' +
      '<p class="small muted">Μένεις συνδεδεμένος. Η εφαρμογή θα φορτώσει μόλις επανέλθει η σύνδεση.</p>' +
      '<button type="button" class="btn full" data-a="retry">Δοκίμασε ξανά</button>';
    cls += ' bare';
  } else if (UI.screen === 'auth') {
    body = viewAuth(); cls += ' bare';
  } else if (UI.mode === 'admin' && D.me.is_admin) {
    body = modeBar() + (UI.admin === 'schedule' ? viewSchedule() : UI.admin === 'members' ? viewMembers() : UI.admin === 'import' ? viewImport() : viewToday());
    nav = adminNav();
    if (UI.admin === 'import' || (UI.admin === 'schedule' && UI.sView === 'week')) cls += ' wide';
  } else {
    body = modeBar() + (UI.tab === 'bookings' ? viewBookings() : UI.tab === 'profile' ? viewProfile() : viewProgram());
    nav = memberNav();
  }
  byId('app').innerHTML = '<main class="' + cls + ' d-' + (UI.mode === 'member' ? UI.disc : 'w') + '">' + body + '</main>' + nav;
  var strip = byId('dayStrip');
  if (strip) { var on = strip.querySelector('[aria-pressed="true"]'); if (on) strip.scrollLeft = Math.max(0, on.offsetLeft - strip.offsetLeft - 60); }
  renderSheet();
}
function renderSheet() {
  var root = byId('sheetRoot');
  var keep = root.querySelector('#sheet'), top = keep ? keep.scrollTop : 0;
  root.innerHTML = sheetHtml();
  var sh = root.querySelector('#sheet');
  if (sh) { sh.scrollTop = top; if (!keep) sh.focus(); }
}
async function loadMemberBookings(id) {
  try {
    var list = await api.memberBookings(id);
    if (UI.sheet && UI.sheet.kind === 'member' && UI.sheet.id === id) { UI.sheet.bookings = list; renderSheet(); }
  } catch (e) { if (UI.sheet && UI.sheet.kind === 'member') { UI.sheet.bookings = []; renderSheet(); } }
}
async function loadPeople(id) {
  var people = await api.classPeople(id);
  if (UI.sheet && UI.sheet.kind === 'class' && UI.sheet.id === id) { UI.sheet.people = people; renderSheet(); }
}

/* ---------- Actions ---------- */
function closeSheet() { UI.sheet = null; render(); }
var ACT = {
  'auth-mode': function (t) { UI.authMode = t.dataset.v; UI.authErr = ''; UI.authInfo = ''; render(); },
  forgot: async function () {
    var phone = phoneValue();
    if (!/^69\d{8}$/.test(phone)) { UI.authErr = 'Γράψε πρώτα το κινητό σου (10 ψηφία, ξεκινά από 69) και πάτα ξανά «Ξέχασα τον κωδικό μου».'; render(); return; }
    if (busy) return;
    busy = true; UI.authErr = '';
    try {
      var r = await api.forgot(phone);
      UI.authMode = 'claim';
      UI.authInfo = 'Σου στείλαμε κωδικό στο ' + (r.sent_to || 'email σου') + '. Γράψ\' τον παρακάτω και πάτα Ενεργοποίηση. Αυτός θα είναι ο κωδικός σου για να μπαίνεις. Αν δεν τον βλέπεις, κοίτα και στα ανεπιθύμητα.';
      render();
      var el = byId('auPhone'); if (el) el.value = phone;
    } catch (e) { UI.authErr = friendlyError(e); render(); var el2 = byId('auPhone'); if (el2) el2.value = phone; }
    finally { busy = false; }
  },
  mode: function (t) { UI.mode = t.dataset.v; UI.sheet = null; render(); },
  tab: function (t) { UI.tab = t.dataset.v; render(); },
  atab: function (t) { UI.admin = t.dataset.v; render(); },
  disc: function (t) { UI.disc = t.dataset.v; UI.day = null; render(); },
  day: function (t) { UI.day = t.dataset.v; render(); },
  aday: function (t) { UI.aDay = t.dataset.v; render(); },
  'aday-day': function (t) { UI.aDay = t.dataset.v; UI.sView = 'day'; render(); },
  sview: function (t) { UI.sView = t.dataset.v; render(); },
  wk: function (t) { var n = +t.dataset.v, cur = UI.wk || weekStart(todayKey()); UI.wk = n ? addDays(cur, n) : weekStart(todayKey()); UI.aDay = UI.wk; render(); },
  more: function (t) { UI.more = UI.more === t.dataset.v ? '' : t.dataset.v; render(); },
  'goto-more': function (t) { UI.more = t.dataset.v; UI.admin = 'members'; render(); },
  close: closeSheet,
  retry: function () { openApp(); },
  logout: async function () { stopLiveUpdates(); await api.logout(); D = { me: null, subs: {}, rules: {}, classes: [], recurring: [], members: [], allSubs: {}, notes: [] }; UI.screen = 'auth'; UI.authMode = 'login'; UI.authErr = ''; UI.mode = 'member'; UI.sheet = null; UI.imp = null; UI.impResult = null; UI.invites = null; UI.q = ''; render(); },
  'ask-book': function (t) { UI.sheet = { kind: 'book', id: t.dataset.id }; render(); },
  'ask-cancel': function (t) { UI.sheet = { kind: 'cancel', id: t.dataset.id }; render(); },
  'do-book': function (t) {
    var c = classById(t.dataset.id), box = byId('repeatBox'), rep = box && box.checked;
    var label = niceDate(c.date) + ', ' + c.time, wd = DAY[c.start.getDay()], time = c.time;
    run(function () { return api.book(c.id, rep); }, function (r) {
      return rep ? 'Σταθερή κράτηση κάθε ' + wd + ' ' + time + '. Κλείστηκαν ' + r.booked + ' μαθήματα' + (r.skipped ? ', ' + r.skipped + ' δεν κλείστηκαν' : '') + '.' : 'Έκλεισες θέση: ' + label;
    }, { closeSheet: true });
  },
  'do-cancel': function (t) {
    var c = classById(t.dataset.id), sub = D.subs[c.d];
    run(function () { return api.cancel(c.id); }, function (r) { return r.late && sub && sub.kind === 'count' ? 'Η κράτηση ακυρώθηκε. Η επίσκεψη δεν επιστράφηκε.' : 'Η κράτηση ακυρώθηκε.'; }, { closeSheet: true });
  },
  'join-wait': function (t) { run(function () { return api.joinWait(t.dataset.id); }, 'Μπήκες στην αναμονή. Αν ανοίξει θέση, κλείνεται αυτόματα.'); },
  'leave-wait': function (t) { run(function () { return api.leaveWait(t.dataset.id); }, 'Βγήκες από την αναμονή.'); },
  'notes-read': function () { run(function () { return api.markNotesRead(); }); },
  'copy-week': function () {
    var first = addDays(UI.aDay, -((dateOf(UI.aDay).getDay() + 6) % 7)), n = 0, list = [], i;
    for (i = 0; i < 7; i++) list = list.concat(classesOn(addDays(first, i)));
    run(async function () {
      for (var j = 0; j < list.length; j++) {
        var c = list[j], target = addDays(c.date, 7);
        if (classesOn(target).some(function (x) { return x.time === c.time && x.d === c.d && x.level === c.level; })) continue;
        var a = c.time.split(':'), s = dateOf(target); s.setHours(+a[0], +a[1], 0, 0);
        await api.createClass({ discipline: c.d, level: c.level, starts_at: s.toISOString(), duration_min: c.dur, capacity: c.cap, coach: c.coach });
        n++;
      }
    }, function () { return n ? 'Αντιγράφηκαν ' + n + ' μαθήματα στην εβδομάδα της ' + shortDate(addDays(first, 7)) + '.' : 'Τα μαθήματα υπάρχουν ήδη στην εβδομάδα της ' + shortDate(addDays(first, 7)) + '.'; });
  },
  'rec-del': function (t) { run(function () { return api.stopRecurring(t.dataset.id); }, 'Η σταθερή κράτηση σταμάτησε. Όσες έχουν ήδη κλειστεί παραμένουν.'); },
  'open-class': function (t) { UI.sheet = { kind: 'class', id: t.dataset.id, people: null }; render(); loadPeople(t.dataset.id).catch(function (e) { toast(friendlyError(e)); }); },
  'open-member': function (t) { UI.sheet = { kind: 'member', id: t.dataset.id }; render(); loadMemberBookings(t.dataset.id); },
  'member-unbook': function (t) { var mid = t.dataset.m; run(function () { return api.adminRemove(mid, t.dataset.id); }, 'Η κράτηση αφαιρέθηκε.', { after: function () { return loadMemberBookings(mid); } }); },
  'del-member-ask': function () { UI.sheet.confirmDelete = true; renderSheet(); var sh = byId('sheet'); if (sh) sh.scrollTop = sh.scrollHeight; },
  'del-member-no': function () { UI.sheet.confirmDelete = false; renderSheet(); },
  'del-member': function (t) {
    var id = t.dataset.id, m = memberById(id), name = m ? fullName(m) : '', upcoming = ((UI.sheet && UI.sheet.bookings) || []).filter(function (b) { var c = classById(b.class_id); return c && !isStarted(c); });
    run(async function () {
      // Future places are freed the normal way first, so the waiting list moves up.
      for (var i = 0; i < upcoming.length; i++) await api.adminRemove(id, upcoming[i].class_id);
      return api.deleteMember(id);
    }, 'Το μέλος ' + name + ' διαγράφηκε.', { closeSheet: true });
  },
  'plan-add': function (t) { var el = byId('x-' + t.dataset.v); if (el) el.value = addMonths(t.dataset.base, +t.dataset.n); },
  'plan-stop': function (t) { var d = t.dataset.v, sub = (D.allSubs[t.dataset.id] || {})[d]; if (!sub) return; run(function () { return api.saveSubscription(t.dataset.id, d, sub.kind, sub.kind === 'count' ? sub.visits_left : null, addDays(todayKey(), -1)); }, DISC[d].name + ': η συνδρομή διακόπηκε.'); },
  present: function (t) { var id = t.dataset.id; run(function () { return api.setAttended(t.dataset.m, id, t.dataset.v === '1'); }, null, { after: function () { return loadPeople(id); } }); },
  'admin-remove': function (t) { var id = t.dataset.id; run(function () { return api.adminRemove(t.dataset.m, id); }, 'Αφαιρέθηκε. Αν υπήρχε αναμονή, η θέση πέρασε στον επόμενο.', { after: function () { return loadPeople(id); } }); },
  'admin-add': function (t) { var id = t.dataset.id, mid = byId('addMember').value; run(function () { return api.adminBook(mid, id); }, function (r) { return r === 'waitlist' ? 'Μπήκε στην αναμονή.' : 'Προστέθηκε.'; }, { after: function () { return loadPeople(id); } }); },
  'del-class-ask': function () { UI.sheet.confirmDel = true; renderSheet(); },
  'del-class-no': function () { UI.sheet.confirmDel = false; renderSheet(); },
  'del-class': function (t) { run(function () { return api.deleteClass(t.dataset.id); }, 'Το μάθημα ακυρώθηκε και οι επισκέψεις επιστράφηκαν.', { closeSheet: true }); },
  'new-class': function () { UI.sheet = { kind: 'new-class' }; render(); },
  'copy-day': function () {
    var list = classesOn(UI.aDay), target = addDays(UI.aDay, 7), existing = classesOn(target), n = 0;
    run(async function () {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (existing.some(function (x) { return x.time === c.time && x.d === c.d && x.level === c.level; })) continue;
        var a = c.time.split(':'), s = dateOf(target); s.setHours(+a[0], +a[1], 0, 0);
        await api.createClass({ discipline: c.d, level: c.level, starts_at: s.toISOString(), duration_min: c.dur, capacity: c.cap, coach: c.coach });
        n++;
      }
    }, function () { return n ? 'Αντιγράφηκαν ' + n + ' μαθήματα στις ' + shortDate(target) + '.' : 'Τα μαθήματα υπάρχουν ήδη στις ' + shortDate(target) + '.'; });
  },
  'save-plan': function (t) {
    var d = t.dataset.v, kind = byId('k-' + d).value, n = parseInt(byId('n-' + d).value, 10), exp = byId('x-' + d).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) { toast('Διάλεξε ημερομηνία λήξης.'); return; }
    if (kind === 'count' && !(n >= 1 && n <= 999)) { toast('Γράψε πόσες επισκέψεις, από 1 έως 999.'); return; }
    run(function () { return api.saveSubscription(t.dataset.id, d, kind, kind === 'count' ? n : null, exp); }, DISC[d].name + ': η συνδρομή ισχύει έως ' + shortDate(exp) + '.');
  },
  'swap-name': function () { var a = byId('mfFirst'), b = byId('mfLast'), x = a.value; a.value = b.value; b.value = x; },
  'one-invite': function (t) { var id = t.dataset.id; run(function () { return api.newInvite(id); }, null, { after: function (code) { if (UI.sheet) UI.sheet.code = code; } }); },
  filter: function (t) { UI.filter = t.dataset.v; UI.more = ''; render(); },
  mdisc: function (t) { UI.mdisc = t.dataset.v; UI.more = ''; if (t.dataset.v !== 'all' && UI.filter === 'none') UI.filter = 'active'; render(); },
  'goto-filter': function (t) { UI.filter = t.dataset.v === 'exp' ? 'soon' : t.dataset.v; UI.more = ''; UI.mdisc = 'all'; UI.admin = 'members'; render(); },
  'imp-all': function (t) { UI.imp.rows.forEach(function (r) { if (!r.choice) r.choice = t.dataset.v; }); render(); },
  'imp-cancel': function () { UI.imp = null; render(); },
  'imp-ask': function () { UI.sheet = { kind: 'imp-confirm' }; render(); },
  'imp-go': function () {
    var payload = xpImport.toPayload(UI.imp.rows);
    run(function () { return api.importMembers(payload); }, 'Η εισαγωγή ολοκληρώθηκε.', { closeSheet: true, after: function (r) { UI.impResult = r; UI.imp = null; } });
  },
  invites: function () { UI.sheet = { kind: 'invites-confirm' }; render(); },
  'invites-go': function () {
    var list = inviteCandidates(), out = [];
    run(async function () {
      for (var i = 0; i < list.length; i++) out.push({ name: fullName(list[i]), phone: list[i].phone, email: list[i].email, code: await api.newInvite(list[i].id) });
    }, function () { return 'Φτιάχτηκαν ' + out.length + ' κωδικοί.'; }, { closeSheet: true, after: function () { UI.invites = out; } });
  },
  'invites-csv': function () {
    downloadCsv('xp-training-kodikoi.csv', ['Μέλος', 'Κινητό', 'Email', 'Κωδικός'], UI.invites.map(function (x) { return [x.name, x.phone, x.email, x.code]; }));
  },
  'export-members': function () {
    var n = 0;
    run(function () { return Promise.resolve(); }, function () { return 'Κατέβηκε αρχείο με ' + n + ' μέλη. Φύλαξέ το με ασφάλεια.'; }, { after: function () { n = exportMembers(); } });
  },
};
function submitNewClass() {
  var g = function (id) { return byId(id).value; };
  var d = g('ncD'), date = g('ncDate'), time = g('ncTime'), dur = parseInt(g('ncDur'), 10), cap = parseInt(g('ncCap'), 10), coach = g('ncCoach').trim();
  var err = !date || !time ? 'Διάλεξε ημέρα και ώρα.' : !(dur >= 10 && dur <= 240) ? 'Η διάρκεια πρέπει να είναι από 10 έως 240 λεπτά.' : !(cap >= 1 && cap <= 100) ? 'Οι θέσεις πρέπει να είναι από 1 έως 100.' : !coach ? 'Γράψε τον προπονητή.' : '';
  if (err) { UI.sheet.err = err; renderSheet(); return; }
  var a = time.split(':'), s = dateOf(date); s.setHours(+a[0], +a[1], 0, 0);
  run(function () { return api.createClass({ discipline: d, level: d === 'p' ? g('ncLevel') : null, starts_at: s.toISOString(), duration_min: dur, capacity: cap, coach: coach }); }, 'Το μάθημα προστέθηκε.', { closeSheet: true, after: function () { UI.aDay = date; } });
}

function submitMemberForm(form) {
  var id = form.dataset.id, first = byId('mfFirst').value.trim(), last = byId('mfLast').value.trim(), phone = cleanPhone(byId('mfPhone').value), email = byId('mfEmail').value.trim();
  var err = !first || !last ? 'Γράψε όνομα και επώνυμο.' : phone && !/^69\d{8}$/.test(phone) ? 'Το κινητό θέλει 10 ψηφία και να ξεκινά από 69.' : email && !/^\S+@\S+\.\S+$/.test(email) ? 'Το email δεν φαίνεται σωστό.' : '';
  if (err) { UI.sheet.err = err; renderSheet(); return; }
  UI.sheet.err = '';
  run(function () { var lim = byId('mfLimit') ? byId('mfLimit').value : '', cert = byId('mfCert') ? byId('mfCert').value : '';
    return api.updateMember(id, { first_name: first, last_name: last, phone: phone || null, email: email || null, weekly_limit: lim ? +lim : null, health_cert_expires: cert || null }); }, 'Τα στοιχεία αποθηκεύτηκαν.');
}
async function handleFile(file) {
  if (!file) return;
  try {
    await loadXlsx();
    var parsed = xpImport.parseFile(await file.arrayBuffer(), todayKey());
    UI.imp = parsed; UI.impResult = null;
    render();
  } catch (e) { toast(friendlyError(e)); }
}
async function handleAttendanceFile(file) {
  if (!file || !UI.imp) return;
  try {
    await loadXlsx();
    var att = xpImport.parseAttendanceFile(await file.arrayBuffer());
    UI.imp.totals = xpImport.applyAttendance(UI.imp.rows, att);
    render();
    toast('Οι παρουσίες διαβάστηκαν. Έλεγξε τις επιλογές πριν από την εισαγωγή.');
  } catch (e) { toast(friendlyError(e)); }
}
// The Excel reader is only downloaded when the admin imports a file.
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = function () { reject(new Error('Δεν φορτώθηκε το εργαλείο ανάγνωσης Excel. Έλεγξε τη σύνδεσή σου.')); };
    document.head.appendChild(s);
  });
}

function bindEvents() {
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-a]');
    if (!t) return;
    var a = t.dataset.a;
    if (a === 'backdrop') { if (e.target === t) closeSheet(); return; }
    if (ACT[a]) ACT[a](t);
  });
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = e.target.id;
    if (id === 'loginForm') submitLogin();
    else if (id === 'claimForm') submitClaim();
    else if (id === 'registerForm') submitRegister();
    else if (id === 'newClassForm') submitNewClass();
    else if (id === 'memberForm') submitMemberForm(e.target);
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'memberSearch') { UI.q = e.target.value; byId('memberList').innerHTML = memberListHtml(); var mc = byId('memberCount'); if (mc) mc.textContent = filteredMembers().length + ' μέλη'; }
  });
  document.addEventListener('change', function (e) {
    var el = e.target, ds = el.dataset || {};
    if (el.id === 'impFile') handleFile(el.files[0]);
    if (el.id === 'impAtt') handleAttendanceFile(el.files[0]);
    if (el.id === 'ncD') { byId('ncCap').value = el.value === 'p' ? 5 : 10; byId('ncDur').value = el.value === 'p' ? 50 : 60; }
    if (ds.imp !== undefined) { UI.imp.rows[+ds.imp].choice = el.value; render(); }
    if (ds.rule) {
      var p = ds.rule.split(':'), v = parseInt(el.value, 10);
      if (isNaN(v) || v < +el.min || v > +el.max) { el.value = D.rules[p[0]][p[1]]; toast('Γράψε τιμή από ' + el.min + ' έως ' + el.max + '.'); return; }
      run(function () { return api.saveRule(p[0], p[1], v); }, 'Ο κανόνας για ' + DISC[p[0]].name + ' αποθηκεύτηκε.');
    }
    if (ds.kind) { var nf = byId('nf-' + ds.kind); if (nf) nf.hidden = el.value !== 'count'; }
    if (ds.level) { run(function () { return api.updateMember(ds.level, { level: el.value || null }); }, 'Το επίπεδο αποθηκεύτηκε.'); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && UI.sheet) closeSheet(); });
  // Coming back to the app always shows the latest state.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) softRefresh(); });
  window.addEventListener('focus', softRefresh);
  // An update held back while typing is shown once typing ends.
  document.addEventListener('focusout', function () {
    setTimeout(function () { if (pendingRender && !isEditing()) { pendingRender = false; render(); } }, 200);
  });
}

async function start() {
  bindEvents();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  if (!api.configured) { UI.screen = 'setup'; render(); return; }
  await openApp();
  // A phone that comes back online retries on its own, without asking for the password again.
  window.addEventListener('online', function () { if (UI.screen === 'offline') openApp(); });
}
// A saved login is kept until the member taps «Αποσύνδεση». A weak connection never logs anyone out.
async function openApp() {
  var hasSession = false;
  try { hasSession = await api.hasSession(); } catch (e) { hasSession = api.hasSavedSession(); }
  if (!hasSession) { UI.screen = 'auth'; render(); return; }
  try {
    await refresh(); UI.screen = 'app'; UI.authErr = ''; startLive();
  } catch (e) {
    if (api.isAuthError(e)) { await api.logout().catch(function () {}); UI.screen = 'auth'; UI.authErr = 'Η σύνδεσή σου έληξε. Μπες ξανά με τον κωδικό σου.'; }
    else { UI.screen = 'offline'; UI.authErr = friendlyError(e); }
  }
  render();
}
start();
