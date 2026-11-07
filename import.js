// Reads the Bookyway "Users Registry Report" inside the admin's browser.
// Only the fields the new system needs are kept. Notes, address and date of birth are never read.
(function () {
  var REQUIRED = ['Id', 'Surname', 'Name', 'E-mail', 'Phone', 'Subscription Expiration', 'Invalid Email', 'Available credits'];
  var CREDIT_FALLBACK_DAYS = 365;
  var LEVELS = ['Αρχάριοι', 'Μέτριοι', 'Προχωρημένοι'];
  var STRONG = 0.8; // Share of visits above which a member counts as doing mainly one discipline.

  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function excelDateKey(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    var d = new Date(Math.round((n - 25569) * 864e5));
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  }
  function normalizePhone(v) {
    var s = String(v == null ? '' : v).replace(/[^\d]/g, '').replace(/^00/, '');
    if (s.length === 12 && s.indexOf('30') === 0) s = s.slice(2);
    return /^69\d{8}$/.test(s) ? s : null;
  }
  function addDaysKey(key, days) {
    var a = key.split('-');
    var d = new Date(Date.UTC(+a[0], +a[1] - 1, +a[2] + days));
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  }

  // rows: objects keyed by the file's column titles. Keeps every member.
  // Only those still active today or holding credits get a subscription.
  function parseRows(rows, todayKey) {
    if (!rows.length) throw new Error('Το αρχείο είναι άδειο.');
    var missing = REQUIRED.filter(function (h) { return !(h in rows[0]); });
    if (missing.length) throw new Error('Αυτό δεν μοιάζει με το Users Registry Report. Λείπουν οι στήλες: ' + missing.join(', ') + '.');
    var seenPhones = {}, out = [], inactive = 0;
    rows.forEach(function (r) {
      var exp = excelDateKey(r['Subscription Expiration']);
      var credits = Math.floor(Number(r['Available credits']) || 0);
      var active = exp && exp >= todayKey;
      var hasPlan = active || credits > 0;
      if (!hasPlan) inactive++;
      var issues = [];
      var phone = normalizePhone(r['Phone']);
      if (!phone) issues.push('Χωρίς σωστό κινητό');
      else if (seenPhones[phone]) { issues.push('Ίδιο κινητό με άλλο μέλος'); phone = null; }
      if (phone) seenPhones[phone] = true;
      var email = String(r['E-mail'] || '').trim();
      if (String(r['Invalid Email']).trim().toUpperCase() === 'Y' || !/^\S+@\S+\.\S+$/.test(email)) email = '';
      var plan = null;
      if (!hasPlan) {
        // Stays on the list without a subscription, until it is renewed.
      } else if (credits > 0) {
        plan = { kind: 'count', visits: credits, expires: active ? exp : addDaysKey(todayKey, CREDIT_FALLBACK_DAYS) };
        if (!active) issues.push('Credits χωρίς ενεργή λήξη: μπαίνει 1 χρόνος');
      } else {
        plan = { kind: 'unlimited', visits: null, expires: exp };
      }
      out.push({
        // In this club's Bookyway records the surname sits in the Name column.
        bookyway_id: String(r['Id']), first_name: String(r['Surname'] || '').trim(), last_name: String(r['Name'] || '').trim(),
        phone: phone, email: email, plan: plan, issues: issues, choice: hasPlan ? '' : 'none',
      });
    });
    out.sort(function (a, b) { return a.last_name.localeCompare(b.last_name, 'el'); });
    return { rows: out, inactive: inactive };
  }

  function readSheet(arrayBuffer) {
    if (!window.XLSX) throw new Error('Δεν φορτώθηκε το εργαλείο ανάγνωσης Excel. Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.');
    var wb = window.XLSX.read(arrayBuffer, { type: 'array' });
    return window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: '' });
  }
  function parseFile(arrayBuffer, todayKey) { return parseRows(readSheet(arrayBuffer), todayKey); }

  // Counts bookings per member from the Bookyway attendance report. Keeps nothing else from that file.
  function parseAttendance(rows) {
    if (!rows.length) throw new Error('Η αναφορά παρουσιών είναι άδεια.');
    var missing = ['Id', 'Activity Name', 'Waiting list'].filter(function (h) { return !(h in rows[0]); });
    if (missing.length) throw new Error('Αυτό δεν μοιάζει με την αναφορά παρουσιών. Λείπουν οι στήλες: ' + missing.join(', ') + '.');
    var out = {};
    rows.forEach(function (r) {
      if (String(r['Waiting list']).trim()) return;
      var id = String(r['Id']), name = String(r['Activity Name']), c = out[id] || (out[id] = { w: 0, p: 0, levels: {} });
      if (!/pilates/i.test(name)) { c.w++; return; }
      c.p++;
      LEVELS.forEach(function (l) { if (name.indexOf(l) >= 0) c.levels[l] = (c.levels[l] || 0) + 1; });
    });
    return out;
  }
  function parseAttendanceFile(arrayBuffer) { return parseAttendance(readSheet(arrayBuffer)); }

  // Sets the discipline and Pilates level from attendance. Choices made by hand are kept.
  function applyAttendance(rows, att) {
    var totals = { w: 0, p: 0, both: 0, ask: 0 };
    rows.forEach(function (r) {
      var c = att[r.bookyway_id];
      r.seen = c ? { w: c.w, p: c.p } : { w: 0, p: 0 };
      if (c && c.p) {
        r.level = Object.keys(c.levels).sort(function (a, b) { return c.levels[b] - c.levels[a]; })[0] || null;
      }
      if (!r.plan) return;
      if (!r.choice) r.choice = guess(r, c);
      if (r.choice === 'w') totals.w++; else if (r.choice === 'p') totals.p++; else if (r.choice === 'both') totals.both++; else if (!r.choice) totals.ask++;
    });
    return totals;
  }
  function guess(r, c) {
    if (!c || !(c.w + c.p)) return '';
    var share = c.p / (c.w + c.p);
    if (share >= STRONG) return 'p';
    if (share <= 1 - STRONG) return 'w';
    return r.plan.kind === 'unlimited' ? 'both' : ''; // A visit balance cannot be split by a guess.
  }

  // Builds what the server receives. Rows marked "skip" or not yet chosen are left out.
  function toPayload(rows) {
    return rows.filter(function (r) { return r.choice && r.choice !== 'skip'; }).map(function (r) {
      var plans = {};
      if (r.plan && (r.choice === 'w' || r.choice === 'both')) plans.w = r.plan;
      if (r.plan && (r.choice === 'p' || r.choice === 'both')) plans.p = r.plan;
      return { bookyway_id: r.bookyway_id, first_name: r.first_name, last_name: r.last_name, phone: r.phone, email: r.email, level: r.level || null, plans: plans };
    });
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  window.xpImport = { parseRows: parseRows, parseFile: parseFile, parseAttendance: parseAttendance, parseAttendanceFile: parseAttendanceFile, applyAttendance: applyAttendance, toPayload: toPayload, normalizePhone: normalizePhone, excelDateKey: excelDateKey, csvCell: csvCell };
})();
