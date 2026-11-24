/* ===== DriveEasy Rentals — Shared Website Helpers & Book Now Logic ===== */
window.DriveEasy = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = {
    settings: {
      site_name: 'DriveEasy',
      site_accent: 'Rentals',
      tagline: 'Drive easy, travel far.',
      currency_symbol: '$',
      vat_rate: '10',
      contact_email: 'hello@driveeasy.com',
      contact_phone: '+264 81 555 0100',
      contact_address: '42 Independence Ave, Windhoek',
      contact_hours: 'Mon–Sat: 07:00 – 19:00 · Sun: 09:00 – 16:00'
    },
    addons: {
      child_seat: { label: 'Child Seat', price: 5 },
      additional_driver: { label: 'Additional Driver', price: 8 },
      insurance: { label: 'Full Insurance', price: 12 }
    },
    vatRate: 10,
    locations: ['Main Office', 'Hosea Kutako Airport', 'City Center Branch'],
    customer: null
  };

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(n) {
    const sym = state.settings.currency_symbol || '$';
    return sym + Number(n || 0).toFixed(2);
  }

  function toast(msg, type = 'success') {
    let box = $('#toastContainer');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toastContainer';
      box.className = 'toast-container';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function todayPlus(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(a, b) {
    return Math.max(1, Math.ceil((new Date(b) - new Date(a)) / 86400000));
  }

  function initMobileNav() {
    const btn = $('#navToggle');
    const nav = $('#mainNav');
    if (!btn || !nav || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      nav.classList.toggle('open');
      btn.classList.toggle('open');
      btn.setAttribute('aria-expanded', nav.classList.contains('open'));
    });
    $$('#mainNav a').forEach(a => a.addEventListener('click', () => {
      nav.classList.remove('open');
      btn.classList.remove('open');
    }));
  }

  function applySiteConfig() {
    const s = state.settings;
    $$('[data-setting]').forEach(el => {
      const k = el.dataset.setting;
      if (s[k] !== undefined) el.textContent = s[k];
    });
    $$('[data-brand]').forEach(el => {
      el.innerHTML = `${esc(s.site_name)}<span class="brand-accent">${esc(s.site_accent)}</span>`;
    });
    const navReg = $('#navRegisterLink');
    if (navReg) {
      if (state.customer) {
        navReg.textContent = 'My Account';
        navReg.title = `Signed in as ${state.customer.full_name}`;
      } else {
        navReg.textContent = 'Register / Sign In';
      }
    }
  }

  async function loadSite() {
    initMobileNav();
    try {
      const res = await fetch('/api/site');
      if (res.ok) {
        const data = await res.json();
        Object.assign(state.settings, data.settings || {});
        if (data.addons) state.addons = data.addons;
        if (typeof data.vat_rate === 'number') state.vatRate = data.vat_rate;
        if (Array.isArray(data.locations) && data.locations.length) state.locations = data.locations;
        state.customer = data.customer || null;
      }
    } catch {
      // keep defaults if offline
    }
    applySiteConfig();
    return state;
  }

  return { $, $$, state, esc, money, toast, todayPlus, daysBetween, loadSite };
})();

