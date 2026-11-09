// Every call to the server lives here. The screens in app.js never talk to Supabase directly.
(function () {
  var cfg = window.XP_CONFIG || {};
  var configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  // Same key Supabase uses by default, so members already signed in stay signed in after this update.
  var STORAGE_KEY = configured ? 'sb-' + new URL(cfg.supabaseUrl).hostname.split('.')[0] + '-auth-token' : '';
  // The login is saved on the phone and renewed in the background, so members stay signed in.
  var sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: STORAGE_KEY, storage: window.localStorage },
  }) : null;

  function loginEmail(phone) { return phone + '@phone.xptraining.app'; }
  function unwrap(res) {
    if (res.error) throw new Error(res.error.message);
    return res.data;
  }
  async function account(body) {
    var res = await fetch(cfg.supabaseUrl + '/functions/v1/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + cfg.supabaseAnonKey },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Κάτι πήγε στραβά. Δοκίμασε ξανά.');
    return data;
  }
  async function login(phone, password) {
    var res = await sb.auth.signInWithPassword({ email: loginEmail(phone), password: password });
    if (res.error) throw new Error('Το κινητό ή ο κωδικός δεν είναι σωστά');
  }
  var memberCols = 'id,first_name,last_name,phone,email,level,status,is_admin,bookyway_id,auth_user_id,invite_expires,last_visit_at,created_at,health_cert_expires,bookyway_sub_expires,weekly_limit';

  window.api = {
    configured: configured,
    hasSession: async function () { return !!(await sb.auth.getSession()).data.session; },
    hasSavedSession: function () { try { return !!localStorage.getItem(STORAGE_KEY); } catch (e) { return false; } },
    // True only when the server says the saved login is no longer valid, never for a dropped connection.
    isAuthError: function (e) { var m = (e && e.message) || ''; return /jwt|refresh token|not authenticated|invalid claim|session/i.test(m) && !/fetch|network|load failed/i.test(m); },
    login: login,
    logout: function () { return sb.auth.signOut(); },
    register: async function (d) { await account(Object.assign({ action: 'register' }, d)); await login(d.phone, d.password); },
    forgot: function (phone) { return account({ action: 'forgot', phone: phone }); },
    claim: async function (d) { await account(Object.assign({ action: 'claim' }, d)); await login(d.phone, d.password || String(d.code || '').trim().toUpperCase()); },

    me: async function () {
      var uid = (await sb.auth.getUser()).data.user.id;
      return unwrap(await sb.from('members').select(memberCols).eq('auth_user_id', uid).single());
    },
    mySubscriptions: async function (memberId) { return unwrap(await sb.from('subscriptions').select('*').eq('member_id', memberId)); },
    rules: async function () { return unwrap(await sb.from('rules').select('*')); },
    classes: async function (from, to) { return unwrap(await sb.rpc('class_list', { from_ts: from.toISOString(), to_ts: to.toISOString() })); },
    book: async function (id, repeat) { return unwrap(await sb.rpc('book_class', { p_class: id, p_repeat: !!repeat })); },
    cancel: async function (id) { return unwrap(await sb.rpc('cancel_booking', { p_class: id })); },
    joinWait: async function (id) { return unwrap(await sb.rpc('join_waitlist', { p_class: id })); },
    leaveWait: async function (id) { return unwrap(await sb.rpc('leave_waitlist', { p_class: id })); },
    recurring: async function (memberId) { return unwrap(await sb.from('recurring').select('*').eq('member_id', memberId).order('weekday')); },
    stopRecurring: async function (id) { return unwrap(await sb.from('recurring').delete().eq('id', id)); },

    // Calls back whenever something changes. The signal says only what kind of data changed, never whose.
    onChange: function (cb) {
      var channel = sb.channel('app-signal')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_signal' }, function (p) { cb(p.new.scope); })
        .subscribe();
      return function () { sb.removeChannel(channel); };
    },
    notifications: async function (memberId) { return unwrap(await sb.from('notifications').select('id,body,created_at').eq('member_id', memberId).is('read_at', null).order('created_at', { ascending: false }).limit(10)); },
    markNotesRead: async function () { return unwrap(await sb.rpc('mark_notifications_read')); },

    members: async function () { return unwrap(await sb.from('members').select(memberCols).order('last_name').limit(5000)); },
    allSubscriptions: async function () { return unwrap(await sb.from('subscriptions').select('*').limit(10000)); },
    classPeople: async function (id) {
      return {
        booked: unwrap(await sb.from('bookings').select('member_id,attended').eq('class_id', id)),
        wait: unwrap(await sb.from('waitlist').select('member_id,seq').eq('class_id', id).order('seq')),
      };
    },
    memberBookings: async function (id) { return unwrap(await sb.from('bookings').select('class_id,attended').eq('member_id', id)); },
    adminBook: async function (memberId, classId) { return unwrap(await sb.rpc('admin_book', { p_member: memberId, p_class: classId })); },
    adminRemove: async function (memberId, classId) { return unwrap(await sb.rpc('admin_remove', { p_member: memberId, p_class: classId })); },
    setAttended: async function (memberId, classId, v) { return unwrap(await sb.rpc('set_attended', { p_member: memberId, p_class: classId, p_value: v })); },
    createClass: async function (c) { return unwrap(await sb.from('classes').insert(c)); },
    deleteClass: async function (id) { return unwrap(await sb.rpc('delete_class', { p_class: id })); },
    saveRule: async function (d, field, v) { var p = {}; p[field] = v; return unwrap(await sb.from('rules').update(p).eq('discipline', d)); },
    saveSubscription: async function (m, d, kind, visits, expires) {
      return unwrap(await sb.rpc('save_subscription', { p_member: m, p_discipline: d, p_kind: kind, p_visits: visits, p_expires: expires }));
    },
    updateMember: async function (id, patch) { return unwrap(await sb.from('members').update(patch).eq('id', id)); },
    newInvite: async function (id) { return unwrap(await sb.rpc('admin_new_invite', { p_member: id })); },
    importMembers: async function (rows) { return unwrap(await sb.rpc('import_members', { p_rows: rows })); },
  };
})();
