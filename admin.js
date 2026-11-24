/* ===== DriveEasy Rentals — Admin Control Center ===== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let currencySymbol = 'N$';
let vatRate = 15;
let AUTH = { name: 'admin', username: 'admin', role: 'admin', permissions: ['*'] };
const can = (perm) => AUTH.permissions.includes('*') || AUTH.permissions.includes(perm);
function applyRoleUI() {
  const nav = (section, perm) => {
    const btn = $(`.admin-nav [data-section="${section}"]`);
    if (btn) btn.hidden = !can(perm);
  };
  nav('dashboard', 'view_dashboard');
  nav('cars', 'view_cars');
  nav('bookings', 'view_bookings');
  nav('quotes', 'quotes:write');
  nav('invoices', 'invoices:write');
  nav('staff', 'staff:manage');
  nav('demo', 'admin:only');
  nav('customers', 'view_customers');
  nav('messages', 'view_messages');
  nav('reviews', 'view_reviews');
  nav('settings', 'view_settings');
  const addCar = $('#addCarBtn');
  if (addCar) addCar.hidden = !can('cars:write');
  const saveSettings = $('#saveSettingsBtn');
  if (saveSettings) saveSettings.hidden = !can('settings:write');
  $$('.charts-grid').forEach(el => { el.hidden = !can('view_revenue'); });
  const active = $('.admin-nav button.active');
  if (active && active.hidden) {
    const first = [...$$('.admin-nav button')].find(b => !b.hidden);
    if (first) first.click();
  }
}
let carsCache = [];
let quotesCache = [];
let invoicesCache = [];
const money = (n) => currencySymbol + Number(n || 0).toFixed(2);
const CAR_STATUSES = { available: 'Available', maintenance: 'Maintenance', unavailable: 'Unavailable' };
const BOOKING_STATUSES = ['pending', 'confirmed', 'active', 'completed', 'cancelled'];
const MESSAGE_STATUSES = ['new', 'read', 'replied', 'archived'];
const ADDON_LABELS = { child_seat: 'Child Seat', additional_driver: 'Extra Driver', insurance: 'Full Insurance' };
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
    redirectToLogin();
    throw new Error(data.error || 'Session expired');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

// ---------- Auth / Views ----------
function redirectToLogin() { window.location.replace('/admin-login.html'); }
function showApp() { $('#appView').hidden = false; }

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  redirectToLogin();
});

(async () => {
  try {
    const me = await api('/api/admin/me');
    AUTH = { name: me.name || me.username, username: me.username, role: me.role || 'admin', permissions: me.permissions || [] };
    applyRoleUI();
    $('#adminUser').textContent = `Signed in: ${AUTH.name} (${AUTH.role})`;
    showApp();
    window.scrollTo(0, 0);
    refreshAll();
  } catch {
    redirectToLogin();
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
  if (can('view_revenue')) { loadStats(); loadAnalytics(); }
  loadCars();
  loadBookings();
  loadQuotes();
  loadInvoices();
  loadStaff();
  loadDemo();
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
      <div class="stat-card" id="revenueCard"><div class="num">${money(s.revenue)}</div><div class="lbl">Est. Revenue</div></div>
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
        <td><strong>${c.quantity || 1}</strong>${c.active_bookings ? `<br><span class="muted small">${c.active_bookings} booked</span>` : ''}</td>
        <td>${money(c.daily_rate)}/day</td>
        <td>${esc(c.transmission)}<br><span class="muted small">${esc(c.fuel_type)} · ${c.seats} seats</span></td>
        <td>${featuredCell}</td>
        <td>${statusCell}</td>
        ${actionsCell}
      </tr>`;
    }).join('');

    $('#carsTable').innerHTML = `
      <thead><tr><th>Photo</th><th>Vehicle</th><th>Category</th><th>Units</th><th>Rate</th><th>Specs</th><th>Featured</th><th>Status</th>${editable ? '<th>Actions</th>' : ''}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${editable ? 9 : 8}" class="muted" style="text-align:center;padding:2rem">No cars yet.</td></tr>`}</tbody>`;

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
  $('#f_quantity').value = car?.quantity || 1;
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
    quantity: +$('#f_quantity').value,
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
let invoiceTimer;
async function loadInvoices() {
  const table = $('#invoicesTable');
  if (!table) return;
  try {
    const invoices = await api('/api/admin/invoices');
    invoicesCache = invoices;
    const status = $('#invoiceStatusFilter').value;
    const q = $('#invoiceSearch').value.trim().toLowerCase();
    const visible = invoices.filter(i =>
      (!status || i.status === status) &&
      (!q || [i.invoice_no, i.booking_code, i.customer_name, i.customer_email].join(' ').toLowerCase().includes(q))
    );
    const rows = visible.map(i => {
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

    $('#invoiceStatusFilter').addEventListener('change', loadInvoices);
    $('#invoiceSearch').addEventListener('input', () => { clearTimeout(invoiceTimer); invoiceTimer = setTimeout(loadInvoices, 250); });

    $$('#invoicesTable [data-iview]').forEach(b => b.addEventListener('click', () => openDoc('invoice', +b.dataset.iview)));
    $$('#invoicesTable [data-ipay]').forEach(b => b.addEventListener('click', () => openPayInvoice(+b.dataset.ipay)));
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

$('#exportInvoicesBtn').addEventListener('click', () => {
  const header = ['Invoice', 'Booking', 'Client', 'Email', 'Total', 'Subtotal', 'VAT', 'Status', 'Method', 'Paid At'];
  const rows = invoicesCache.map(i => [i.invoice_no, i.booking_code, i.customer_name, i.customer_email,
    i.total_amount, i.subtotal, i.vat, i.status, i.payment_method, i.paid_at || '']);
  const csv = [header, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'driveeasy-invoices.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} invoice(s).`);
});

const payBackdrop = $('#payModalBackdrop');
let payInvoiceId = null;
let payLines = [];

function renderPayLines() {
  const box = $('#payInvoiceLines');
  if (!box) return;
  box.innerHTML = payLines.map((p, idx) => `
    <div class="booking-item" data-index="${idx}">
      <div class="grid-2">
        <div class="field"><label>Method ${idx + 1}</label>
          <select class="pay_method">
            ${PAYMENT_METHODS.map(m => `<option ${m === p.method ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Amount (NAD) *</label><input type="number" class="pay_amount" min="0" step="0.01" value="${p.amount || ''}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Reference</label><input class="pay_reference" value="${esc(p.reference || '')}" placeholder="Receipt / transaction no."></div>
        ${p.method === 'Cash' ? `<div class="field"><label>Cash received</label><input type="number" class="pay_tendered" min="0" step="0.01" value="${p.tendered || ''}"></div>` : ''}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-pay-remove="${idx}" ${payLines.length === 1 ? 'disabled' : ''}>Remove payment</button>
    </div>`).join('');

  $$('#payInvoiceLines .pay_method').forEach(sel => sel.addEventListener('change', () => {
    const p = payLines[Number(sel.closest('.booking-item').dataset.index)];
    p.method = sel.value;
    if (p.method === 'Cash') p.tendered = p.tendered || p.amount || 0;
    renderPayLines();
    renderPayTotals();
  }));
  $$('#payInvoiceLines .pay_amount').forEach(input => input.addEventListener('input', () => {
    const p = payLines[Number(input.closest('.booking-item').dataset.index)];
    p.amount = Number(input.value) || 0;
    if (p.method === 'Cash') p.tendered = p.tendered || p.amount;
    renderPayTotals();
  }));
  $$('#payInvoiceLines .pay_reference').forEach(input => input.addEventListener('input', () => {
    payLines[Number(input.closest('.booking-item').dataset.index)].reference = input.value;
  }));
  $$('#payInvoiceLines .pay_tendered').forEach(input => input.addEventListener('input', () => {
    payLines[Number(input.closest('.booking-item').dataset.index)].tendered = Number(input.value) || 0;
    renderPayTotals();
  }));
  $$('#payInvoiceLines [data-pay-remove]').forEach(btn => btn.addEventListener('click', () => {
    if (payLines.length === 1) return;
    payLines.splice(Number(btn.dataset.payRemove), 1);
    renderPayLines();
    renderPayTotals();
  }));
}

function renderPayTotals() {
  const box = $('#payInvoiceTotals');
  const invoice = invoicesCache.find(i => i.id === payInvoiceId);
  if (!box || !invoice) return;
  let paid = 0, cash = 0, change = 0;
  payLines.forEach(p => {
    paid += Number(p.amount) || 0;
    if (p.method === 'Cash') {
      cash += Number(p.tendered) || 0;
      change += Math.max(0, (Number(p.tendered) || 0) - (Number(p.amount) || 0));
    }
  });
  box.innerHTML = `
    <div><span>Subtotal (excl. VAT)</span><span>${money(invoice.subtotal)}</span></div>
    <div><span>VAT (${vatRate}%)</span><span>${money(invoice.vat)}</span></div>
    <div><span>Amount due</span><span>${money(invoice.total_amount)}</span></div>
    <div><span>Paid</span><span>${money(paid)}</span></div>
    ${paid + 0.01 < invoice.total_amount
      ? `<div class="total" style="color:var(--danger)"><span>Outstanding</span><span>${money(Math.max(0, invoice.total_amount - paid))}</span></div>`
      : `<div class="total"><span>Change / overpayment</span><span>${money(paid - invoice.total_amount)}</span></div>`}
    ${cash ? `<div><span>Cash received</span><span>${money(cash)}</span></div><div><span>Cash change</span><span>${money(change)}</span></div>` : ''}`;
}

function openPayInvoice(id) {
  const invoice = invoicesCache.find(i => i.id === +id);
  if (!invoice) return toast('Invoice not found.', 'error');
  payInvoiceId = +id;
  payLines = [{ method: 'Cash', amount: Number(invoice.total_amount), reference: '', tendered: Number(invoice.total_amount) }];
  $('#payWantsTax').checked = false;
  $('#payTaxFields').hidden = true;
  $('#payCompany').value = '';
  $('#payTaxNo').value = '';
  $('#payInvoiceSummary').innerHTML = `
    <div><strong>${esc(invoice.invoice_no)}</strong> · ${esc(invoice.booking_code || 'WALK-IN')}</div>
    <div class="muted small">${esc(invoice.customer_name)} · ${esc(invoice.customer_email || '')} · ${esc(invoice.customer_phone || '')}</div>
    <div class="muted small">${esc(invoice.car_label)} · ${esc(invoice.pickup_date)} → ${esc(invoice.return_date)}</div>
    <div class="total"><span>Amount due</span><span>${money(invoice.total_amount)}</span></div>`;
  renderPayLines();
  renderPayTotals();
  payBackdrop.hidden = false;
}

$('#payModalClose').addEventListener('click', () => { payBackdrop.hidden = true; });
payBackdrop.addEventListener('click', e => { if (e.target === payBackdrop) payBackdrop.hidden = true; });
$('#payAddPayment').addEventListener('click', () => {
  payLines.push({ method: 'Card', amount: 0, reference: '', tendered: null });
  renderPayLines();
  renderPayTotals();
});
$('#payWantsTax').addEventListener('change', () => { $('#payTaxFields').hidden = !$('#payWantsTax').checked; });
$('#payConfirmBtn').addEventListener('click', async () => {
  const invoice = invoicesCache.find(i => i.id === payInvoiceId);
  if (!invoice) return;
  const paid = payLines.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  if (paid + 0.01 < invoice.total_amount) return toast('Payments do not cover the invoice.', 'error');
  const badCash = payLines.find(p => p.method === 'Cash' && (Number(p.tendered) || 0) < Number(p.amount));
  if (badCash) return toast('Cash received must cover each cash payment.', 'error');
  try {
    const out = await api(`/api/admin/invoices/${payInvoiceId}/pay`, {
      method: 'PATCH',
      body: {
        payments: payLines.map(p => ({
          method: p.method, amount: Number(p.amount), reference: p.reference,
          tendered: p.method === 'Cash' ? Number(p.tendered) : undefined
        })),
        client: {
          wants_tax_invoice: $('#payWantsTax').checked,
          company: $('#payCompany').value,
          tax_number: $('#payTaxNo').value
        }
      }
    });
    payBackdrop.hidden = true;
    toast('Payment processed — invoice paid.');
    await loadInvoices();
    loadBookings();
    loadStats();
    openDoc('invoice', out.id);
    setTimeout(() => window.print(), 200);
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- Printable quotation / invoice ----------
const docBackdrop = $('#docModalBackdrop');
function closeDoc() {
  docBackdrop.hidden = true;
  docBackdrop.classList.remove('printable');
  document.title = 'Admin Control Center — DriveEasy Rentals';
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
        ${isInvoice && item.client_company ? `<p><strong>${esc(item.client_company)}</strong></p>` : ''}
        ${isInvoice && item.client_tax_no ? `<p>Tax No: ${esc(item.client_tax_no)}</p>` : ''}
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
    ${isInvoice && item.amount_tendered != null ? `<p class="doc-more"><b>Cash tendered:</b> ${money(item.amount_tendered)} · <b>Change:</b> ${money(item.change_amount || 0)}</p>` : ''}
    ${isInvoice && item.payments ? `<p class="doc-more"><b>Payments:</b> ${(() => { try { return JSON.parse(item.payments).map(p => `${esc(p.method)} ${money(p.amount)}${p.reference ? ' (' + esc(p.reference) + ')' : ''}${p.change ? ' · change ' + money(p.change) : ''}`).join(' · '); } catch { return ''; } })()}</p>` : ''}
    ${item.notes ? `<p class="doc-more"><b>Notes:</b> ${esc(item.notes)}</p>` : ''}
    <p class="doc-more doc-footer">Thank you for choosing DriveEasy Rentals. All amounts are in NAD and include VAT.</p>
  </div>`;
}

function openDoc(kind, id) {
  const item = kind === 'invoice'
    ? invoicesCache.find(i => i.id === +id)
    : quotesCache.find(q => q.id === +id);
  if (!item) { toast('Document not found. Refresh the page and try again.', 'error'); return; }
  $('#docContent').innerHTML = renderDoc(kind, item);
  document.title = (kind === 'invoice' ? 'INVOICE ' + item.invoice_no : 'QUOTE ' + item.quote_no);
  docBackdrop.hidden = false;
  docBackdrop.classList.add('printable');
}

// ---------- Point of sale: approve a pending rental ----------
const posBackdrop = $('#posModalBackdrop');
let posBooking = null;
function refreshPosFields() {
  const isCash = $('#pos_method').value.toLowerCase() === 'cash';
  $('#posCashFields').hidden = !isCash;
  const total = posBooking ? Number(posBooking.total_amount) : 0;
  const tendered = Number($('#pos_tendered').value) || 0;
  const change = isCash ? Math.round((tendered - total) * 100) / 100 : 0;
  $('#pos_change').value = isCash ? money(change) : '';
  $('#pos_tendered').classList.toggle('invalid', isCash && tendered < total);
}
function openPos(b) {
  posBooking = b;
  $('#pos_booking_id').value = b.id;
  $('#pos_method').value = 'Cash';
  $('#pos_reference').value = '';
  $('#pos_tendered').value = Number(b.total_amount).toFixed(2);
  $('#pos_wants_tax').checked = false;
  $('#posClientFields').hidden = true;
  ['pos_c_name', 'pos_c_email', 'pos_c_phone', 'pos_c_company', 'pos_c_tax'].forEach(id => { $('#' + id).value = ''; });
  $('#posSummary').innerHTML = `
    <div class="pos-summary">
      <div><strong>${esc(b.booking_code)}</strong> · ${esc(b.customer_name)}</div>
      <div class="muted small">${esc(b.car_brand)} ${esc(b.car_name)} · ${esc(b.pickup_date)} → ${esc(b.return_date)} (${b.total_days} days)</div>
      <div class="muted small">${esc(b.customer_email)} · ${esc(b.customer_phone)}</div>
      <div class="pos-lines">
        <div><span>Subtotal (excl. VAT)</span><span>${money(b.subtotal)}</span></div>
        <div><span>VAT (${vatRate}%)</span><span>${money(b.vat)}</span></div>
      </div>
      <div class="total"><span>Amount due (incl. VAT)</span><span>${money(b.total_amount)}</span></div>
    </div>`;
  refreshPosFields();
  posBackdrop.hidden = false;
}
$('#pos_method').addEventListener('change', refreshPosFields);
$('#pos_tendered').addEventListener('input', refreshPosFields);
$('#pos_wants_tax').addEventListener('change', () => {
  const on = $('#pos_wants_tax').checked;
  $('#posClientFields').hidden = !on;
  if (on && posBooking) {
    if (!$('#pos_c_name').value) $('#pos_c_name').value = posBooking.customer_name || '';
    if (!$('#pos_c_email').value) $('#pos_c_email').value = posBooking.customer_email || '';
    if (!$('#pos_c_phone').value) $('#pos_c_phone').value = posBooking.customer_phone || '';
  }
});
$('#posModalClose').addEventListener('click', () => { posBackdrop.hidden = true; });
posBackdrop.addEventListener('click', e => { if (e.target === posBackdrop) posBackdrop.hidden = true; });

$('#posForm').addEventListener('submit', async e => {
  e.preventDefault();
  const method = $('#pos_method').value;
  if (method.toLowerCase() === 'cash' && (Number($('#pos_tendered').value) || 0) < Number((posBooking || {}).total_amount || 0)) {
    return toast('Cash amount must cover the total due.', 'error');
  }
  if ($('#pos_wants_tax').checked && !$('#pos_c_name').value.trim()) {
    return toast('Enter the client name for the tax invoice.', 'error');
  }
  const btn = $('#posForm button[type="submit"]');
  btn.disabled = true;
  try {
    const out = await api(`/api/admin/bookings/${$('#pos_booking_id').value}/approve`, {
      method: 'POST',
      body: {
        payment_method: method,
        payment_reference: $('#pos_reference').value,
        amount_tendered: method.toLowerCase() === 'cash' ? Number($('#pos_tendered').value) : undefined,
        client_details: {
          wants_tax_invoice: $('#pos_wants_tax').checked,
          customer_name: $('#pos_c_name').value,
          customer_email: $('#pos_c_email').value,
          customer_phone: $('#pos_c_phone').value,
          company: $('#pos_c_company').value,
          tax_number: $('#pos_c_tax').value
        }
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

// ---------- Full point of sale (staff-assisted sale) ----------
const walkInBackdrop = $('#walkInModalBackdrop');
let posSaleItems = [];
let posSalePayments = [];
const PAYMENT_METHODS = ['Cash', 'Card', 'Bank transfer', 'Mobile money'];

function posSaleTotals() {
  const p = $('#wi_pickup').value, r = $('#wi_return').value;
  const days = (p && r && r > p) ? Math.max(1, Math.ceil((new Date(r) - new Date(p)) / 86400000)) : 0;
  let subtotal = 0, vat = 0, total = 0;
  posSaleItems.forEach(item => {
    const car = carsCache.find(c => c.id === item.car_id);
    if (!car || !days) return;
    let addon = 0;
    Object.keys(item.add_ons || {}).forEach(k => { if (item.add_ons[k] && ADDON_PRICE[k]) addon += ADDON_PRICE[k]; });
    const amount = (Number(car.daily_rate) + addon) * days;
    subtotal += amount / (1 + vatRate / 100);
    vat += amount - amount / (1 + vatRate / 100);
    total += amount;
  });
  return { days, subtotal, vat, total };
}
const ADDON_PRICE = { child_seat: 5, additional_driver: 8, insurance: 12 };

function renderPosSaleItems() {
  const box = $('#posSaleItems');
  if (!box) return;
  const options = carsCache.filter(c => c.status === 'available' || posSaleItems.some(i => i.car_id === c.id));
  box.innerHTML = posSaleItems.map((item, idx) => `
    <div class="booking-item" data-index="${idx}">
      <div class="grid-2">
        <div class="field"><label>Vehicle ${idx + 1}</label>
          <select class="ps_car">
            ${options.map(c => `<option value="${c.id}" ${c.id === item.car_id ? 'selected' : ''}>${esc(c.brand)} ${esc(c.name)} — ${money(c.daily_rate)}/day</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Add-ons (per day)</label>
          ${Object.entries(ADDON_LABELS).map(([k, label]) => `
            <label class="checkbox-row"><input type="checkbox" class="ps_addon" data-key="${k}" ${item.add_ons[k] ? 'checked' : ''}> ${esc(label)} +${money(ADDON_PRICE[k])}</label>`).join('')}
        </div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-ps-remove="${idx}" ${posSaleItems.length === 1 ? 'disabled' : ''}>Remove vehicle</button>
    </div>`).join('');

  $$('#posSaleItems .ps_car').forEach(sel => sel.addEventListener('change', () => {
    posSaleItems[Number(sel.closest('.booking-item').dataset.index)].car_id = Number(sel.value);
    renderPosSaleTotals();
  }));
  $$('#posSaleItems .ps_addon').forEach(input => input.addEventListener('change', () => {
    const item = posSaleItems[Number(input.closest('.booking-item').dataset.index)];
    item.add_ons[input.dataset.key] = input.checked;
    renderPosSaleTotals();
  }));
  $$('#posSaleItems [data-ps-remove]').forEach(btn => btn.addEventListener('click', () => {
    if (posSaleItems.length === 1) return;
    posSaleItems.splice(Number(btn.dataset.psRemove), 1);
    renderPosSaleItems();
    renderPosSaleTotals();
  }));
}

function renderPosSalePayments() {
  const box = $('#posSalePayments');
  if (!box) return;
  box.innerHTML = posSalePayments.map((pay, idx) => `
    <div class="booking-item" data-index="${idx}">
      <div class="grid-2">
        <div class="field"><label>Method ${idx + 1}</label>
          <select class="ps_method">
            ${PAYMENT_METHODS.map(m => `<option ${m === pay.method ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Amount (NAD) *</label><input type="number" class="ps_amount" min="0" step="0.01" value="${pay.amount || ''}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Reference</label><input class="ps_reference" value="${esc(pay.reference || '')}" placeholder="Receipt / transaction no."></div>
        ${pay.method === 'Cash' ? `<div class="field"><label>Cash received</label><input type="number" class="ps_tendered" min="0" step="0.01" value="${pay.tendered || ''}"></div>` : ''}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-psp-remove="${idx}" ${posSalePayments.length === 1 ? 'disabled' : ''}>Remove payment</button>
    </div>`).join('');

  $$('#posSalePayments .ps_method').forEach(sel => sel.addEventListener('change', () => {
    const pay = posSalePayments[Number(sel.closest('.booking-item').dataset.index)];
    pay.method = sel.value;
    if (pay.method === 'Cash') pay.tendered = pay.tendered || pay.amount || 0;
    renderPosSalePayments();
    renderPosSaleTotals();
  }));
  $$('#posSalePayments .ps_amount').forEach(input => input.addEventListener('input', () => {
    const pay = posSalePayments[Number(input.closest('.booking-item').dataset.index)];
    pay.amount = Number(input.value) || 0;
    if (pay.method === 'Cash') pay.tendered = pay.tendered || pay.amount;
    renderPosSaleTotals();
  }));
  $$('#posSalePayments .ps_reference').forEach(input => input.addEventListener('input', () => {
    posSalePayments[Number(input.closest('.booking-item').dataset.index)].reference = input.value;
  }));
  $$('#posSalePayments .ps_tendered').forEach(input => input.addEventListener('input', () => {
    posSalePayments[Number(input.closest('.booking-item').dataset.index)].tendered = Number(input.value) || 0;
    renderPosSaleTotals();
  }));
  $$('#posSalePayments [data-psp-remove]').forEach(btn => btn.addEventListener('click', () => {
    if (posSalePayments.length === 1) return;
    posSalePayments.splice(Number(btn.dataset.pspRemove), 1);
    renderPosSalePayments();
    renderPosSaleTotals();
  }));
}

function renderPosSaleTotals() {
  const box = $('#posSaleSummary');
  if (!box) return;
  const { days, subtotal, vat, total } = posSaleTotals();
  let paid = 0, cash = 0, change = 0;
  posSalePayments.forEach(p => {
    paid += Number(p.amount) || 0;
    if (p.method === 'Cash') {
      cash += Number(p.tendered) || 0;
      change += Math.max(0, (Number(p.tendered) || 0) - (Number(p.amount) || 0));
    }
  });
  const balance = paid - total;
  box.innerHTML = `
    <div><span>Rental period</span><span>${days} day(s)</span></div>
    <div><span>Subtotal (excl. VAT)</span><span>${money(subtotal)}</span></div>
    <div><span>VAT (${vatRate}%)</span><span>${money(vat)}</span></div>
    <div><span>Total (incl. VAT)</span><span>${money(total)}</span></div>
    <div><span>Paid</span><span>${money(paid)}</span></div>
    ${balance < 0 ? `<div class="total" style="color:var(--danger)"><span>Outstanding</span><span>${money(-balance)}</span></div>`
      : `<div class="total"><span>Change / overpayment</span><span>${money(balance)}</span></div>`}
    ${cash ? `<div><span>Cash received</span><span>${money(cash)}</span></div><div><span>Cash change</span><span>${money(change)}</span></div>` : ''}`;
}

async function openPosSale() {
  try {
    if (!carsCache.length) carsCache = await api('/api/admin/cars');
    $('#walkInForm').reset();
    $('#wi_pickup').value = new Date().toISOString().slice(0, 10);
    $('#wi_return').value = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const first = carsCache.find(c => c.status === 'available');
    posSaleItems = first ? [{ car_id: first.id, add_ons: {} }] : [];
    posSalePayments = [{ method: 'Cash', amount: 0, reference: '', tendered: 0 }];
    renderPosSaleItems();
    renderPosSalePayments();
    const totals = posSaleTotals();
    posSalePayments[0].amount = Math.round(totals.total * 100) / 100;
    posSalePayments[0].tendered = posSalePayments[0].amount;
    renderPosSalePayments();
    renderPosSaleTotals();
    walkInBackdrop.hidden = false;
  } catch (err) { toast(err.message, 'error'); }
}
$('#addInvoiceBtn').addEventListener('click', openPosSale);
$('#walkInModalClose').addEventListener('click', () => { walkInBackdrop.hidden = true; });
walkInBackdrop.addEventListener('click', e => { if (e.target === walkInBackdrop) walkInBackdrop.hidden = true; });
$('#wi_pickup').addEventListener('change', renderPosSaleTotals);
$('#wi_return').addEventListener('change', renderPosSaleTotals);
$('#wi_wants_tax').addEventListener('change', () => { $('#wiTaxFields').hidden = !$('#wi_wants_tax').checked; });
$('#posAddCar').addEventListener('click', () => {
  const next = carsCache.find(c => c.status === 'available' && !posSaleItems.some(i => i.car_id === c.id));
  if (!next) return toast('No more available vehicles.', 'error');
  posSaleItems.push({ car_id: next.id, add_ons: {} });
  renderPosSaleItems();
  renderPosSaleTotals();
});
$('#posAddPayment').addEventListener('click', () => {
  posSalePayments.push({ method: 'Card', amount: 0, reference: '', tendered: null });
  renderPosSalePayments();
  renderPosSaleTotals();
});
$('#walkInForm').addEventListener('submit', async e => {
  e.preventDefault();
  const totals = posSaleTotals();
  const paid = posSalePayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  if (!posSaleItems.length) return toast('Choose at least one vehicle.', 'error');
  if (paid + 0.01 < totals.total) return toast('Payments do not cover the total.', 'error');
  const badCash = posSalePayments.find(p => p.method === 'Cash' && (Number(p.tendered) || 0) < Number(p.amount));
  if (badCash) return toast('Cash received must cover each cash payment.', 'error');
  try {
    const out = await api('/api/admin/pos/sale', {
      method: 'POST',
      body: {
        items: posSaleItems.map(i => ({ car_id: i.car_id, add_ons: i.add_ons })),
        pickup_date: $('#wi_pickup').value,
        return_date: $('#wi_return').value,
        notes: $('#wi_notes').value,
        client: {
          name: $('#wi_name').value, email: $('#wi_email').value, phone: $('#wi_phone').value,
          license: $('#wi_license').value, wants_tax_invoice: $('#wi_wants_tax').checked,
          company: $('#wi_company').value, tax_number: $('#wi_taxno').value
        },
        payments: posSalePayments.map(p => ({
          method: p.method, amount: Number(p.amount), reference: p.reference,
          tendered: p.method === 'Cash' ? Number(p.tendered) : undefined
        }))
      }
    });
    walkInBackdrop.hidden = true;
    toast('Sale complete — invoice ' + out.invoice.invoice_no + '.');
    await loadInvoices();
    loadBookings();
    loadStats();
    openDoc('invoice', out.invoice.id);
    setTimeout(() => window.print(), 200);
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
        <td><div class="table-actions">
          <button class="btn btn-sm" data-staff-perm="${s.id}" type="button">Permissions</button>
          <button class="btn btn-danger btn-sm" data-staff-del="${s.id}" type="button">Delete</button>
        </div></td>
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
    $$('#staffTable [data-staff-perm]').forEach(btn => btn.addEventListener('click', () => {
      openPermEditor(staff.find(s => s.id === +btn.dataset.staffPerm));
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

// ---------- Demo / sample data ----------
async function loadDemo() {
  if (!can('admin:only')) return;
  const box = $('#demoCounts');
  if (!box) return;
  try {
    const data = await api('/api/admin/demo-data');
    box.innerHTML = Object.entries(data.counts).map(([label, value]) => `
      <div class="profile-kpi"><div class="num">${value}</div><div class="lbl">${esc(label)}</div></div>
    `).join('');
  } catch (err) { toast(err.message, 'error'); }
}
$('#refreshDemoBtn').addEventListener('click', loadDemo);
$('#addDemoBtn').addEventListener('click', async () => {
  try {
    const out = await api('/api/admin/demo-data/add', { method: 'POST' });
    toast(out.added ? 'Demo data added.' : 'Demo data was already present.');
    loadDemo();
    refreshAll();
  } catch (err) { toast(err.message, 'error'); }
});
$('#removeDemoBtn').addEventListener('click', async () => {
  if (!confirm('Remove all demo records? Real data is not affected.')) return;
  try {
    const out = await api('/api/admin/demo-data/remove', { method: 'POST' });
    toast(`Removed ${out.removed} demo record(s).`);
    loadDemo();
    refreshAll();
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- Configurable staff permissions ----------
const PERMISSION_CATALOG = [
  'view_dashboard', 'view_revenue', 'view_cars', 'cars:write', 'view_bookings', 'bookings:write',
  'bookings:approve', 'quotes:write', 'quotes:delete', 'invoices:write', 'invoices:delete',
  'view_messages', 'messages:write', 'view_reviews', 'reviews:write', 'view_customers',
  'customers:write', 'view_settings', 'settings:write', 'staff:manage'
];
const PERMISSION_LABELS = {
  view_dashboard: 'View dashboard', view_revenue: 'View revenue & charts (admin / manager)',
  view_cars: 'View fleet availability', 'cars:write': 'Add / edit / delete cars',
  view_bookings: 'View bookings', 'bookings:write': 'Edit booking statuses',
  'bookings:approve': 'Approve rentals via Point of Sale',
  'quotes:write': 'Create quotations', 'quotes:delete': 'Delete quotations',
  'invoices:write': 'Create / process invoices', 'invoices:delete': 'Delete invoices',
  view_messages: 'Check messages', 'messages:write': 'Manage messages',
  view_reviews: 'Check reviews', 'reviews:write': 'Manage reviews',
  view_customers: 'View customers', 'customers:write': 'Manage customers',
  view_settings: 'View site settings', 'settings:write': 'Change site settings',
  'staff:manage': 'Manage staff accounts'
};
const ROLE_DEFAULT_STAFF = ['view_cars', 'view_bookings', 'bookings:approve', 'quotes:write',
  'invoices:write', 'view_messages', 'view_reviews'];
const ROLE_DEFAULT_MANAGER = PERMISSION_CATALOG.filter(p => p !== 'staff:manage');
let permStaffId = null;
const permBackdrop = $('#permModalBackdrop');

function openPermEditor(staffMember) {
  if (!staffMember) return;
  permStaffId = staffMember.id;
  const owned = staffMember.has_custom_permissions
    ? staffMember.permissions
    : (staffMember.role === 'manager' ? ROLE_DEFAULT_MANAGER : ROLE_DEFAULT_STAFF);
  $('#permModalName').textContent = `${staffMember.full_name} · ${staffMember.role}`;
  $('#permList').innerHTML = PERMISSION_CATALOG.map(p => `
    <label class="checkbox-row"><input type="checkbox" value="${p}" ${owned.includes(p) ? 'checked' : ''}> ${PERMISSION_LABELS[p] || p}</label>
  `).join('');
  permBackdrop.hidden = false;
}
$('#permModalClose').addEventListener('click', () => { permBackdrop.hidden = true; });
permBackdrop.addEventListener('click', e => { if (e.target === permBackdrop) permBackdrop.hidden = true; });
$('#permSaveBtn').addEventListener('click', async () => {
  const permissions = $$('#permList input:checked').map(i => i.value);
  try {
    await api(`/api/admin/staff/${permStaffId}/permissions`, { method: 'PATCH', body: { permissions } });
    permBackdrop.hidden = true;
    toast('Permissions saved.');
    loadStaff();
  } catch (err) { toast(err.message, 'error'); }
});