/* ===== Book Now Page Controller (activates automatically on book.html) ===== */
(() => {
  const { $, $$, state: site, esc, money, toast, todayPlus, daysBetween, loadSite } = window.DriveEasy;
  const carGrid = $('#carGrid');
  if (!carGrid || !$('#searchBar')) return;

  const pageState = { cars: [], dates: null, initialCarId: null };

  function readQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const pu = params.get('pickup');
    const re = params.get('ret');
    const cat = params.get('category');
    const carId = params.get('carId');

    const pEl = $('#pickupDate'), rEl = $('#returnDate');
    pEl.min = todayPlus(0);
    pEl.value = pu && /^\d{4}-\d{2}-\d{2}$/.test(pu) ? pu : todayPlus(1);
    rEl.min = pEl.value;
    rEl.value = re && /^\d{4}-\d{2}-\d{2}$/.test(re) && re > pEl.value ? re : todayPlus(4);

    if (cat) $('#categoryFilter').value = cat;
    if (carId && Number.isInteger(+carId)) pageState.initialCarId = +carId;
  }

  function buildQuery() {
    const p = new URLSearchParams();
    const map = {
      search: '#searchInput',
      category: '#categoryFilter',
      transmission: '#transmissionFilter',
      seats: '#seatsFilter'
    };
    for (const [k, sel] of Object.entries(map)) {
      const v = $(sel).value.trim();
      if (v) p.set(k, v);
    }
    const maxP = $('#priceFilter').value;
    if (+maxP < 200) p.set('maxPrice', maxP);
    const pu = $('#pickupDate').value, re = $('#returnDate').value;
    if (pu && re && re > pu) {
      p.set('pickup', pu);
      p.set('ret', re);
      pageState.dates = { pickup: pu, ret: re };
    } else {
      pageState.dates = null;
    }
    return p;
  }

  async function loadCars() {
    carGrid.innerHTML = '<div class="empty-state"><p>Loading cars…</p></div>';
    try {
      const res = await fetch('/api/cars?' + buildQuery().toString());
      const cars = await res.json();
      if (!res.ok) throw new Error(cars.error || 'Failed to load cars.');
      pageState.cars = cars;
      renderCars(cars);
      $('#carCount').textContent = `${cars.length} car${cars.length === 1 ? '' : 's'}`;
      $('#fleetHint').textContent = pageState.dates
        ? `Showing availability from ${pageState.dates.pickup} to ${pageState.dates.ret}.`
        : 'Select dates above to check real-time availability.';

      if (pageState.initialCarId) {
        const target = cars.find(c => c.id === pageState.initialCarId);
        pageState.initialCarId = null;
        if (target && target.is_available) openBooking(target.id);
        else if (target) openDetails(target.id);
      }
    } catch (e) {
      carGrid.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`;
    }
  }

  function statusBadge(car) {
    if (car.status !== 'available') return `<span class="badge ${esc(car.status)}">${esc(car.status)}</span>`;
    return car.is_available ? '<span class="badge available">Available</span>' : '<span class="badge booked">Booked</span>';
  }

  function renderCars(cars) {
    if (!cars.length) {
      carGrid.innerHTML = '<div class="empty-state"><p>No cars match your filters. Try adjusting the dates or criteria.</p></div>';
      return;
    }
    carGrid.innerHTML = cars.map(car => `
      <article class="car-card" data-id="${car.id}">
        <div class="car-img">
          <img src="${esc(car.image_url)}" alt="${esc(car.brand)} ${esc(car.name)}" loading="lazy">
          ${statusBadge(car)}
          <span class="badge category">${esc(car.category)}</span>
        </div>
        <div class="car-body">
          <div class="car-title">${esc(car.brand)} ${esc(car.name)} <span class="year">· ${car.year}</span></div>
          <div class="car-meta">
            <span>${esc(car.transmission)}</span>
            <span>${esc(car.fuel_type)}</span>
            <span>${car.seats} seats</span>
            <span>${car.doors} doors</span>
          </div>
          <div class="car-features">${(car.features || '').split(',').filter(Boolean).slice(0, 4).map(esc).join(' · ')}</div>
          <div class="car-foot">
            <div class="price">${money(car.daily_rate)} <small>/ day</small></div>
            <div style="display:flex;gap:.4rem">
              <button class="btn btn-ghost btn-sm" data-action="details" type="button">Details</button>
              <button class="btn btn-sm ${car.is_available ? 'btn-accent' : ''}" data-action="book" type="button" ${car.is_available ? '' : 'disabled'}>Book</button>
            </div>
          </div>
        </div>
      </article>`).join('');

    $$('.car-card [data-action="details"]').forEach(b => b.addEventListener('click', e => {
      openDetails(+e.target.closest('.car-card').dataset.id);
    }));
    $$('.car-card [data-action="book"]').forEach(b => b.addEventListener('click', e => {
      openBooking(+e.target.closest('.car-card').dataset.id);
    }));
  }

  let debounce;
  function onFilterChange() { clearTimeout(debounce); debounce = setTimeout(loadCars, 240); }
  ['#searchInput', '#categoryFilter', '#transmissionFilter', '#seatsFilter', '#priceFilter'].forEach(sel => {
    $(sel).addEventListener('input', onFilterChange);
    $(sel).addEventListener('change', onFilterChange);
  });
  $('#priceFilter').addEventListener('input', e => {
    const sym = site.settings.currency_symbol || '$';
    $('#priceLabel').textContent = sym + e.target.value;
  });
  $('#clearFilters').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#categoryFilter').value = '';
    $('#transmissionFilter').value = '';
    $('#seatsFilter').value = '';
    $('#priceFilter').value = 200;
    $('#priceLabel').textContent = (site.settings.currency_symbol || '$') + '200';
    const pEl = $('#pickupDate'), rEl = $('#returnDate');
    pEl.value = todayPlus(1); rEl.min = pEl.value; rEl.value = todayPlus(4);
    loadCars();
  });

  $('#searchBar').addEventListener('submit', e => {
    e.preventDefault();
    const p = $('#pickupDate').value, r = $('#returnDate').value;
    if (!p || !r) return toast('Please choose both pickup and return dates.', 'error');
    if (r <= p) return toast('Return date must be after the pickup date.', 'error');
    loadCars();
  });
  $('#pickupDate').addEventListener('change', e => { $('#returnDate').min = e.target.value; });

  const backdrop = $('#modalBackdrop'), modalBody = $('#modalBody');
  function openModal(html) { modalBody.innerHTML = html; backdrop.hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal() { backdrop.hidden = true; document.body.style.overflow = ''; }
  $('#modalClose').addEventListener('click', closeModal);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !backdrop.hidden) closeModal(); });

  function openDetails(id) {
    const car = pageState.cars.find(c => c.id === id);
    if (!car) return;
    const feats = (car.features || '').split(',').filter(Boolean).map(esc);
    const minAge = site.settings.min_driver_age || '21';
    openModal(`
      <img class="detail-img" src="${esc(car.image_url)}" alt="${esc(car.brand)} ${esc(car.name)}">
      <h2 id="modalTitle">${esc(car.brand)} ${esc(car.name)} <span class="muted" style="font-size:1rem">· ${car.year}</span></h2>
      <div style="margin-bottom:.65rem">${statusBadge(car)} <span class="badge category" style="position:static;display:inline-block">${esc(car.category)}</span></div>
      <p>${esc(car.description || '')}</p>
      <div class="spec-grid">
        <div class="spec"><b>Transmission</b>${esc(car.transmission)}</div>
        <div class="spec"><b>Fuel</b>${esc(car.fuel_type)}</div>
        <div class="spec"><b>Seats</b>${car.seats}</div>
        <div class="spec"><b>Doors</b>${car.doors}</div>
        <div class="spec"><b>Daily rate</b>${money(car.daily_rate)}</div>
      </div>
      ${feats.length ? `<p class="car-features" style="margin:.6rem 0"><strong>Features:</strong> ${feats.join(' · ')}</p>` : ''}
      <p class="muted small" style="margin-bottom:1rem">Rental terms: Minimum driver age ${esc(minAge)} · Valid driver's license required · Fuel returned as received.</p>
      <button class="btn btn-accent btn-lg btn-block" id="detailsBookBtn" ${car.is_available ? '' : 'disabled'}>
        ${car.is_available ? 'Book This Car' : 'Not available for selected dates'}
      </button>`);
    $('#detailsBookBtn').addEventListener('click', () => openBooking(id));
  }

  function openBooking(id) {
    const car = pageState.cars.find(c => c.id === id);
    if (!car || !car.is_available) return;
    const d = pageState.dates || { pickup: todayPlus(1), ret: todayPlus(4) };
    const c = site.customer || {};
    const locs = site.locations || ['Main Office'];

    openModal(`
      <h2 id="modalTitle">Book: ${esc(car.brand)} ${esc(car.name)}</h2>
      <form id="bookingForm" novalidate>
        <div class="grid-2">
          <div class="field"><label>Pickup date *</label><input type="date" id="b_pickup" value="${esc(d.pickup)}" min="${todayPlus(0)}" required></div>
          <div class="field"><label>Return date *</label><input type="date" id="b_return" value="${esc(d.ret)}" min="${esc(d.pickup)}" required></div>
        </div>
        <div class="field"><label>Pickup branch *</label>
          <select id="b_location">${locs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Full name *</label><input id="b_name" required value="${esc(c.full_name || '')}" placeholder="Jane Doe"></div>
        <div class="grid-2">
          <div class="field"><label>Email *</label><input id="b_email" type="email" required value="${esc(c.email || '')}" placeholder="jane@example.com"></div>
          <div class="field"><label>Phone *</label><input id="b_phone" required value="${esc(c.phone || '')}" placeholder="+264 81 000 0000"></div>
        </div>
        <div class="field"><label>Driver's license ref</label><input id="b_license" value="${esc(c.license_ref || '')}" placeholder="DL-12345"></div>
        <div class="field"><label>Pickup / drop-off notes</label><textarea id="b_notes" rows="2" placeholder="Flight number, arrival time, special requests…"></textarea></div>
        <fieldset style="border:0;margin-bottom:.4rem">
          <legend style="font-size:.85rem;font-weight:600;color:var(--muted);margin-bottom:.3rem">Optional add-ons (per day)</legend>
          ${Object.entries(site.addons).map(([k, a]) => `
            <label class="checkbox-row"><input type="checkbox" class="addon" data-key="${esc(k)}">
              ${esc(a.label)}<span class="addon-price">+${money(a.price)}</span></label>`).join('')}
        </fieldset>
        <div class="price-breakdown" id="priceBreakdown"></div>
        <button class="btn btn-accent btn-lg btn-block" type="submit" id="submitBooking">Confirm Booking</button>
        <p class="muted small" style="text-align:center;margin-top:.5rem">Free cancellation while your booking is Pending.</p>
      </form>`);

    const recalc = () => renderQuote(car);
    $('#bookingForm').addEventListener('input', recalc);
    $('#bookingForm').addEventListener('submit', submitBooking(car));
    $('#b_pickup').addEventListener('change', e => { $('#b_return').min = e.target.value; });
    recalc();
  }

  function selectedAddons() {
    const o = {};
    $$('.addon').forEach(c => { o[c.dataset.key] = c.checked; });
    return o;
  }

  function renderQuote(car) {
    const p = $('#b_pickup').value, r = $('#b_return').value;
    const box = $('#priceBreakdown');
    if (!p || !r || r <= p) {
      box.innerHTML = '<p class="muted">Select valid pickup and return dates to calculate total.</p>';
      return;
    }
    const days = daysBetween(p, r);
    const addons = selectedAddons();
    const addonSum = Object.keys(site.addons).reduce((s, k) => s + (addons[k] ? site.addons[k].price : 0), 0);
    const subtotal = (car.daily_rate + addonSum) * days;
    const vatRate = site.vatRate ?? 10;
    const vat = subtotal * (vatRate / 100);
    box.innerHTML = `
      <div><span>${esc(car.brand)} ${esc(car.name)} × ${days} day${days > 1 ? 's' : ''}</span><span>${money(car.daily_rate * days)}</span></div>
      ${Object.keys(site.addons).filter(k => addons[k]).map(k => `<div><span>${esc(site.addons[k].label)}</span><span>${money(site.addons[k].price * days)}</span></div>`).join('')}
      <div><span>VAT (${vatRate}%)</span><span>${money(vat)}</span></div>
      <div class="total"><span>Total</span><span>${money(subtotal + vat)}</span></div>`;
  }

  function submitBooking(car) {
    return async (e) => {
      e.preventDefault();
      const btn = $('#submitBooking');
      const requiredIds = ['b_pickup', 'b_return', 'b_name', 'b_email', 'b_phone'];
      let valid = true;
      for (const id of requiredIds) {
        const el = $('#' + id);
        const ok = el.value.trim() !== '' && (id !== 'b_email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim()));
        el.classList.toggle('invalid', !ok);
        if (!ok) valid = false;
      }
      if ($('#b_return').value <= $('#b_pickup').value) {
        return toast('Return date must be after the pickup date.', 'error');
      }
      if (!valid) return toast('Please fill in all required fields correctly.', 'error');

      btn.disabled = true; btn.textContent = 'Processing…';
      try {
        const res = await fetch('/api/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            car_id: car.id,
            customer_name: $('#b_name').value,
            customer_email: $('#b_email').value,
            customer_phone: $('#b_phone').value,
            license_ref: $('#b_license').value,
            pickup_location: $('#b_location').value,
            pickup_date: $('#b_pickup').value,
            return_date: $('#b_return').value,
            add_ons: selectedAddons(),
            notes: $('#b_notes').value
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Booking failed.');
        showConfirmation(data.booking);
        loadCars();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Confirm Booking';
      }
    };
  }

  function showConfirmation(b) {
    const addonObj = JSON.parse(b.add_ons || '{}');
    const addonList = Object.entries(addonObj)
      .filter(([, v]) => v)
      .map(([k]) => (site.addons[k] ? site.addons[k].label : k))
      .join(', ') || 'None';
    openModal(`
      <div class="confirm">
        <div class="check-circle">✓</div>
        <h2>Booking Received!</h2>
        <p class="muted">Your reservation is <strong>Pending</strong> confirmation. Save your booking code:</p>
        <div class="big-code">${esc(b.booking_code)}</div>
        <div class="price-breakdown" style="text-align:left">
          <div><span>Vehicle</span><span>${esc(b.car_brand || '')} ${esc(b.car_name || '')}</span></div>
          <div><span>Branch</span><span>${esc(b.pickup_location || 'Main Office')}</span></div>
          <div><span>Dates</span><span>${esc(b.pickup_date)} → ${esc(b.return_date)} (${b.total_days}d)</span></div>
          <div><span>Add-ons</span><span>${esc(addonList)}</span></div>
          <div><span>VAT</span><span>${money(b.vat)}</span></div>
          <div class="total"><span>Total</span><span>${money(b.total_amount)}</span></div>
        </div>
        <button class="btn btn-accent btn-lg" id="confirmDoneBtn">Done</button>
      </div>`);
    $('#confirmDoneBtn').addEventListener('click', closeModal);
  }

  $('#lookupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('#lookupCode').value.trim().toUpperCase();
    const box = $('#lookupResult');
    box.innerHTML = '<p class="muted">Searching…</p>';
    try {
      const res = await fetch('/api/bookings/lookup/' + encodeURIComponent(code));
      const b = await res.json();
      if (!res.ok) throw new Error(b.error || 'Booking not found.');
      box.innerHTML = `
        <div class="lookup-card">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
            <h3>${esc(b.car_brand)} ${esc(b.car_name)}</h3>
            <span class="status-badge status-${esc(b.status)}">${esc(b.status)}</span>
          </div>
          <p class="muted">${esc(b.pickup_date)} → ${esc(b.return_date)} · ${b.total_days} day(s) · ${esc(b.pickup_location || 'Main Office')}</p>
          <p><strong>Reference:</strong> ${esc(b.booking_code)} · <strong>Total:</strong> ${money(b.total_amount)}</p>
        </div>`;
    } catch (err) {
      box.innerHTML = `<div class="lookup-card"><p class="muted">${esc(err.message)}</p></div>`;
    }
  });

  readQueryParams();
  loadSite().then(() => {
    const sym = site.settings.currency_symbol || '$';
    $('#priceLabel').textContent = sym + $('#priceFilter').value;
    loadCars();
  });
})();
