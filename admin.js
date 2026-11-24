/* ===== DriveEasy Rentals — Admin Control Center ===== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let currencySymbol = 'N$';
let vatRate = 15;
let AUTH = { name: 'admin', username: 'admin', role: 'admin', permissions: ['*'] };
const can = (perm) => AUTH.permissions.includes('*') || AUTH.permissions.includes(perm);
function applyRoleUI() {
  const staffNav = $('.admin-nav [data-section="staff"]');
  if (staffNav) staffNav.hidden = !can('staff:manage');
  const addCar = $('#addCarBtn');
  if (addCar) addCar.hidden = !can('cars:write');
  const saveSettings = $('#saveSettingsBtn');
  if (saveSettings) saveSettings.hidden = !can('settings:write');
}
let carsCache = [];
let quotesCache = [];
let invoicesCache = [];
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
    AUTH = { name: admin.name || admin.username, username: admin.username, role: admin.role || 'admin', permissions: admin.permissions || [] };
    applyRoleUI();
    $('#adminUser').textContent = `Signed in: ${AUTH.name} (${AUTH.role})`;
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
    AUTH = { name: me.name || me.username, username: me.username, role: me.role || 'admin', permissions: me.permissions || [] };
    applyRoleUI();
    $('#adminUser').textContent = `Signed in: ${AUTH.name} (${AUTH.role})`;
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
  loadAnalytics();
  loadCars();
  loadBookings();
  loadQuotes();
  loadInvoices();
  loadStaff();
  loadCustomers();
  loadMessages();
  loadReviews();
}

// ---------- Dashboard & Analytics Charts ----------
const chartState = { mode: 'monthly', carMetric: 'revenue', year: new Date().getFullYear(), compareYear: new Date().getFullYear() - 1, data: null };

async function loadAnalytics() {
  try {
    const q = new URLSearchParams({ year: chartState.year, compareYear: chartState.compareYear });
    const data = await api('/api/admin/analytics?' + q.toString());
    chartState.data = data;

    const ySel = $('#chartYearSelect');
    const cSel = $('#chartCompareYearSelect');
    if (ySel && cSel) {
      ySel.innerHTML = data.availableYears.map(y => `<option value="${y}" ${y === data.year ? 'selected' : ''}>${y}</option>`).join('');
      cSel.innerHTML = `<option value="0">No compare</option>` + data.availableYears.map(y => `<option value="${y}" ${y === data.compareYear ? 'selected' : ''}>vs ${y}</option>`).join('');
      cSel.hidden = chartState.mode === 'yearly';
      ySel.hidden = chartState.mode === 'yearly';
    }

    renderSalesChart();
    renderCarCompareChart();
    renderCategoryChart();
    renderStatusChart();
  } catch (err) { toast(err.message, 'error'); }
}

function renderSalesChart() {
  const data = chartState.data;
  if (!data) return;
  const wrap = $('#salesChartWrap');
  const legend = $('#salesChartLegend');
  const title = $('#salesChartTitle');

  if (chartState.mode === 'yearly') {
    title.textContent = 'Sales Comparison by Year';
    const items = data.yearly || [];
    if (!items.length) { wrap.innerHTML = '<p class="muted small">No completed sales yet.</p>'; legend.innerHTML = ''; return; }
    legend.innerHTML = `<span class="legend-item"><span class="legend-dot" style="background:var(--primary)"></span>Annual Revenue</span>`;
    const W = 560, H = 220, padL = 54, padB = 30, padT = 18, padR = 16;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxVal = Math.max(100, ...items.map(i => i.revenue));
    const step = plotW / items.length;
    const barW = Math.min(54, step * 0.55);

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const y = padT + plotH * (1 - f);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="3,3"/>
              <text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#5d6b7a">${esc(money(maxVal * f).replace(/\.00$/, ''))}</text>`;
    }).join('');

    const bars = items.map((item, idx) => {
      const h = (item.revenue / maxVal) * plotH;
      const x = padL + idx * step + (step - barW) / 2;
      const y = padT + plotH - h;
      return `<g>
        <rect x="${x}" y="${y}" width="${barW}" height="${Math.max(2, h)}" rx="5" fill="#0f4c81">
          <title>${item.year}: ${money(item.revenue)} (${item.bookings} bookings)</title>
        </rect>
        <text x="${x + barW / 2}" y="${Math.max(12, y - 5)}" text-anchor="middle" font-size="10" font-weight="700" fill="#0f4c81">${esc(money(item.revenue).replace(/\.00$/, ''))}</text>
        <text x="${x + barW / 2}" y="${H - 8}" text-anchor="middle" font-size="11" font-weight="700" fill="#17202a">${item.year} (${item.bookings})</text>
      </g>`;
    }).join('');

    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;min-width:340px">${gridLines}${bars}</svg>`;
    return;
  }

  title.textContent = 'Sales Comparison by Month';
  const compareOn = Number($('#chartCompareYearSelect')?.value || chartState.compareYear) > 0;
  legend.innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#0f4c81"></span>${data.year} Revenue</span>
    ${compareOn ? `<span class="legend-item"><span class="legend-dot" style="background:#f59e0b"></span>${data.compareYear} Revenue</span>` : ''}`;

  const items = data.monthly || [];
  const W = 620, H = 230, padL = 54, padB = 28, padT = 16, padR = 12;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(100, ...items.flatMap(m => [m.revenue, compareOn ? m.compare_revenue : 0]));
  const groupW = plotW / items.length;
  const barW = compareOn ? Math.max(8, groupW * 0.34) : Math.max(12, groupW * 0.56);

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const y = padT + plotH * (1 - f);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="3,3"/>
            <text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#5d6b7a">${esc(money(maxVal * f).replace(/\.00$/, ''))}</text>`;
  }).join('');

  const bars = items.map((m, idx) => {
    const gx = padL + idx * groupW + groupW / 2;
    const h1 = (m.revenue / maxVal) * plotH;
    const y1 = padT + plotH - h1;
    let svg = '';
    if (compareOn) {
      const h2 = (m.compare_revenue / maxVal) * plotH;
      const y2 = padT + plotH - h2;
      svg += `<rect x="${gx - barW - 1}" y="${y1}" width="${barW}" height="${Math.max(1, h1)}" rx="3" fill="#0f4c81">
        <title>${m.month} ${data.year}: ${money(m.revenue)} (${m.bookings} bookings)</title></rect>`;
      svg += `<rect x="${gx + 1}" y="${y2}" width="${barW}" height="${Math.max(1, h2)}" rx="3" fill="#f59e0b">
        <title>${m.month} ${data.compareYear}: ${money(m.compare_revenue)} (${m.compare_bookings} bookings)</title></rect>`;
    } else {
      svg += `<rect x="${gx - barW / 2}" y="${y1}" width="${barW}" height="${Math.max(1, h1)}" rx="4" fill="#0f4c81">
        <title>${m.month} ${data.year}: ${money(m.revenue)} (${m.bookings} bookings)</title></rect>`;
    }
    svg += `<text x="${gx}" y="${H - 8}" text-anchor="middle" font-size="10" font-weight="600" fill="#5d6b7a">${m.month}</text>`;
    return svg;
  }).join('');

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;min-width:420px">${gridLines}${bars}</svg>`;
}

function renderCarCompareChart() {
  const data = chartState.data;
  if (!data) return;
  const metric = chartState.carMetric;
  const list = [...(data.byCar || [])].sort((a, b) => {
    if (metric === 'bookings') return b.bookings - a.bookings || b.revenue - a.revenue;
    if (metric === 'rating') return b.avg_rating - a.avg_rating || b.review_count - a.review_count;
    return b.revenue - a.revenue;
  }).slice(0, 8);

  const maxVal = metric === 'rating'
    ? 5
    : Math.max(1, ...list.map(c => metric === 'bookings' ? c.bookings : c.revenue));

  $('#carCompareChart').innerHTML = list.length ? list.map(c => {
    const val = metric === 'bookings' ? c.bookings : (metric === 'rating' ? c.avg_rating : c.revenue);
    const pct = Math.min(100, Math.round((val / maxVal) * 100));
    const display = metric === 'bookings'
      ? `${c.bookings} trip${c.bookings === 1 ? '' : 's'}`
      : (metric === 'rating' ? (c.review_count ? `★ ${c.avg_rating} (${c.review_count})` : 'No reviews') : money(c.revenue));
    return `
      <div class="hbar-row">
        <div class="hbar-label" title="${esc(c.label)}">${esc(c.label)}</div>
        <div class="hbar-track"><div class="hbar-fill ${metric === 'rating' ? 'accent' : ''}" style="width:${pct}%"></div></div>
        <div class="hbar-val">${esc(display)}</div>
      </div>`;
  }).join('') : '<p class="muted small">No car data available.</p>';
}

function renderDonut(container, segments, centerLabel, valueFormatter) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) {
    container.innerHTML = '<p class="muted small">No data recorded yet.</p>';
    return;
  }
  const R = 48, C = 2 * Math.PI * R;
  let offset = 0;
  const circles = segments.filter(s => s.value > 0).map(s => {
    const len = (s.value / total) * C;
    const circle = `<circle cx="64" cy="64" r="${R}" fill="none" stroke="${s.color}" stroke-width="18"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}">
      <title>${esc(s.label)}: ${esc(valueFormatter(s.value))}</title></circle>`;
    offset += len;
    return circle;
  }).join('');

  container.innerHTML = `
    <svg width="128" height="128" viewBox="0 0 128 128" style="flex-shrink:0;transform:rotate(-90deg)">
      <circle cx="64" cy="64" r="${R}" fill="none" stroke="#e8eef5" stroke-width="18"/>
      ${circles}
      <text x="64" y="68" text-anchor="middle" font-size="13" font-weight="800" fill="#17202a" transform="rotate(90 64 64)">${esc(centerLabel)}</text>
    </svg>
    <div class="donut-legend">
      ${segments.map(s => `
        <div class="donut-legend-row">
          <span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${esc(s.label)}</span>
          <strong>${esc(valueFormatter(s.value))}</strong>
        </div>`).join('')}
    </div>`;
}

function renderCategoryChart() {
  const data = chartState.data;
  if (!data) return;
  const palette = ['#0f4c81', '#f59e0b', '#16a34a', '#2563eb', '#7c3aed'];
  const segs = (data.byCategory || []).map((c, i) => ({
    label: `${c.category} (${c.bookings})`,
    value: c.revenue,
    color: palette[i % palette.length]
  }));
  const totalRev = segs.reduce((s, x) => s + x.value, 0);
  renderDonut($('#categoryChart'), segs, money(totalRev).replace(/\.00$/, ''), v => money(v));
}

function renderStatusChart() {
  const data = chartState.data;
  if (!data) return;
  const colors = { pending: '#f59e0b', confirmed: '#2563eb', active: '#7c3aed', completed: '#16a34a', cancelled: '#dc2626' };
  const segs = (data.byStatus || []).map(s => ({
    label: s.status[0].toUpperCase() + s.status.slice(1),
    value: s.count,
    color: colors[s.status] || '#64748b'
  }));
  const totalCount = segs.reduce((s, x) => s + x.value, 0);
  renderDonut($('#statusChart'), segs, String(totalCount) + ' total', v => `${v} booking${v === 1 ? '' : 's'}`);
}

$$('#salesModeTabs button').forEach(btn => btn.addEventListener('click', () => {
  chartState.mode = btn.dataset.mode;
  $$('#salesModeTabs button').forEach(b => b.classList.toggle('active', b === btn));
  const hideYears = chartState.mode === 'yearly';
  $('#chartYearSelect').hidden = hideYears;
  $('#chartCompareYearSelect').hidden = hideYears;
  renderSalesChart();
}));
$$('#carMetricTabs button').forEach(btn => btn.addEventListener('click', () => {
  chartState.carMetric = btn.dataset.metric;
  $$('#carMetricTabs button').forEach(b => b.classList.toggle('active', b === btn));
  renderCarCompareChart();
}));
$('#chartYearSelect').addEventListener('change', e => { chartState.year = +e.target.value; loadAnalytics(); });
$('#chartCompareYearSelect').addEventListener('change', e => { chartState.compareYear = +e.target.value; loadAnalytics(); });

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
      <div class="stat-card accent"><div class="num">${s.unread_messages}</div><div class="lbl">New Messages</div></div>
<div class="stat-card"><div class="num">${s.open_quotes}</div><div class="lbl">Open Quotes</div></div>
<div class="stat-card"><div class="num">${s.unpaid_invoices}</div><div class="lbl">Unpaid Invoices</div></div>`;

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
    carsCache = cars;
    const editable = can('cars:write');
    const rows = cars.map(c => {
      const badge = c.status === 'available' ? 'confirmed' : (c.status === 'maintenance' ? 'pending' : 'cancelled');
      const statusCell = editable
        ? `<select data-id="${c.id}" class="status-select">
            ${Object.entries(CAR_STATUSES).map(([v, l]) => `<option value="${v}" ${c.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>`
        : `<span class="status-badge status-${badge}">${esc(CAR_STATUSES[c.status] || c.status)}</span>`;
      const featuredCell = editable
        ? `<label style="display:flex;align-items:center;gap:.35rem;cursor:pointer">
            <input type="checkbox" class="feat-toggle" data-id="${c.id}" ${c.featured ? 'checked' : ''} style="width:auto">
            <span class="small">${c.featured ? 'Yes' : 'No'}</span>
          </label>`
        : `<span class="small">${c.featured ? 'Yes' : 'No'}</span>`;
      const actionsCell = editable
        ? `<td><div class="table-actions">
            <button class="btn btn-sm" data-edit="${c.id}" type="button">Edit</button>
            <button class="btn btn-danger btn-sm" data-del="${c.id}" type="button">Delete</button>
          </div></td>`
        : '';
      return `
      <tr>
        <td><img src="${esc(c.image_url)}" alt=""></td>
        <td><strong>${esc(c.name)}</strong><br><span class="muted small">${esc(c.brand)} · ${c.year}</span></td>
        <td>${esc(c.category)}</td>
        <td>${money(c.daily_rate)}/day</td>
        <td>${esc(c.transmission)}<br><span class="muted small">${esc(c.fuel_type)} · ${c.seats} seats</span></td>
        <td>${featuredCell}</td>
        <td>${statusCell}</td>
        ${actionsCell}
      </tr>`;
    }).join('');

    $('#carsTable').innerHTML = `
      <thead><tr><th>Photo</th><th>Vehicle</th><th>Category</th><th>Rate</th><th>Specs</th><th>Featured</th><th>Status</th>${editable ? '<th>Actions</th>' : ''}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${editable ? 8 : 7}" class="muted" style="text-align:center;padding:2rem">No cars yet.</td></tr>`}</tbody>`;

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
      const invoiceCell = b.invoice_id
        ? `<button class="btn btn-sm" data-view-inv="${b.invoice_id}" type="button">${esc(b.invoice_no)}</button>
           <br><span class="status-badge status-${b.invoice_status === 'paid' ? 'confirmed' : 'pending'}">${esc(b.invoice_status)}</span>`
        : '<span class="muted">—</span>';
      const statusCell = b.status === 'pending'
        ? `<span class="status-badge status-pending">pending</span>
           <br><button class="btn btn-accent btn-sm" data-pos="${b.id}" type="button" style="margin-top:.35rem">Approve / POS</button>`
        : `<select data-id="${b.id}" class="booking-status">
            ${BOOKING_STATUSES.map(s => `<option value="${s}" ${b.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
          </select>`;
      return `
      <tr>
        <td><strong>${esc(b.booking_code)}</strong><br><span class="muted small">${esc(b.created_at)}</span></td>
        <td><strong>${esc(b.customer_name)}</strong><br><span class="muted small">${esc(b.customer_email)}<br>${esc(b.customer_phone)}</span></td>
        <td>${esc(b.car_brand)} ${esc(b.car_name)}<br><span class="muted small">${esc(b.pickup_location || 'Main Office')}</span></td>
        <td>${esc(b.pickup_date)} → ${esc(b.return_date)}<br><span class="muted small">${b.total_days} day(s)</span></td>
        <td>${addons.length ? esc(addons.join(', ')) : '<span class="muted">—</span>'}</td>
        <td><strong>${money(b.total_amount)}</strong></td>
        <td>${invoiceCell}</td>
        <td>${statusCell}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm" data-bview="${b.id}" type="button">Manage</button>
            <button class="btn btn-danger btn-sm" data-bdel="${b.id}" type="button">Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    $('#bookingsTable').innerHTML = `
      <thead><tr><th>Reference</th><th>Customer</th><th>Vehicle</th><th>Dates</th><th>Add-ons</th><th>Total</th><th>Invoice</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="muted" style="text-align:center;padding:2rem">No bookings found.</td></tr>'}</tbody>`;

    $$('#bookingsTable .booking-status').forEach(sel => sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/bookings/${sel.dataset.id}/status`, { method: 'PATCH', body: { status: sel.value } });
        toast('Booking updated to "' + sel.value + '".');
        loadStats();
      } catch (err) { toast(err.message, 'error'); loadBookings(); }
    }));

    $$('#bookingsTable [data-pos]').forEach(btn => btn.addEventListener('click', () => {
      const b = bookings.find(x => x.id === +btn.dataset.pos);
      if (b) openPos(b);
    }));

    $$('#bookingsTable [data-view-inv]').forEach(btn => btn.addEventListener('click', () => {
      openDoc('invoice', +btn.dataset.viewInv);
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
    currencySymbol = s.currency_symbol || 'N$';
    vatRate = Number(s.vat_rate) || 15;
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
    currencySymbol = saved.currency_symbol || 'N$';
    vatRate = Number(saved.vat_rate) || 15;
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

// ---------- Client Reviews Management ----------
async function loadReviews() {
  const table = $('#reviewsTable');
  if (!table) return;
  try {
    const reviews = await api('/api/admin/reviews');
    const rows = reviews.map(r => `
      <tr>
        <td><strong>${esc(r.car_brand)} ${esc(r.car_name)}</strong></td>
        <td><strong>${esc(r.reviewer_name)}</strong><br><span class="muted small">${esc(r.created_at)}</span></td>
        <td><span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span> (${r.rating}/5)</td>
        <td><strong>${esc(r.title || '—')}</strong><br><span class="muted small">${esc(r.comment)}</span></td>
        <td>
          <select data-rid="${r.id}" class="rev-status">
            <option value="published" ${r.status === 'published' ? 'selected' : ''}>Published</option>
            <option value="hidden" ${r.status === 'hidden' ? 'selected' : ''}>Hidden</option>
          </select>
        </td>
        <td>
          <button class="btn btn-danger btn-sm" data-rdel="${r.id}" type="button">Delete</button>
        </td>
      </tr>`).join('');

    table.innerHTML = `
      <thead><tr><th>Vehicle</th><th>Client</th><th>Rating</th><th>Review</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted" style="text-align:center;padding:2rem">No client reviews yet.</td></tr>'}</tbody>`;

    $$('#reviewsTable .rev-status').forEach(sel => sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/reviews/${sel.dataset.rid}`, { method: 'PATCH', body: { status: sel.value } });
        toast('Review status updated.');
        loadAnalytics();
      } catch (err) { toast(err.message, 'error'); loadReviews(); }
    }));

    $$('#reviewsTable [data-rdel]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this review permanently?')) return;
      try {
        await api('/api/admin/reviews/' + btn.dataset.rdel, { method: 'DELETE' });
        toast('Review deleted.');
        loadReviews();
        loadAnalytics();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- Quotations ----------
async function loadQuotes() {
  const table = $('#quotesTable');
  if (!table) return;
  try {
    const quotes = await api('/api/admin/quotes');
    quotesCache = quotes;
    const rows = quotes.map(q => {
      const actions = [`<button class="btn btn-sm" data-qview="${q.id}" type="button">View</button>`];
      if (q.status === 'open') actions.push(`<button class="btn btn-sm" data-qconvert="${q.id}" type="button">Convert</button>`);
      actions.push(`<button class="btn btn-danger btn-sm" data-qdel="${q.id}" type="button">Delete</button>`);
      const badge = q.status === 'open' ? 'pending' : (q.status === 'converted' ? 'confirmed' : 'cancelled');
      return `
        <tr>
          <td><strong>${esc(q.quote_no)}</strong><br><span class="muted small">${esc(q.created_at)}</span></td>
          <td><strong>${esc(q.customer_name)}</strong><br><span class="muted small">${esc(q.customer_email)}</span></td>
          <td>${esc(q.car_brand)} ${esc(q.car_name)}</td>
          <td>${esc(q.pickup_date)} → ${esc(q.return_date)}<br><span class="muted small">${q.total_days} day(s)</span></td>
          <td><strong>${money(q.total_amount)}</strong></td>
          <td>${esc(q.valid_until)}</td>
          <td><span class="status-badge status-${badge}">${esc(q.status)}</span></td>
          <td><div class="table-actions">${actions.join('')}</div></td>
        </tr>`;
    }).join('');
    table.innerHTML = `
      <thead><tr><th>Quote</th><th>Customer</th><th>Vehicle</th><th>Dates</th><th>Total</th><th>Valid until</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted" style="text-align:center;padding:2rem">No quotations yet.</td></tr>'}</tbody>`;

    $$('#quotesTable [data-qview]').forEach(b => b.addEventListener('click', () => openDoc('quote', +b.dataset.qview)));
    $$('#quotesTable [data-qconvert]').forEach(b => b.addEventListener('click', () => convertQuote(+b.dataset.qconvert)));
    $$('#quotesTable [data-qdel]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this quotation?')) return;
      try {
        await api('/api/admin/quotes/' + b.dataset.qdel, { method: 'DELETE' });
        toast('Quotation deleted.');
        loadQuotes();
        loadStats();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}

async function convertQuote(id) {
  try {
    const out = await api(`/api/admin/quotes/${id}/convert`, { method: 'POST' });
    toast('Converted to booking ' + out.booking.booking_code + '.');
    closeDoc();
    loadQuotes();
    loadBookings();
    loadStats();
  } catch (err) { toast(err.message, 'error'); }
}

const quoteBackdrop = $('#quoteModalBackdrop');
async function openQuoteForm() {
  try {
    if (!carsCache.length) carsCache = await api('/api/admin/cars');
    $('#quoteForm').reset();
    $('#q_car').innerHTML = carsCache.map(c =>
      `<option value="${c.id}">${esc(c.brand)} ${esc(c.name)} — ${money(c.daily_rate)}/day (${esc(c.status)})</option>`
    ).join('') || '<option value="">No vehicles available</option>';
    updateQuotePreview();
    quoteBackdrop.hidden = false;
  } catch (err) { toast(err.message, 'error'); }
}
function closeQuoteForm() { quoteBackdrop.hidden = true; }
$('#addQuoteBtn').addEventListener('click', openQuoteForm);
$('#quoteModalClose').addEventListener('click', closeQuoteForm);
quoteBackdrop.addEventListener('click', e => { if (e.target === quoteBackdrop) closeQuoteForm(); });

function updateQuotePreview() {
  const box = $('#quotePreview');
  if (!box) return;
  const car = carsCache.find(c => c.id === +$('#q_car').value);
  const p = $('#q_pickup').value, r = $('#q_return').value;
  if (!car || !p || !r || r <= p) {
    box.innerHTML = '<span class="muted small">Select a vehicle and valid dates to preview the total.</span>';
    return;
  }
  const days = Math.max(1, Math.ceil((new Date(r) - new Date(p)) / 86400000));
  let addonPerDay = 0;
  if ($('#q_child_seat').checked) addonPerDay += 5;
  if ($('#q_additional_driver').checked) addonPerDay += 8;
  if ($('#q_insurance').checked) addonPerDay += 12;
  const total = (car.daily_rate + addonPerDay) * days;
  const subtotal = total / (1 + vatRate / 100);
  const vat = total - subtotal;
  box.innerHTML = `
    <div><span>${days} day(s) base + add-ons</span><span>${money(total)}</span></div>
    <div><span>Subtotal (excl. VAT)</span><span>${money(subtotal)}</span></div>
    <div><span>VAT (${vatRate}%, included)</span><span>${money(vat)}</span></div>
    <div class="total"><span>Total (incl. VAT)</span><span>${money(total)}</span></div>`;
}
['q_car', 'q_pickup', 'q_return', 'q_child_seat', 'q_additional_driver', 'q_insurance'].forEach(id => {
  const el = $('#' + id);
  if (el) { el.addEventListener('input', updateQuotePreview); el.addEventListener('change', updateQuotePreview); }
});

$('#quoteForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const q = await api('/api/admin/quotes', {
      method: 'POST',
      body: {
        customer_name: $('#q_name').value,
        customer_email: $('#q_email').value,
        customer_phone: $('#q_phone').value,
        car_id: +$('#q_car').value,
        pickup_date: $('#q_pickup').value,
        return_date: $('#q_return').value,
        notes: $('#q_notes').value,
        add_ons: {
          child_seat: $('#q_child_seat').checked,
          additional_driver: $('#q_additional_driver').checked,
          insurance: $('#q_insurance').checked
        }
      }
    });
    toast('Quotation ' + q.quote_no + ' created.');
    closeQuoteForm();
    await loadQuotes();
    loadStats();
    openDoc('quote', q.id);
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- Tax invoices ----------
async function loadInvoices() {
  const table = $('#invoicesTable');
  if (!table) return;
  try {
    const invoices = await api('/api/admin/invoices');
    invoicesCache = invoices;
    const rows = invoices.map(i => {
      const actions = [`<button class="btn btn-sm" data-iview="${i.id}" type="button">Print</button>`];
      if (i.status !== 'paid') actions.push(`<button class="btn btn-accent btn-sm" data-ipay="${i.id}" type="button">Mark Paid</button>`);
      actions.push(`<button class="btn btn-danger btn-sm" data-idel="${i.id}" type="button">Delete</button>`);
      return `
        <tr>
          <td><strong>${esc(i.invoice_no)}</strong><br><span class="muted small">${esc(i.booking_code)}</span></td>
          <td><strong>${esc(i.customer_name)}</strong><br><span class="muted small">${esc(i.customer_email)}</span></td>
          <td><strong>${money(i.total_amount)}</strong></td>
          <td>${esc(i.due_date)}</td>
          <td><span class="status-badge status-${i.status === 'paid' ? 'confirmed' : 'pending'}">${esc(i.status)}</span></td>
          <td>${i.payment_method ? esc(i.payment_method) + (i.payment_reference ? ' · ' + esc(i.payment_reference) : '') : '<span class="muted">—</span>'}</td>
          <td><div class="table-actions">${actions.join('')}</div></td>
        </tr>`;
    }).join('');
    table.innerHTML = `
      <thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Due</th><th>Status</th><th>Payment</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted" style="text-align:center;padding:2rem">No invoices yet.</td></tr>'}</tbody>`;

    $$('#invoicesTable [data-iview]').forEach(b => b.addEventListener('click', () => openDoc('invoice', +b.dataset.iview)));
    $$('#invoicesTable [data-ipay]').forEach(b => b.addEventListener('click', () => payInvoice(+b.dataset.ipay)));
    $$('#invoicesTable [data-idel]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this invoice?')) return;
      try {
        await api('/api/admin/invoices/' + b.dataset.idel, { method: 'DELETE' });
        toast('Invoice deleted.');
        loadInvoices();
        loadBookings();
        loadStats();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}

async function payInvoice(id) {
  const method = prompt('Payment method (Cash, Card, Bank transfer, Mobile money):', 'Bank transfer');
  if (!method) return;
  const reference = prompt('Payment reference (optional):', '') || '';
  try {
    await api(`/api/admin/invoices/${id}/pay`, {
      method: 'PATCH',
      body: { payment_method: method.trim(), payment_reference: reference.trim() }
    });
    toast('Invoice marked as paid.');
    await loadInvoices();
    loadBookings();
    loadStats();
    if (!docBackdrop.hidden) openDoc('invoice', id);
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- Printable quotation / invoice ----------
const docBackdrop = $('#docModalBackdrop');
function closeDoc() {
  docBackdrop.hidden = true;
  docBackdrop.classList.remove('printable');
}
$('#docCloseBtn').addEventListener('click', closeDoc);
$('#docPrintBtn').addEventListener('click', () => window.print());
docBackdrop.addEventListener('click', e => { if (e.target === docBackdrop) closeDoc(); });

function renderDoc(kind, item) {
  const isInvoice = kind === 'invoice';
  const no = isInvoice ? item.invoice_no : item.quote_no;
  const carLabel = isInvoice ? item.car_label : `${item.car_brand || ''} ${item.car_name || ''}`.trim();
  const labels = { child_seat: 'Child Seat', additional_driver: 'Extra Driver', insurance: 'Full Insurance' };
  const addonText = isInvoice ? '' : Object.entries(item.add_ons || {})
    .filter(([, v]) => v).map(([k]) => labels[k] || k).join(', ');
  const meta = isInvoice
    ? `<p>Issued: ${esc(String(item.created_at).slice(0, 10))}</p>
       <p>Due: ${esc(item.due_date)}</p>
       ${item.paid_at ? `<p>Paid: ${esc(String(item.paid_at).slice(0, 10))} · ${esc(item.payment_method || '')}${item.payment_reference ? ' · ' + esc(item.payment_reference) : ''}</p>` : ''}`
    : `<p>Issued: ${esc(String(item.created_at).slice(0, 10))}</p>
       <p>Valid until: ${esc(item.valid_until)}</p>`;
  const badge = isInvoice
    ? (item.status === 'paid' ? 'confirmed' : 'pending')
    : (item.status === 'open' ? 'pending' : 'confirmed');
  return `
  <div class="doc">
    <div class="doc-head">
      <div>
        <h2>Drive<span class="brand-accent">Easy</span> Rentals</h2>
        <p class="muted small">42 Independence Ave, Windhoek · +264 81 555 0100 · hello@driveeasy.com</p>
      </div>
      <div class="doc-title">
        <h3>${isInvoice ? 'TAX INVOICE' : 'QUOTATION'}</h3>
        <p><strong>${esc(no)}</strong></p>
        <span class="status-badge status-${badge}">${esc(item.status)}</span>
      </div>
    </div>
    <div class="doc-grid">
      <div>
        <h4>Billed to</h4>
        <p><strong>${esc(item.customer_name)}</strong></p>
        <p>${esc(item.customer_email)}</p>
        <p>${esc(item.customer_phone || '')}</p>
      </div>
      <div>
        <h4>${isInvoice ? 'Invoice details' : 'Quote details'}</h4>
        ${meta}
      </div>
    </div>
    <table class="doc-table">
      <thead><tr><th>Description</th><th class="right">Amount</th></tr></thead>
      <tbody>
        <tr>
          <td>
            <strong>${esc(carLabel || 'Vehicle rental')}</strong><br>
            <span class="muted small">${esc(item.pickup_date)} → ${esc(item.return_date)} · ${item.total_days} day(s)</span>
            ${addonText ? `<br><span class="muted small">Add-ons: ${esc(addonText)}</span>` : ''}
          </td>
          <td class="right">${money(item.total_amount)}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr><td>Subtotal (excl. VAT)</td><td class="right">${money(item.subtotal)}</td></tr>
        <tr><td>VAT (${vatRate}%)</td><td class="right">${money(item.vat)}</td></tr>
        <tr class="doc-total"><td>Total (incl. VAT)</td><td class="right">${money(item.total_amount)}</td></tr>
      </tfoot>
    </table>
    ${item.notes ? `<p class="doc-more"><b>Notes:</b> ${esc(item.notes)}</p>` : ''}
    <p class="doc-more">Thank you for choosing DriveEasy Rentals. All amounts are in NAD and include VAT.</p>
  </div>`;
}

function openDoc(kind, id) {
  const item = kind === 'invoice'
    ? invoicesCache.find(i => i.id === +id)
    : quotesCache.find(q => q.id === +id);
  if (!item) { toast('Document not found. Refresh the page and try again.', 'error'); return; }
  $('#docContent').innerHTML = renderDoc(kind, item);
  docBackdrop.hidden = false;
  docBackdrop.classList.add('printable');
}

// ---------- Point of sale: approve a pending rental ----------
const posBackdrop = $('#posModalBackdrop');
function openPos(b) {
  $('#pos_booking_id').value = b.id;
  $('#pos_method').value = 'Cash';
  $('#pos_reference').value = '';
  $('#posSummary').innerHTML = `
    <div class="pos-summary">
      <div><strong>${esc(b.booking_code)}</strong> · ${esc(b.customer_name)}</div>
      <div class="muted small">${esc(b.car_brand)} ${esc(b.car_name)} · ${esc(b.pickup_date)} → ${esc(b.return_date)} (${b.total_days} days)</div>
      <div class="muted small">${esc(b.customer_email)} · ${esc(b.customer_phone)}</div>
      <div class="total"><span>Amount due</span><span>${money(b.total_amount)}</span></div>
    </div>`;
  posBackdrop.hidden = false;
}
$('#posModalClose').addEventListener('click', () => { posBackdrop.hidden = true; });
posBackdrop.addEventListener('click', e => { if (e.target === posBackdrop) posBackdrop.hidden = true; });

$('#posForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#posForm button[type="submit"]');
  btn.disabled = true;
  try {
    const out = await api(`/api/admin/bookings/${$('#pos_booking_id').value}/approve`, {
      method: 'POST',
      body: {
        payment_method: $('#pos_method').value,
        payment_reference: $('#pos_reference').value
      }
    });
    posBackdrop.hidden = true;
    toast('Payment processed — rental approved.');
    await loadInvoices();
    loadBookings();
    loadStats();
    openDoc('invoice', out.invoice.id);
    setTimeout(() => window.print(), 200);
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ---------- Walk-in client invoices ----------
const walkInBackdrop = $('#walkInModalBackdrop');
$('#addInvoiceBtn').addEventListener('click', () => {
  $('#walkInForm').reset();
  walkInBackdrop.hidden = false;
});
$('#walkInModalClose').addEventListener('click', () => { walkInBackdrop.hidden = true; });
walkInBackdrop.addEventListener('click', e => { if (e.target === walkInBackdrop) walkInBackdrop.hidden = true; });
$('#walkInForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const inv = await api('/api/admin/invoices', {
      method: 'POST',
      body: {
        customer_name: $('#wi_name').value,
        customer_email: $('#wi_email').value,
        customer_phone: $('#wi_phone').value,
        description: $('#wi_item').value,
        total_amount: +$('#wi_amount').value,
        due_date: $('#wi_due').value,
        pickup_date: $('#wi_pickup').value,
        return_date: $('#wi_return').value,
        notes: $('#wi_notes').value
      }
    });
    walkInBackdrop.hidden = true;
    toast('Invoice ' + inv.invoice_no + ' created.');
    await loadInvoices();
    loadStats();
    openDoc('invoice', inv.id);
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- Staff & manager accounts ----------
async function loadStaff() {
  const table = $('#staffTable');
  if (!table || !can('staff:manage')) return;
  try {
    const staff = await api('/api/admin/staff');
    const rows = staff.map(s => `
      <tr>
        <td><strong>${esc(s.full_name)}</strong><br><span class="muted small">@${esc(s.username)}</span></td>
        <td>${esc(s.email)}</td>
        <td>
          <select data-id="${s.id}" class="staff-role">
            <option value="staff" ${s.role === 'staff' ? 'selected' : ''}>Staff</option>
            <option value="manager" ${s.role === 'manager' ? 'selected' : ''}>Manager</option>
          </select>
        </td>
        <td>
          <select data-id="${s.id}" class="staff-status">
            <option value="active" ${s.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="suspended" ${s.status === 'suspended' ? 'selected' : ''}>Suspended</option>
          </select>
        </td>
        <td><span class="muted small">${esc(String(s.created_at).slice(0, 10))}</span></td>
        <td><button class="btn btn-danger btn-sm" data-staff-del="${s.id}" type="button">Delete</button></td>
      </tr>`).join('');
    table.innerHTML = `
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted" style="text-align:center;padding:2rem">No staff accounts yet.</td></tr>'}</tbody>`;

    $$('#staffTable .staff-role').forEach(sel => sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/staff/${sel.dataset.id}/role`, { method: 'PATCH', body: { role: sel.value } });
        toast('Staff role updated.');
      } catch (err) { toast(err.message, 'error'); loadStaff(); }
    }));
    $$('#staffTable .staff-status').forEach(sel => sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/staff/${sel.dataset.id}/status`, { method: 'PATCH', body: { status: sel.value } });
        toast('Staff status updated.');
      } catch (err) { toast(err.message, 'error'); loadStaff(); }
    }));
    $$('#staffTable [data-staff-del]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this staff account?')) return;
      try {
        await api('/api/admin/staff/' + btn.dataset.staffDel, { method: 'DELETE' });
        toast('Staff account deleted.');
        loadStaff();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}

const staffBackdrop = $('#staffModalBackdrop');
$('#addStaffBtn').addEventListener('click', () => { $('#staffForm').reset(); staffBackdrop.hidden = false; });
$('#staffModalClose').addEventListener('click', () => { staffBackdrop.hidden = true; });
staffBackdrop.addEventListener('click', e => { if (e.target === staffBackdrop) staffBackdrop.hidden = true; });
$('#staffForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/admin/staff', {
      method: 'POST',
      body: {
        full_name: $('#st_name').value,
        email: $('#st_email').value,
        username: $('#st_username').value,
        password: $('#st_password').value,
        role: $('#st_role').value
      }
    });
    staffBackdrop.hidden = true;
    toast('Staff account created.');
    loadStaff();
  } catch (err) { toast(err.message, 'error'); }
});
