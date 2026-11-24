/* ===== DriveEasy Rentals — Admin Control Center ===== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let currencySymbol = '$';
const money = (n) => currencySymbol + Number(n || 0).toFixed(2);
const CAR_STATUSES = { available: 'Available', maintenance: 'Maintenance', unavailable: 'Unavailable' };
const BOOKING_STATUSES = ['pending', 'confirmed', 'active', 'completed', 'cancelled'];
const MESSAGE_STATUSES = ['new', 'read', 'replied', 'archived'];
const placeholderImg = (t) => `https://placehold.co/640x400/0f4c81/ffffff?text=${encodeURIComponent(t)}`;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toastContainer').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.includes('/login')) {
    showLogin();
    throw new Error(data.error || 'Session expired');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

// ---------- Auth / Views ----------
function showLogin() { $('#loginView').hidden = false; $('#appView').hidden = true; }
function showApp() { $('#loginView').hidden = true; $('#appView').hidden = false; }

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const admin = await api('/api/admin/login', {
      method: 'POST',
      body: { username: $('#loginUser').value, password: $('#loginPass').value }
    });
    $('#adminUser').textContent = 'Signed in: ' + admin.username;
    showApp();
    refreshAll();
    toast('Welcome back, ' + admin.username);
  } catch (err) { toast(err.message, 'error'); }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
  toast('Logged out.');
});

(async () => {
  try {
    const me = await api('/api/admin/me');
    $('#adminUser').textContent = 'Signed in: ' + me.username;
    showApp();
    refreshAll();
  } catch {
    showLogin();
  }
})();

// ---------- Section Navigation ----------
$$('.admin-nav button').forEach(btn => btn.addEventListener('click', () => {
  $$('.admin-nav button').forEach(b => b.classList.toggle('active', b === btn));
  $$('.admin-section').forEach(s => { s.hidden = s.id !== 'section-' + btn.dataset.section; });
}));

$('#refreshAllBtn').addEventListener('click', () => { refreshAll(); toast('Refreshed.'); });

async function refreshAll() {
  await loadSettings();
  loadStats();
  loadCars();
  loadBookings();
  loadCustomers();
  loadMessages();
}

// ---------- Dashboard ----------
async function loadStats() {
  try {
    const s = await api('/api/admin/stats');
    $('#statCards').innerHTML = `
      <div class="stat-card"><div class="num">${s.total_cars}</div><div class="lbl">Total Cars</div></div>
      <div class="stat-card"><div class="num">${s.available_cars}</div><div class="lbl">Available Now</div></div>
      <div class="stat-card"><div class="num">${s.total_bookings}</div><div class="lbl">Total Bookings</div></div>
      <div class="stat-card accent"><div class="num">${s.pending_bookings}</div><div class="lbl">Pending Orders</div></div>
      <div class="stat-card"><div class="num">${s.active_bookings}</div><div class="lbl">Confirmed / Active</div></div>
      <div class="stat-card"><div class="num">${money(s.revenue)}</div><div class="lbl">Est. Revenue</div></div>
      <div class="stat-card"><div class="num">${s.total_customers}</div><div class="lbl">Customers</div></div>
      <div class="stat-card accent"><div class="num">${s.unread_messages}</div><div class="lbl">New Messages</div></div>`;

    const pPill = $('#pendingPill');
    pPill.textContent = s.pending_bookings;
    pPill.hidden = !s.pending_bookings;

    const mPill = $('#messagesPill');
    mPill.textContent = s.unread_messages;
    mPill.hidden = !s.unread_messages;

    $('#recentBookingsBox').innerHTML = s.recent_bookings.length
      ? s.recent_bookings.map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:.55rem 0;border-bottom:1px solid var(--border);gap:.6rem">
          <div>
            <strong>${esc(b.booking_code)}</strong> · ${esc(b.customer_name)}
            <div class="muted small">${esc(b.car_brand)} ${esc(b.car_name)} · ${esc(b.pickup_date)}</div>
          </div>
          <div style="text-align:right">
            <span class="status-badge status-${esc(b.status)}">${esc(b.status)}</span>
            <div class="small"><strong>${money(b.total_amount)}</strong></div>
          </div>
        </div>`).join('')
      : '<p class="muted small">No bookings yet.</p>';

    $('#recentMessagesBox').innerHTML = s.recent_messages.length
      ? s.recent_messages.map(m => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:.55rem 0;border-bottom:1px solid var(--border);gap:.6rem">
          <div>
            <strong>${esc(m.subject)}</strong>
            <div class="muted small">${esc(m.name)} · ${esc(m.created_at)}</div>
          </div>
          <span class="status-badge status-${esc(m.status)}">${esc(m.status)}</span>
        </div>`).join('')
      : '<p class="muted small">No messages yet.</p>';
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- Fleet / Cars ----------
async function loadCars() {
  try {
    const cars = await api('/api/admin/cars');
    const rows = cars.map(c => `
      <tr>
        <td><img src="${esc(c.image_url)}" alt=""></td>
        <td><strong>${esc(c.name)}</strong><br><span class="muted small">${esc(c.brand)} · ${c.year}</span></td>
        <td>${esc(c.category)}</td>
        <td>${money(c.daily_rate)}/day</td>
        <td>${esc(c.transmission)}<br><span class="muted small">${esc(c.fuel_type)} · ${c.seats} seats</span></td>
        <td>
          <label style="display:flex;align-items:center;gap:.35rem;cursor:pointer">
            <input type="checkbox" class="feat-toggle" data-id="${c.id}" ${c.featured ? 'checked' : ''} style="width:auto">
            <span class="small">${c.featured ? 'Yes' : 'No'}</span>
          </label>
        </td>
        <td>
          <select data-id="${c.id}" class="status-select">
            ${Object.entries(CAR_STATUSES).map(([v, l]) => `<option value="${v}" ${c.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm" data-edit="${c.id}" type="button">Edit</button>
            <button class="btn btn-danger btn-sm" data-del="${c.id}" type="button">Delete</button>
          </div>
        </td>
      </tr>`).join('');

    $('#carsTable').innerHTML = `
      <thead><tr><th>Photo</th><th>Vehicle</th><th>Category</th><th>Rate</th><th>Specs</th><th>Featured</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted" style="text-align:center;padding:2rem">No cars yet — add your first car.</td></tr>'}</tbody>`;

    $$('#carsTable .status-select').forEach(sel => sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/cars/${sel.dataset.id}/status`, { method: 'PATCH', body: { status: sel.value } });
        toast('Vehicle status updated.');
        loadStats();
      } catch (err) { toast(err.message, 'error'); loadCars(); }
    }));

    $$('#carsTable .feat-toggle').forEach(chk => chk.addEventListener('change', async () => {
      try {
        await api(`/api/admin/cars/${chk.dataset.id}/featured`, { method: 'PATCH', body: { featured: chk.checked } });
        toast(chk.checked ? 'Added to Landing Page featured fleet.' : 'Removed from featured fleet.');
        loadCars();
      } catch (err) { toast(err.message, 'error'); loadCars(); }
    }));

    $$('#carsTable [data-edit]').forEach(b => b.addEventListener('click', () => {
      openCarForm(cars.find(c => c.id === +b.dataset.edit));
    }));

    $$('#carsTable [data-del]').forEach(b => b.addEventListener('click', async () => {
      const car = cars.find(c => c.id === +b.dataset.del);
      if (!confirm(`Delete "${car.brand} ${car.name}" permanently?`)) return;
      try {
        await api('/api/admin/cars/' + car.id, { method: 'DELETE' });
        toast('Car deleted.');
        loadCars();
        loadStats();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- Car Modal ----------
const carBackdrop = $('#carModalBackdrop');
function openCarForm(car) {
  $('#carFormTitle').textContent = car ? 'Edit Car' : 'Add Car';
  $('#f_id').value = car ? car.id : '';
  $('#f_name').value = car?.name || '';
  $('#f_brand').value = car?.brand || '';
  $('#f_category').value = car?.category || 'Sedan';
  $('#f_year').value = car?.year || new Date().getFullYear();
  $('#f_rate').value = car?.daily_rate ?? '';
  $('#f_transmission').value = car?.transmission || 'Automatic';
  $('#f_fuel').value = car?.fuel_type || '';
  $('#f_seats').value = car?.seats || 5;
  $('#f_doors').value = car?.doors || 4;
  $('#f_status').value = car?.status || 'available';
  $('#f_image').value = car?.image_url || '';
  $('#f_description').value = car?.description || '';
  $('#f_features').value = car?.features || '';
  $('#f_featured').checked = !!(car?.featured);
  carBackdrop.hidden = false;
}
function closeCarForm() { carBackdrop.hidden = true; }
$('#addCarBtn').addEventListener('click', () => openCarForm(null));
$('#carModalClose').addEventListener('click', closeCarForm);
carBackdrop.addEventListener('click', e => { if (e.target === carBackdrop) closeCarForm(); });

$('#carForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#f_id').value;
  const body = {
    name: $('#f_name').value,
    brand: $('#f_brand').value,
    category: $('#f_category').value,
    year: +$('#f_year').value,
    daily_rate: +$('#f_rate').value,
    transmission: $('#f_transmission').value,
    fuel_type: $('#f_fuel').value,
    seats: +$('#f_seats').value,
    doors: +$('#f_doors').value,
    status: $('#f_status').value,
    image_url: $('#f_image').value.trim() || placeholderImg($('#f_brand').value + ' ' + $('#f_name').value),
    description: $('#f_description').value,
    features: $('#f_features').value,
    featured: $('#f_featured').checked
  };
  try {
    await api(id ? '/api/admin/cars/' + id : '/api/admin/cars', { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Car updated.' : 'Car added.');
    closeCarForm();
    loadCars();
    loadStats();
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- Bookings ----------
let bookingTimer;
async function loadBookings() {
  try {
    const p = new URLSearchParams();
    const st = $('#bookingStatusFilter').value, q = $('#bookingSearch').value.trim();
    if (st) p.set('status', st);
    if (q) p.set('q', q);
    const bookings = await api('/api/admin/bookings?' + p.toString());
    const addonLabels = { child_seat: 'Child Seat', additional_driver: 'Extra Driver', insurance: 'Insurance' };

    const rows = bookings.map(b => {
      const addons = Object.entries(JSON.parse(b.add_ons || '{}'))
        .filter(([, v]) => v)
        .map(([k]) => addonLabels[k] || k);
      return `
      <tr>
        <td><strong>${esc(b.booking_code)}</strong><br><span class="muted small">${esc(b.created_at)}</span></td>
        <td><strong>${esc(b.customer_name)}</strong><br><span class="muted small">${esc(b.customer_email)}<br>${esc(b.customer_phone)}</span></td>
        <td>${esc(b.car_brand)} ${esc(b.car_name)}<br><span class="muted small">${esc(b.pickup_location || 'Main Office')}</span></td>
        <td>${esc(b.pickup_date)} → ${esc(b.return_date)}<br><span class="muted small">${b.total_days} day(s)</span></td>
        <td>${addons.length ? esc(addons.join(', ')) : '<span class="muted">—</span>'}</td>
        <td><strong>${money(b.total_amount)}</strong></td>
        <td>
          <select data-id="${b.id}" class="booking-status">
            ${BOOKING_STATUSES.map(s => `<option value="${s}" ${b.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
          </select>
        </td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm" data-bview="${b.id}" type="button">Manage</button>
            <button class="btn btn-danger btn-sm" data-bdel="${b.id}" type="button">Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    $('#bookingsTable').innerHTML = `
      <thead><tr><th>Reference</th><th>Customer</th><th>Vehicle</th><th>Dates</th><th>Add-ons</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted" style="text-align:center;padding:2rem">No bookings found.</td></tr>'}</tbody>`;

    $$('#bookingsTable .booking-status').forEach(sel => sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/bookings/${sel.dataset.id}/status`, { method: 'PATCH', body: { status: sel.value } });
        toast('Booking updated to "' + sel.value + '".');
        loadStats();
      } catch (err) { toast(err.message, 'error'); loadBookings(); }
    }));

    $$('#bookingsTable [data-bview]').forEach(btn => btn.addEventListener('click', () => {
      const b = bookings.find(x => x.id === +btn.dataset.bview);
      openBookingModal(b);
    }));

    $$('#bookingsTable [data-bdel]').forEach(btn => btn.addEventListener('click', async () => {
      const b = bookings.find(x => x.id === +btn.dataset.bdel);
      if (!confirm(`Delete booking ${b.booking_code} permanently?`)) return;
      try {
        await api('/api/admin/bookings/' + b.id, { method: 'DELETE' });
        toast('Booking deleted.');
        loadBookings();
        loadStats();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}
$('#bookingStatusFilter').addEventListener('change', loadBookings);
$('#bookingSearch').addEventListener('input', () => { clearTimeout(bookingTimer); bookingTimer = setTimeout(loadBookings, 300); });

// ---------- Detail Modal (Bookings & Messages) ----------
const detailBackdrop = $('#detailModalBackdrop'), detailBody = $('#detailModalBody');
function closeDetailModal() { detailBackdrop.hidden = true; }
$('#detailModalClose').addEventListener('click', closeDetailModal);
detailBackdrop.addEventListener('click', e => { if (e.target === detailBackdrop) closeDetailModal(); });

function openBookingModal(b) {
  detailBody.innerHTML = `
    <h2>Booking ${esc(b.booking_code)}</h2>
    <p class="muted" style="margin-bottom:1rem">${esc(b.car_brand)} ${esc(b.car_name)} · ${esc(b.pickup_date)} → ${esc(b.return_date)} (${b.total_days} days)</p>
    <div class="price-breakdown">
      <div><span>Customer</span><span>${esc(b.customer_name)}</span></div>
      <div><span>Email / Phone</span><span>${esc(b.customer_email)} · ${esc(b.customer_phone)}</span></div>
      <div><span>License Ref</span><span>${esc(b.license_ref || '—')}</span></div>
      <div><span>Subtotal / VAT</span><span>${money(b.subtotal)} / ${money(b.vat)}</span></div>
      <div class="total"><span>Total</span><span>${money(b.total_amount)}</span></div>
    </div>
    <form id="editBookingForm">
      <div class="grid-2">
        <div class="field"><label>Status</label>
          <select id="eb_status">${BOOKING_STATUSES.map(s => `<option value="${s}" ${b.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Pickup Branch</label><input id="eb_loc" value="${esc(b.pickup_location || 'Main Office')}"></div>
      </div>
      <div class="field"><label>Notes</label><textarea id="eb_notes" rows="3">${esc(b.notes || '')}</textarea></div>
      <button class="btn btn-accent btn-block" type="submit">Save Booking Changes</button>
    </form>`;
  detailBackdrop.hidden = false;

  $('#editBookingForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/admin/bookings/' + b.id, {
        method: 'PUT',
        body: { status: $('#eb_status').value, pickup_location: $('#eb_loc').value, notes: $('#eb_notes').value }
      });
      toast('Booking updated.');
      closeDetailModal();
      loadBookings();
      loadStats();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- Customers ----------
let custTimer;
async function loadCustomers() {
  try {
    const q = $('#customerSearch').value.trim();
    const list = await api('/api/admin/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const rows = list.map(c => `
      <tr>
        <td><strong>${esc(c.full_name)}</strong><br><span class="muted small">Joined ${esc(c.created_at)}</span></td>
        <td>${esc(c.email)}<br><span class="muted small">${esc(c.phone)}</span></td>
        <td>${esc(c.license_ref || '—')}<br><span class="muted small">${esc(c.address || '')}</span></td>
        <td><strong>${c.bookings_count}</strong></td>
        <td>
          <select data-cid="${c.id}" class="cust-status">
            <option value="active" ${c.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="suspended" ${c.status === 'suspended' ? 'selected' : ''}>Suspended</option>
          </select>
        </td>
        <td>
          <button class="btn btn-danger btn-sm" data-cdel="${c.id}" type="button">Delete</button>
        </td>
      </tr>`).join('');

    $('#customersTable').innerHTML = `
      <thead><tr><th>Customer</th><th>Contact</th><th>License &amp; Address</th><th>Bookings</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted" style="text-align:center;padding:2rem">No customers found.</td></tr>'}</tbody>`;

    $$('#customersTable .cust-status').forEach(sel => sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/customers/${sel.dataset.cid}/status`, { method: 'PATCH', body: { status: sel.value } });
        toast('Customer status updated.');
      } catch (err) { toast(err.message, 'error'); loadCustomers(); }
    }));

    $$('#customersTable [data-cdel]').forEach(btn => btn.addEventListener('click', async () => {
      const cust = list.find(x => x.id === +btn.dataset.cdel);
      if (!confirm(`Delete customer "${cust.full_name}"? Their historical bookings will be kept without account link.`)) return;
      try {
        await api('/api/admin/customers/' + cust.id, { method: 'DELETE' });
        toast('Customer deleted.');
        loadCustomers();
        loadStats();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}
$('#customerSearch').addEventListener('input', () => { clearTimeout(custTimer); custTimer = setTimeout(loadCustomers, 300); });

// ---------- Contact Messages ----------
async function loadMessages() {
  try {
    const st = $('#messageStatusFilter').value;
    const msgs = await api('/api/admin/messages' + (st ? '?status=' + encodeURIComponent(st) : ''));
    const rows = msgs.map(m => `
      <tr>
        <td><strong>${esc(m.name)}</strong><br><span class="muted small">${esc(m.email)}<br>${esc(m.phone || '')}</span></td>
        <td><strong>${esc(m.subject)}</strong><br><span class="muted small">${esc(m.message.slice(0, 90))}${m.message.length > 90 ? '…' : ''}</span></td>
        <td><span class="muted small">${esc(m.created_at)}</span></td>
        <td>
          <select data-mid="${m.id}" class="msg-status">
            ${MESSAGE_STATUSES.map(s => `<option value="${s}" ${m.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
          </select>
        </td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm" data-mview="${m.id}" type="button">View / Note</button>
            <button class="btn btn-danger btn-sm" data-mdel="${m.id}" type="button">Delete</button>
          </div>
        </td>
      </tr>`).join('');

    $('#messagesTable').innerHTML = `
      <thead><tr><th>Sender</th><th>Subject &amp; Message</th><th>Received</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted" style="text-align:center;padding:2rem">No messages found.</td></tr>'}</tbody>`;

    $$('#messagesTable .msg-status').forEach(sel => sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/messages/${sel.dataset.mid}`, { method: 'PATCH', body: { status: sel.value } });
        toast('Message status updated.');
        loadStats();
      } catch (err) { toast(err.message, 'error'); loadMessages(); }
    }));

    $$('#messagesTable [data-mview]').forEach(btn => btn.addEventListener('click', () => {
      openMessageModal(msgs.find(x => x.id === +btn.dataset.mview));
    }));

    $$('#messagesTable [data-mdel]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this message?')) return;
      try {
        await api('/api/admin/messages/' + btn.dataset.mdel, { method: 'DELETE' });
        toast('Message deleted.');
        loadMessages();
        loadStats();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}
$('#messageStatusFilter').addEventListener('change', loadMessages);

function openMessageModal(m) {
  detailBody.innerHTML = `
    <h2>${esc(m.subject)}</h2>
    <p class="muted" style="margin-bottom:.8rem">From <strong>${esc(m.name)}</strong> (${esc(m.email)} ${m.phone ? '· ' + esc(m.phone) : ''}) on ${esc(m.created_at)}</p>
    <div class="price-breakdown" style="white-space:pre-wrap">${esc(m.message)}</div>
    <form id="editMsgForm">
      <div class="field"><label>Status</label>
        <select id="em_status">${MESSAGE_STATUSES.map(s => `<option value="${s}" ${m.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Admin Notes</label><textarea id="em_notes" rows="3" placeholder="Internal notes or summary of reply…">${esc(m.admin_notes || '')}</textarea></div>
      <button class="btn btn-accent btn-block" type="submit">Save Message Update</button>
    </form>`;
  detailBackdrop.hidden = false;

  $('#editMsgForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/admin/messages/' + m.id, {
        method: 'PATCH',
        body: { status: $('#em_status').value, admin_notes: $('#em_notes').value }
      });
      toast('Message updated.');
      closeDetailModal();
      loadMessages();
      loadStats();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- Site Settings (Control Everything) ----------
const SETTING_KEYS = [
  'site_name', 'site_accent', 'tagline', 'hero_title', 'hero_subtitle', 'footer_note',
  'about_headline', 'about_story', 'about_mission', 'stat_years', 'stat_clients', 'stat_rating',
  'contact_phone', 'contact_email', 'contact_address', 'contact_hours', 'pickup_locations',
  'currency_symbol', 'vat_rate', 'addon_child_seat', 'addon_additional_driver', 'addon_insurance', 'min_driver_age'
];

async function loadSettings() {
  try {
    const s = await api('/api/admin/settings');
    currencySymbol = s.currency_symbol || '$';
    for (const k of SETTING_KEYS) {
      const el = $('#s_' + k);
      if (el && s[k] !== undefined) el.value = s[k];
    }
  } catch (err) { toast(err.message, 'error'); }
}

$('#saveSettingsBtn').addEventListener('click', async () => {
  const payload = {};
  for (const k of SETTING_KEYS) {
    const el = $('#s_' + k);
    if (el) payload[k] = el.value;
  }
  try {
    const saved = await api('/api/admin/settings', { method: 'PUT', body: payload });
    currencySymbol = saved.currency_symbol || '$';
    toast('All website settings saved and live!');
    loadStats();
    loadCars();
    loadBookings();
  } catch (err) { toast(err.message, 'error'); }
});

$('#adminPassForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/admin/change-password', {
      method: 'POST',
      body: { current_password: $('#ap_current').value, new_password: $('#ap_new').value }
    });
    $('#ap_current').value = '';
    $('#ap_new').value = '';
    toast('Admin password updated.');
  } catch (err) { toast(err.message, 'error'); }
});
