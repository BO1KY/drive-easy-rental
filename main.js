/* ===== DriveEasy Rentals — Shared Website Helpers & Book Now Logic ===== */
window.DriveEasy = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = {
    settings: {
      site_name: 'DriveEasy',
      site_accent: 'Rentals',
      tagline: 'Drive easy, travel far.',
      currency_symbol: 'N$',
      vat_rate: '15',
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
    vatRate: 15,
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
    const sym = state.settings.currency_symbol || 'N$';
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
    if (!car.is_available) return '<span class="badge booked">Booked</span>';
    const qty = Number(car.quantity) || 1;
    const left = car.units_available;
    return `<span class="badge available">${qty > 1 && left != null ? `${left} of ${qty} available` : 'Available'}</span>`;
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
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.4rem">
            <div class="car-title">${esc(car.brand)} ${esc(car.name)} <span class="year">· ${car.year}</span></div>
            <div class="rating-line">${car.review_count ? `<span class="stars">★</span> ${car.avg_rating} <span class="muted small">(${car.review_count})</span>` : '<span class="muted small">No reviews</span>'}</div>
          </div>
          <div class="car-meta">
            <span>${esc(car.transmission)}</span>
            <span>${esc(car.fuel_type)}</span>
            <span>${car.seats} seats</span>
            <span>${car.doors} doors</span>
            ${Number(car.quantity) > 1 ? `<span>${car.quantity} in fleet</span>` : ''}
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

  async function openDetails(id) {
    const car = pageState.cars.find(c => c.id === id);
    if (!car) return;
    const feats = (car.features || '').split(',').filter(Boolean).map(esc);
    const minAge = site.settings.min_driver_age || '21';
    openModal(`
      <img class="detail-img" src="${esc(car.image_url)}" alt="${esc(car.brand)} ${esc(car.name)}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:.5rem">
        <h2 id="modalTitle" style="margin-bottom:.3rem">${esc(car.brand)} ${esc(car.name)} <span class="muted" style="font-size:1rem">· ${car.year}</span></h2>
        <div class="rating-line" id="modalRatingSummary">${car.review_count ? `<span class="stars">★</span> ${car.avg_rating} / 5 (${car.review_count} review${car.review_count === 1 ? '' : 's'})` : 'No reviews yet'}</div>
      </div>
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
      </button>

      <div class="reviews-box">
        <h3 style="font-size:1.05rem;margin-bottom:.6rem">Client Ratings &amp; Reviews</h3>
        <div id="carReviewsList"><p class="muted small">Loading reviews…</p></div>
        ${site.customer ? `
          <form id="modalReviewForm" style="margin-top:1rem;padding-top:.8rem;border-top:1px solid var(--border)">
            <strong style="display:block;margin-bottom:.3rem">Leave Your Review</strong>
            <div class="star-picker" id="modalStarPicker">
              <button type="button" data-val="1" class="active">★</button>
              <button type="button" data-val="2" class="active">★</button>
              <button type="button" data-val="3" class="active">★</button>
              <button type="button" data-val="4" class="active">★</button>
              <button type="button" data-val="5" class="active">★</button>
            </div>
            <input type="hidden" id="mr_rating" value="5">
            <div class="field"><input id="mr_title" placeholder="Headline (optional)"></div>
            <div class="field"><textarea id="mr_comment" rows="2" required minlength="5" placeholder="Share your experience with this vehicle…"></textarea></div>
            <button type="submit" class="btn btn-sm">Submit Review</button>
          </form>
        ` : `<p class="muted small" style="margin-top:.8rem"><a href="register.html">Sign in or create an account</a> to rate and review this car.</p>`}
      </div>`);

    $('#detailsBookBtn').addEventListener('click', () => openBooking(id));

    async function refreshReviews() {
      try {
        const res = await fetch(`/api/cars/${id}/reviews`);
        const data = await res.json();
        $('#modalRatingSummary').innerHTML = data.review_count
          ? `<span class="stars">★</span> ${data.avg_rating} / 5 (${data.review_count} review${data.review_count === 1 ? '' : 's'})`
          : 'No reviews yet';
        $('#carReviewsList').innerHTML = data.reviews.length
          ? data.reviews.map(r => `
            <div class="review-item">
              <div class="review-head">
                <strong>${esc(r.reviewer_name)}</strong>
                <span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
              </div>
              ${r.title ? `<div style="font-weight:700;font-size:.9rem">${esc(r.title)}</div>` : ''}
              <p class="muted small">${esc(r.comment)}</p>
            </div>`).join('')
          : '<p class="muted small">Be the first to review this vehicle.</p>';
      } catch {
        $('#carReviewsList').innerHTML = '<p class="muted small">Could not load reviews.</p>';
      }
    }
    refreshReviews();

    if (site.customer && $('#modalReviewForm')) {
      $$('#modalStarPicker button').forEach(b => b.addEventListener('click', () => {
        const val = +b.dataset.val;
        $('#mr_rating').value = val;
        $$('#modalStarPicker button').forEach(x => x.classList.toggle('active', +x.dataset.val <= val));
      }));
      $('#modalReviewForm').addEventListener('submit', async e => {
        e.preventDefault();
        const comment = $('#mr_comment').value.trim();
        if (comment.length < 5) return toast('Please enter at least 5 characters for your review.', 'error');
        try {
          const res = await fetch(`/api/cars/${id}/reviews`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating: +$('#mr_rating').value, title: $('#mr_title').value.trim(), comment })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not submit review.');
          toast('Review published!');
          $('#mr_title').value = '';
          $('#mr_comment').value = '';
          await refreshReviews();
          loadCars();
        } catch (err) { toast(err.message, 'error'); }
      });
    }
  }

  let bookingItems = [];
  function collectBookingItems() {
    return $$('#bookingItems .booking-item').map(row => {
      const add_ons = {};
      $$('.bk_addon', row).forEach(input => { add_ons[input.dataset.key] = input.checked; });
      return { car_id: Number($('.bk_car', row).value), add_ons };
    });
  }
  function renderBookingItems() {
    const box = $('#bookingItems');
    if (!box) return;
    const options = pageState.cars.filter(c => c.is_available || bookingItems.some(i => i.car_id === c.id));
    box.innerHTML = bookingItems.map((item, idx) => `
      <div class="booking-item" data-index="${idx}">
        <div class="grid-2">
          <div class="field"><label>Vehicle ${idx + 1}</label>
            <select class="bk_car">
              ${options.map(c => `<option value="${c.id}" ${c.id === item.car_id ? 'selected' : ''}>${esc(c.brand)} ${esc(c.name)} — ${money(c.daily_rate)}/day</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Optional add-ons (per day)</label>
            ${Object.entries(site.addons).map(([k, a]) => `
              <label class="checkbox-row"><input type="checkbox" class="bk_addon" data-key="${esc(k)}" ${item.add_ons[k] ? 'checked' : ''}>
                ${esc(a.label)}<span class="addon-price">+${money(a.price)}</span></label>`).join('')}
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-remove-item="${idx}" ${bookingItems.length === 1 ? 'disabled' : ''}>Remove vehicle</button>
      </div>`).join('');

    $$('#bookingItems .bk_car').forEach(sel => sel.addEventListener('change', () => {
      const row = sel.closest('.booking-item');
      const idx = Number(row.dataset.index);
      bookingItems[idx].car_id = Number(sel.value);
      renderQuote();
    }));
    $$('#bookingItems .bk_addon').forEach(input => input.addEventListener('change', () => {
      const row = input.closest('.booking-item');
      const idx = Number(row.dataset.index);
      bookingItems[idx].add_ons[input.dataset.key] = input.checked;
      renderQuote();
    }));
    $$('#bookingItems [data-remove-item]').forEach(btn => btn.addEventListener('click', () => {
      if (bookingItems.length === 1) return;
      bookingItems.splice(Number(btn.dataset.removeItem), 1);
      renderBookingItems();
      renderQuote();
    }));
  }

  function openBooking(id) {
    const car = pageState.cars.find(c => c.id === id);
    if (!car || !car.is_available) return;
    const d = pageState.dates || { pickup: todayPlus(1), ret: todayPlus(4) };
    const c = site.customer || {};
    const locs = site.locations || ['Main Office'];
    bookingItems = [{ car_id: car.id, add_ons: {} }];

    openModal(`
      <h2 id="modalTitle">Book Your Vehicles</h2>
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
        <div class="field">
          <label>Vehicles</label>
          <div id="bookingItems"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="addBookingCar">+ Add another vehicle</button>
        </div>
        <div class="price-breakdown" id="priceBreakdown"></div>
        <button class="btn btn-accent btn-lg btn-block" type="submit" id="submitBooking">Confirm Booking</button>
        <p class="muted small" style="text-align:center;margin-top:.5rem">Free cancellation while your booking is Pending.</p>
      </form>`);

    renderBookingItems();
    $('#addBookingCar').addEventListener('click', () => {
      const firstAvailable = pageState.cars.find(c => c.is_available && !bookingItems.some(i => i.car_id === c.id));
      bookingItems.push({ car_id: firstAvailable ? firstAvailable.id : bookingItems[0].car_id, add_ons: {} });
      renderBookingItems();
      renderQuote();
    });
    $('#bookingForm').addEventListener('input', renderQuote);
    $('#bookingForm').addEventListener('submit', submitBooking);
    $('#b_pickup').addEventListener('change', e => { $('#b_return').min = e.target.value; });
    renderQuote();
  }

  function renderQuote() {
    const p = $('#b_pickup').value, r = $('#b_return').value;
    const box = $('#priceBreakdown');
    if (!p || !r || r <= p) {
      box.innerHTML = '<p class="muted">Select valid pickup and return dates to calculate total.</p>';
      return;
    }
    const days = daysBetween(p, r);
    const vatRate = site.vatRate ?? 15;
    let total = 0, subtotal = 0, vat = 0;
    const lines = [];
    collectBookingItems().forEach(item => {
      const car = pageState.cars.find(c => c.id === item.car_id);
      if (!car) return;
      const addonSum = Object.keys(site.addons).reduce((s, k) => s + (item.add_ons[k] ? site.addons[k].price : 0), 0);
      const amount = (car.daily_rate + addonSum) * days;
      total += amount;
      subtotal += amount / (1 + vatRate / 100);
      vat += amount - amount / (1 + vatRate / 100);
      lines.push(`<div><span>${esc(car.brand)} ${esc(car.name)} × ${days} day(s)</span><span>${money(amount)}</span></div>`);
      Object.keys(site.addons).filter(k => item.add_ons[k]).forEach(k => {
        lines.push(`<div><span>${esc(site.addons[k].label)}</span><span>${money(site.addons[k].price * days)}</span></div>`);
      });
    });
    box.innerHTML = `
      ${lines.join('')}
      <div><span>Subtotal (excl. VAT)</span><span>${money(subtotal)}</span></div>
      <div><span>VAT (${vatRate}%, included)</span><span>${money(vat)}</span></div>
      <div class="total"><span>Total (incl. VAT)</span><span>${money(total)}</span></div>`;
  }

  async function submitBooking(e) {
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
    if ($('#b_return').value <= $('#b_pickup').value) return toast('Return date must be after the pickup date.', 'error');
    if (!valid) return toast('Please fill in all required fields correctly.', 'error');
    const items = collectBookingItems();
    if (!items.length) return toast('Add at least one vehicle.', 'error');

    btn.disabled = true; btn.textContent = 'Processing…';
    try {
      const res = await fetch('/api/bookings/multiple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          customer_name: $('#b_name').value,
          customer_email: $('#b_email').value,
          customer_phone: $('#b_phone').value,
          license_ref: $('#b_license').value,
          pickup_location: $('#b_location').value,
          pickup_date: $('#b_pickup').value,
          return_date: $('#b_return').value,
          notes: $('#b_notes').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Booking failed.');
      showConfirmation(data.bookings);
      loadCars();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Confirm Booking';
    }
  }

  function showConfirmation(bookings) {
    const list = Array.isArray(bookings) ? bookings : [bookings];
    const total = list.reduce((s, b) => s + Number(b.total_amount || 0), 0);
    const codes = list.map(b => `<div class="big-code">${esc(b.booking_code)}</div>`).join('');
    const vehicles = list.map(b => {
      const addonObj = JSON.parse(b.add_ons || '{}');
      const addonList = Object.entries(addonObj).filter(([, v]) => v)
        .map(([k]) => (site.addons[k] ? site.addons[k].label : k)).join(', ') || 'None';
      return `<div><span>${esc(b.car_brand || '')} ${esc(b.car_name || '')}</span><span>${money(b.total_amount)}</span></div>
        <div class="muted small">Add-ons: ${esc(addonList)}</div>`;
    }).join('');
    openModal(`
      <div class="confirm">
        <div class="check-circle">✓</div>
        <h2>${list.length > 1 ? 'Bookings Received!' : 'Booking Received!'}</h2>
        <p class="muted">Your reservations are <strong>Pending</strong> confirmation. Save your booking codes:</p>
        ${codes}
        <div class="price-breakdown" style="text-align:left">
          ${vehicles}
          <div><span>Branch</span><span>${esc(list[0].pickup_location || 'Main Office')}</span></div>
          <div><span>Dates</span><span>${esc(list[0].pickup_date)} → ${esc(list[0].return_date)}</span></div>
          <div class="total"><span>Total</span><span>${money(total)}</span></div>
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

/* ===== Landing page controller (index.html only) ===== */
(() => {
  if (!$('#featuredGrid')) return;
  const { $, $$, esc, money, toast, todayPlus, loadSite } = window.DriveEasy;

  const pickup = $('#qsPickup');
  const ret = $('#qsReturn');
  pickup.min = todayPlus(0);
  pickup.value = todayPlus(1);
  ret.min = todayPlus(1);
  ret.value = todayPlus(4);
  pickup.addEventListener('change', () => {
    ret.min = pickup.value;
    if (ret.value <= pickup.value) ret.value = pickup.value;
  });
  $('#quickSearchForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!pickup.value || !ret.value || ret.value <= pickup.value) {
      return toast('Return date must be after pickup date.', 'error');
    }
    const query = new URLSearchParams({ pickup: pickup.value, ret: ret.value });
    const category = $('#qsCategory').value;
    if (category) query.set('category', category);
    window.location.href = 'book.html?' + query.toString();
  });

  function imageFallback(img, label) {
    if (!img) return;
    img.addEventListener('error', () => {
      img.src = `https://placehold.co/640x400/0f4c81/ffffff?text=${encodeURIComponent(label || 'Vehicle')}`;
    }, { once: true });
  }

  async function loadFeatured() {
    const grid = $('#featuredGrid');
    try {
      const res = await fetch('/api/cars?featured=1');
      let cars = await res.json();
      if (!cars.length) cars = (await (await fetch('/api/cars')).json()).slice(0, 4);
      if (!cars.length) {
        grid.innerHTML = '<div class="empty-state"><p>No vehicles currently listed.</p></div>';
        return [];
      }
      grid.innerHTML = cars.map(car => {
        const qty = Number(car.quantity) || 1;
        const available = car.status === 'available' && car.is_available;
        const badgeText = car.status !== 'available' ? esc(car.status)
          : available ? (qty > 1 && car.units_available != null ? `${car.units_available} of ${qty} available` : 'Available')
            : 'Booked';
        const badgeClass = car.status !== 'available' ? esc(car.status) : (available ? 'available' : 'booked');
        return `
          <article class="car-card">
            <div class="car-img">
              <img src="${esc(car.image_url)}" alt="${esc(car.brand)} ${esc(car.name)}" loading="lazy">
              <span class="badge ${badgeClass}">${badgeText}</span>
              <span class="badge category">${esc(car.category)}</span>
            </div>
            <div class="car-body">
              <div class="car-title">${esc(car.brand)} ${esc(car.name)} <span class="year">· ${car.year}</span></div>
              <div class="rating-line">${car.review_count
                ? `<span class="stars">★</span> ${car.avg_rating} <span class="muted small">(${car.review_count})</span>`
                : '<span class="muted small">No reviews yet</span>'}</div>
              <div class="car-meta">
                <span>${esc(car.transmission)}</span>
                <span>${esc(car.fuel_type)}</span>
                <span>${car.seats} seats</span>
                ${qty > 1 ? `<span>${qty} in fleet</span>` : ''}
              </div>
              <p class="car-features">${esc(car.description || '')}</p>
              <div class="car-foot">
                <div class="price">${money(car.daily_rate)} <small>/ day · VAT included</small></div>
                <a class="btn btn-sm btn-accent" href="book.html?carId=${car.id}">Book Now</a>
              </div>
            </div>
          </article>`;
      }).join('');
      $$('.car-img img', grid).forEach(img => imageFallback(img, img.alt));
      return cars;
    } catch {
      grid.innerHTML = '<div class="empty-state"><p>Unable to load featured vehicles.</p></div>';
      return [];
    }
  }

  async function loadReviews(cars) {
    const box = $('#homeReviews');
    if (!box || !cars.length) {
      if (box) box.innerHTML = '<div class="empty-state"><p>No customer reviews yet — be the first to share your experience.</p></div>';
      return;
    }
    try {
      const results = await Promise.all(cars.slice(0, 4).map(async car => {
        const res = await fetch(`/api/cars/${car.id}/reviews`);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.reviews || []).map(review => ({ ...review, carLabel: `${car.brand} ${car.name}` }));
      }));
      const reviews = results.flat().slice(0, 3);
      if (!reviews.length) {
        box.innerHTML = '<div class="empty-state"><p>No customer reviews yet — be the first to share your experience.</p></div>';
        return;
      }
      box.innerHTML = reviews.map(review => `
        <article class="home-review">
          <div class="stars" aria-label="${review.rating} out of 5 stars">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</div>
          ${review.title ? `<h3>${esc(review.title)}</h3>` : ''}
          <p>${esc(review.comment)}</p>
          <cite>${esc(review.reviewer_name)} · ${esc(review.carLabel)}</cite>
        </article>`).join('');
    } catch {
      box.innerHTML = '<div class="empty-state"><p>Reviews are unavailable right now.</p></div>';
    }
  }

  function setupReveal() {
    const items = $$('.home .reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach(item => item.classList.add('visible'));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    items.forEach(item => observer.observe(item));
  }

  loadSite().then(async () => {
    const cars = await loadFeatured();
    await loadReviews(cars);
    setupReveal();
  });
})();
