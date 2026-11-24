// server.js — DriveEasy Car Rental full-stack multi-page website & admin control API
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { db, hashPassword, verifyPassword, getSettings, DEFAULT_SETTINGS } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const STATIC_DIR = __dirname;

app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'driveeasy-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12, httpOnly: true, sameSite: 'lax' }
}));

// ---------- block direct HTTP access to backend/internal files ----------
const BLOCKED_PATHS = new Set(['/server.js', '/db.js', '/package.json', '/package-lock.json', '/readme.md']);
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    BLOCKED_PATHS.has(p) ||
    p.startsWith('/node_modules') ||
    p.startsWith('/.') ||
    p.endsWith('.db') ||
    p.endsWith('.db-wal') ||
    p.endsWith('.db-shm')
  ) {
    return res.status(404).send('Not found');
  }
  next();
});

// ---------- clean page routes ----------
const PAGES = {
  '/': 'index.html',
  '/about': 'about.html',
  '/contact': 'contact.html',
  '/book': 'book.html',
  '/register': 'register.html',
  '/login': 'register.html',
  '/account': 'register.html',
  '/admin': 'admin.html'
};
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res) => res.sendFile(path.join(STATIC_DIR, file)));
}
app.use(express.static(STATIC_DIR));

// ---------- constants ----------
const CATEGORIES = ['Sedan', 'SUV', 'Hatchback', 'Van/Truck', 'Luxury'];
const CAR_STATUSES = ['available', 'maintenance', 'unavailable'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'active', 'completed', 'cancelled'];
const MESSAGE_STATUSES = ['new', 'read', 'replied', 'archived'];

// ---------- helpers ----------
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
const daysBetween = (a, b) => Math.max(1, Math.ceil((new Date(b) - new Date(a)) / 86400000));
const round2 = (n) => Math.round(n * 100) / 100;
const clean = (row) => (row ? { ...row } : null);

function getAddonsConfig(settings) {
  return {
    child_seat: { label: 'Child Seat', price: Math.max(0, Number(settings.addon_child_seat) || 0) },
    additional_driver: { label: 'Additional Driver', price: Math.max(0, Number(settings.addon_additional_driver) || 0) },
    insurance: { label: 'Full Insurance', price: Math.max(0, Number(settings.addon_insurance) || 0) }
  };
}

function overlaps(carId, pickup, ret) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM bookings
    WHERE car_id = ? AND status IN ('pending','confirmed','active')
      AND pickup_date < ? AND return_date > ?`).get(carId, ret, pickup);
  return row.n > 0;
}

function priceQuote(car, pickup, ret, addOns, settings) {
  const days = daysBetween(pickup, ret);
  const addonsCfg = getAddonsConfig(settings);
  let addonTotal = 0;
  for (const key of Object.keys(addonsCfg)) {
    if (addOns[key]) addonTotal += addonsCfg[key].price;
  }
  const vatRate = Math.max(0, Number(settings.vat_rate) || 0) / 100;
  const subtotal = round2((car.daily_rate + addonTotal) * days);
  const vat = round2(subtotal * vatRate);
  return { days, subtotal, vat, total: round2(subtotal + vat) };
}

function bookingCode() {
  return 'CR-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ---------- auth middlewares ----------
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'Admin login required.' });
}

function requireCustomer(req, res, next) {
  if (!req.session || !req.session.customerId) {
    return res.status(401).json({ error: 'Please sign in to your account.' });
  }
  const cust = db.prepare('SELECT id, full_name, email, phone, license_ref, address, status, created_at FROM customers WHERE id = ?').get(req.session.customerId);
  if (!cust || cust.status !== 'active') {
    delete req.session.customerId;
    return res.status(401).json({ error: 'Account unavailable or suspended.' });
  }
  req.customer = clean(cust);
  next();
}

// ================= PUBLIC SITE CONFIG =================
app.get('/api/site', (req, res) => {
  const settings = getSettings();
  let customer = null;
  if (req.session && req.session.customerId) {
    const c = db.prepare('SELECT id, full_name, email, phone, license_ref, address, status FROM customers WHERE id = ?').get(req.session.customerId);
    if (c && c.status === 'active') customer = clean(c);
  }
  res.json({
    settings,
    addons: getAddonsConfig(settings),
    vat_rate: Math.max(0, Number(settings.vat_rate) || 0),
    locations: String(settings.pickup_locations || 'Main Office').split(',').map(s => s.trim()).filter(Boolean),
    customer
  });
});

// ================= PUBLIC CARS & BOOKINGS =================
app.get('/api/cars', (req, res) => {
  const { category, transmission, minPrice, maxPrice, seats, search, pickup, ret, featured } = req.query;
  const where = ['1=1'];
  const params = [];

  if (category && CATEGORIES.includes(category)) { where.push('category = ?'); params.push(category); }
  if (transmission && ['Automatic', 'Manual'].includes(transmission)) { where.push('transmission = ?'); params.push(transmission); }
  if (seats && Number.isInteger(+seats)) { where.push('seats >= ?'); params.push(+seats); }
  if (minPrice && !isNaN(+minPrice)) { where.push('daily_rate >= ?'); params.push(+minPrice); }
  if (maxPrice && !isNaN(+maxPrice)) { where.push('daily_rate <= ?'); params.push(+maxPrice); }
  if (featured === '1') { where.push('featured = 1'); }
  if (search && search.trim()) {
    where.push('(name LIKE ? OR brand LIKE ? OR description LIKE ?)');
    const q = `%${search.trim()}%`;
    params.push(q, q, q);
  }

  let availabilityJoin = '';
  if (isDate(pickup) && isDate(ret) && ret > pickup) {
    availabilityJoin = `AND c.id NOT IN (
      SELECT car_id FROM bookings
      WHERE status IN ('pending','confirmed','active')
        AND pickup_date < ? AND return_date > ?)`;
    params.push(ret, pickup);
  }

  const rows = db.prepare(`
    SELECT c.*, CASE WHEN EXISTS (
        SELECT 1 FROM bookings b WHERE b.car_id = c.id
          AND b.status IN ('pending','confirmed','active')
          AND b.pickup_date <= date('now') AND b.return_date >= date('now')
      ) THEN 1 ELSE 0 END AS booked_now
    FROM cars c WHERE ${where.join(' AND ')} ${availabilityJoin}
    ORDER BY c.featured DESC, c.daily_rate ASC`).all(...params);

  const available = (car) => {
    if (car.status !== 'available') return false;
    if (isDate(pickup) && isDate(ret) && ret > pickup) return !overlaps(car.id, pickup, ret);
    return !car.booked_now;
  };
  res.json(rows.map(({ booked_now, ...car }) => ({ ...car, is_available: available(car) })));
});

app.get('/api/cars/:id', (req, res) => {
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const busyRanges = db.prepare(`SELECT pickup_date, return_date, status FROM bookings
    WHERE car_id = ? AND status IN ('pending','confirmed','active')
      AND return_date >= date('now') ORDER BY pickup_date`).all(car.id);
  const bookedNow = busyRanges.some(r => r.pickup_date <= new Date().toISOString().slice(0, 10));
  res.json({ ...car, is_available: car.status === 'available' && !bookedNow, busy_ranges: busyRanges.map(clean) });
});

app.post('/api/bookings', (req, res) => {
  const b = req.body || {};
  const required = ['car_id', 'customer_name', 'customer_email', 'customer_phone', 'pickup_date', 'return_date'];
  for (const f of required) {
    if (!b[f] || String(b[f]).trim() === '') return bad(res, `Missing required field: ${f}`);
  }
  if (!isEmail(b.customer_email)) return bad(res, 'Invalid email address.');
  if (!isDate(b.pickup_date) || !isDate(b.return_date)) return bad(res, 'Invalid dates. Use YYYY-MM-DD.');
  if (b.return_date <= b.pickup_date) return bad(res, 'Return date must be after the pickup date.');

  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(b.car_id);
  if (!car) return bad(res, 'Car not found.', 404);
  if (car.status !== 'available') return bad(res, `This car is currently ${car.status} and cannot be booked.`);

  const settings = getSettings();
  const addonsCfg = getAddonsConfig(settings);
  const addOns = {};
  for (const k of Object.keys(addonsCfg)) addOns[k] = !!(b.add_ons && b.add_ons[k]);

  const customerId = req.session && req.session.customerId ? req.session.customerId : null;

  const tx = db.transaction(() => {
    if (overlaps(car.id, b.pickup_date, b.return_date)) {
      const err = new Error('Sorry, this car was just booked for the selected dates. Please pick different dates.');
      err.status = 409;
      throw err;
    }
    const q = priceQuote(car, b.pickup_date, b.return_date, addOns, settings);
    const info = db.prepare(`INSERT INTO bookings
      (booking_code, car_id, customer_id, customer_name, customer_email, customer_phone, license_ref,
       pickup_location, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, status, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(
      bookingCode(), car.id, customerId,
      String(b.customer_name).trim(), String(b.customer_email).trim().toLowerCase(), String(b.customer_phone).trim(),
      String(b.license_ref || '').trim(), String(b.pickup_location || 'Main Office').trim(),
      b.pickup_date, b.return_date, q.days, JSON.stringify(addOns),
      q.subtotal, q.vat, q.total, String(b.notes || '').trim()
    );
    return { id: Number(info.lastInsertRowid), ...q };
  });

  try {
    const result = tx();
    const booking = db.prepare(`SELECT b.*, c.name AS car_name, c.brand AS car_brand
      FROM bookings b JOIN cars c ON c.id = b.car_id WHERE b.id = ?`).get(result.id);
    res.status(201).json({
      booking: clean(booking),
      quote: { days: result.days, subtotal: result.subtotal, vat: result.vat, total: result.total }
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Booking failed.' });
  }
});

app.get('/api/bookings/lookup/:code', (req, res) => {
  const row = db.prepare(`SELECT b.*, c.name AS car_name, c.brand AS car_brand, c.category, c.image_url
    FROM bookings b JOIN cars c ON c.id = b.car_id WHERE b.booking_code = ?`).get(String(req.params.code).trim().toUpperCase());
  if (!row) return bad(res, 'Booking not found.', 404);
  res.json(clean(row));
});

// ================= PUBLIC CONTACT MESSAGES =================
app.post('/api/contact', (req, res) => {
  const { name, email, phone, subject, message } = req.body || {};
  if (!name || String(name).trim().length < 2) return bad(res, 'Please enter your name.');
  if (!isEmail(email)) return bad(res, 'Please enter a valid email address.');
  if (!subject || String(subject).trim().length < 2) return bad(res, 'Please enter a subject.');
  if (!message || String(message).trim().length < 10) return bad(res, 'Message must be at least 10 characters.');

  const info = db.prepare(`INSERT INTO contact_messages (name, email, phone, subject, message)
    VALUES (?,?,?,?,?)`).run(
    String(name).trim(),
    String(email).trim().toLowerCase(),
    String(phone || '').trim(),
    String(subject).trim(),
    String(message).trim()
  );
  res.status(201).json({ id: Number(info.lastInsertRowid), ok: true });
});

// ================= CUSTOMER AUTH & PORTAL =================
app.post('/api/auth/register', (req, res) => {
  const { full_name, email, phone, license_ref, address, password } = req.body || {};
  if (!full_name || String(full_name).trim().length < 2) return bad(res, 'Full name is required.');
  if (!isEmail(email)) return bad(res, 'Valid email address is required.');
  if (!phone || String(phone).trim().length < 5) return bad(res, 'Phone number is required.');
  if (!password || String(password).length < 6) return bad(res, 'Password must be at least 6 characters.');

  const normalizedEmail = String(email).trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM customers WHERE email = ?').get(normalizedEmail);
  if (exists) return bad(res, 'An account with this email already exists.', 409);

  const info = db.prepare(`INSERT INTO customers (full_name, email, phone, license_ref, address, password_hash)
    VALUES (?,?,?,?,?,?)`).run(
    String(full_name).trim(),
    normalizedEmail,
    String(phone).trim(),
    String(license_ref || '').trim(),
    String(address || '').trim(),
    hashPassword(String(password))
  );
  const customerId = Number(info.lastInsertRowid);
  req.session.customerId = customerId;
  const cust = db.prepare('SELECT id, full_name, email, phone, license_ref, address, status, created_at FROM customers WHERE id = ?').get(customerId);
  res.status(201).json({ customer: clean(cust) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const cust = db.prepare('SELECT * FROM customers WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!cust || !verifyPassword(String(password || ''), cust.password_hash)) {
    return bad(res, 'Invalid email or password.', 401);
  }
  if (cust.status !== 'active') return bad(res, 'Your account has been suspended. Please contact support.', 403);
  req.session.customerId = cust.id;
  const { password_hash, ...safe } = cust;
  res.json({ customer: safe });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) delete req.session.customerId;
  res.json({ ok: true });
});

app.get('/api/auth/me', requireCustomer, (req, res) => {
  const bookings = db.prepare(`SELECT b.*, c.name AS car_name, c.brand AS car_brand, c.image_url
    FROM bookings b JOIN cars c ON c.id = b.car_id
    WHERE b.customer_id = ? OR LOWER(b.customer_email) = LOWER(?)
    ORDER BY b.created_at DESC`).all(req.customer.id, req.customer.email);
  res.json({ customer: req.customer, bookings: bookings.map(clean) });
});

app.put('/api/auth/profile', requireCustomer, (req, res) => {
  const { full_name, phone, license_ref, address, new_password } = req.body || {};
  if (!full_name || String(full_name).trim().length < 2) return bad(res, 'Full name is required.');
  if (!phone || String(phone).trim().length < 5) return bad(res, 'Phone number is required.');
  if (new_password && String(new_password).length < 6) return bad(res, 'New password must be at least 6 characters.');

  db.prepare(`UPDATE customers SET full_name = ?, phone = ?, license_ref = ?, address = ? WHERE id = ?`).run(
    String(full_name).trim(),
    String(phone).trim(),
    String(license_ref || '').trim(),
    String(address || '').trim(),
    req.customer.id
  );
  if (new_password) {
    db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hashPassword(String(new_password)), req.customer.id);
  }
  const updated = db.prepare('SELECT id, full_name, email, phone, license_ref, address, status, created_at FROM customers WHERE id = ?').get(req.customer.id);
  res.json({ customer: clean(updated) });
});

app.patch('/api/my-bookings/:id/cancel', requireCustomer, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return bad(res, 'Booking not found.', 404);
  if (b.customer_id !== req.customer.id && b.customer_email.toLowerCase() !== req.customer.email.toLowerCase()) {
    return bad(res, 'Not authorized to cancel this booking.', 403);
  }
  if (b.status !== 'pending') return bad(res, 'Only pending bookings can be cancelled online.');
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
  res.json({ ok: true, status: 'cancelled' });
});

// ================= ADMIN AUTH =================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
  if (!admin || !verifyPassword(String(password || ''), admin.password_hash)) {
    return bad(res, 'Invalid username or password.', 401);
  }
  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  res.json({ username: admin.username });
});

app.post('/api/admin/logout', (req, res) => {
  if (req.session) {
    delete req.session.adminId;
    delete req.session.adminUsername;
  }
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ username: req.session.adminUsername });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!admin || !verifyPassword(String(current_password || ''), admin.password_hash)) {
    return bad(res, 'Current password is incorrect.', 400);
  }
  if (!new_password || String(new_password).length < 6) {
    return bad(res, 'New password must be at least 6 characters.');
  }
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(String(new_password)), admin.id);
  res.json({ ok: true });
});

// ================= ADMIN: DASHBOARD =================
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  const recentBookings = db.prepare(`SELECT b.id, b.booking_code, b.customer_name, b.total_amount, b.status, b.pickup_date, c.brand AS car_brand, c.name AS car_name
    FROM bookings b JOIN cars c ON c.id = b.car_id ORDER BY b.created_at DESC LIMIT 5`).all().map(clean);
  const recentMessages = db.prepare(`SELECT id, name, subject, status, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 5`).all().map(clean);
  res.json({
    total_cars: one('SELECT COUNT(*) AS n FROM cars'),
    available_cars: one("SELECT COUNT(*) AS n FROM cars WHERE status = 'available'"),
    maintenance_cars: one("SELECT COUNT(*) AS n FROM cars WHERE status = 'maintenance'"),
    total_bookings: one('SELECT COUNT(*) AS n FROM bookings'),
    pending_bookings: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending'"),
    active_bookings: one("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('confirmed','active')"),
    total_customers: one('SELECT COUNT(*) AS n FROM customers'),
    unread_messages: one("SELECT COUNT(*) AS n FROM contact_messages WHERE status = 'new'"),
    revenue: db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS n FROM bookings WHERE status IN ('confirmed','active','completed')`).get().n,
    recent_bookings: recentBookings,
    recent_messages: recentMessages
  });
});

// ================= ADMIN: CARS CRUD =================
app.get('/api/admin/cars', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM bookings b WHERE b.car_id = c.id AND b.status IN ('pending','confirmed','active')
        AND b.return_date >= date('now')) AS active_bookings
    FROM cars c ORDER BY c.id DESC`).all();
  res.json(rows.map(clean));
});

function validateCar(b, partial = false) {
  const errs = [];
  if (!partial || b.name !== undefined) { if (!b.name || String(b.name).trim().length < 2) errs.push('Name is required.'); }
  if (!partial || b.brand !== undefined) { if (!b.brand || String(b.brand).trim().length < 2) errs.push('Brand is required.'); }
  if (!partial || b.category !== undefined) { if (!CATEGORIES.includes(b.category)) errs.push('Invalid category.'); }
  if (!partial || b.year !== undefined) { const y = +b.year; if (!Number.isInteger(y) || y < 1990 || y > new Date().getFullYear() + 1) errs.push('Invalid year.'); }
  if (!partial || b.daily_rate !== undefined) { const r = +b.daily_rate; if (isNaN(r) || r < 0) errs.push('Daily rate must be a non-negative number.'); }
  if (!partial || b.transmission !== undefined) { if (!['Automatic', 'Manual'].includes(b.transmission)) errs.push('Invalid transmission.'); }
  if (!partial || b.fuel_type !== undefined) { if (!b.fuel_type || String(b.fuel_type).trim() === '') errs.push('Fuel type is required.'); }
  if (!partial || b.seats !== undefined) { const s = +b.seats; if (!Number.isInteger(s) || s < 1 || s > 60) errs.push('Invalid seats.'); }
  if (b.doors !== undefined) { const d = +b.doors; if (!Number.isInteger(d) || d < 1 || d > 10) errs.push('Invalid doors.'); }
  if (b.status !== undefined && !CAR_STATUSES.includes(b.status)) errs.push('Invalid status.');
  return errs;
}

app.post('/api/admin/cars', requireAdmin, (req, res) => {
  const b = req.body || {};
  const errs = validateCar(b);
  if (errs.length) return bad(res, errs.join(' '));
  const info = db.prepare(`INSERT INTO cars (name, brand, category, year, daily_rate, transmission, fuel_type, seats, doors, image_url, description, features, status, featured)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    String(b.name).trim(), String(b.brand).trim(), b.category, +b.year, +b.daily_rate, b.transmission,
    String(b.fuel_type).trim(), +b.seats, +(b.doors || 4), String(b.image_url || '').trim(),
    String(b.description || '').trim(), String(b.features || '').trim(),
    CAR_STATUSES.includes(b.status) ? b.status : 'available', b.featured ? 1 : 0
  );
  res.status(201).json(clean(db.prepare('SELECT * FROM cars WHERE id = ?').get(Number(info.lastInsertRowid))));
});

app.put('/api/admin/cars/:id', requireAdmin, (req, res) => {
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const b = { ...car, ...req.body };
  const errs = validateCar(b);
  if (errs.length) return bad(res, errs.join(' '));
  db.prepare(`UPDATE cars SET name=?, brand=?, category=?, year=?, daily_rate=?, transmission=?, fuel_type=?, seats=?, doors=?, image_url=?, description=?, features=?, status=?, featured=? WHERE id=?`).run(
    String(b.name).trim(), String(b.brand).trim(), b.category, +b.year, +b.daily_rate, b.transmission,
    String(b.fuel_type).trim(), +b.seats, +b.doors, String(b.image_url || '').trim(),
    String(b.description || '').trim(), String(b.features || '').trim(),
    CAR_STATUSES.includes(b.status) ? b.status : car.status, b.featured ? 1 : 0, car.id
  );
  res.json(clean(db.prepare('SELECT * FROM cars WHERE id = ?').get(car.id)));
});

app.patch('/api/admin/cars/:id/status', requireAdmin, (req, res) => {
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const status = req.body.status;
  if (!CAR_STATUSES.includes(status)) return bad(res, 'Invalid status.');
  db.prepare('UPDATE cars SET status = ? WHERE id = ?').run(status, car.id);
  res.json({ ok: true, status });
});

app.patch('/api/admin/cars/:id/featured', requireAdmin, (req, res) => {
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const featured = req.body.featured ? 1 : 0;
  db.prepare('UPDATE cars SET featured = ? WHERE id = ?').run(featured, car.id);
  res.json({ ok: true, featured });
});

app.delete('/api/admin/cars/:id', requireAdmin, (req, res) => {
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const active = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE car_id = ? AND status IN ('pending','confirmed','active')`).get(car.id).n;
  if (active > 0) return bad(res, `Cannot delete: ${active} active booking(s) exist for this car. Cancel or complete them first.`, 409);
  db.prepare('DELETE FROM cars WHERE id = ?').run(car.id);
  res.json({ ok: true });
});

// ================= ADMIN: BOOKINGS =================
app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const { status, q } = req.query;
  const where = ['1=1'];
  const params = [];
  if (status && BOOKING_STATUSES.includes(status)) { where.push('b.status = ?'); params.push(status); }
  if (q && q.trim()) {
    where.push('(b.booking_code LIKE ? OR b.customer_name LIKE ? OR b.customer_email LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`SELECT b.*, c.name AS car_name, c.brand AS car_brand, c.image_url FROM bookings b
    JOIN cars c ON c.id = b.car_id WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC`).all(...params);
  res.json(rows.map(clean));
});

app.patch('/api/admin/bookings/:id/status', requireAdmin, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return bad(res, 'Booking not found.', 404);
  const status = req.body.status;
  if (!BOOKING_STATUSES.includes(status)) return bad(res, 'Invalid status.');
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
  res.json({ ok: true, status });
});

app.put('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return bad(res, 'Booking not found.', 404);
  const { status, pickup_location, notes } = req.body || {};
  const nextStatus = status && BOOKING_STATUSES.includes(status) ? status : booking.status;
  db.prepare('UPDATE bookings SET status = ?, pickup_location = ?, notes = ? WHERE id = ?').run(
    nextStatus,
    pickup_location !== undefined ? String(pickup_location).trim() : booking.pickup_location,
    notes !== undefined ? String(notes).trim() : booking.notes,
    booking.id
  );
  res.json(clean(db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id)));
});

app.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return bad(res, 'Booking not found.', 404);
  db.prepare('DELETE FROM bookings WHERE id = ?').run(booking.id);
  res.json({ ok: true });
});

// ================= ADMIN: CUSTOMERS =================
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  const q = req.query.q ? `%${req.query.q.trim()}%` : null;
  const sql = q
    ? `SELECT c.id, c.full_name, c.email, c.phone, c.license_ref, c.address, c.status, c.created_at,
         (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id OR LOWER(b.customer_email) = LOWER(c.email)) AS bookings_count
       FROM customers c WHERE c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? ORDER BY c.created_at DESC`
    : `SELECT c.id, c.full_name, c.email, c.phone, c.license_ref, c.address, c.status, c.created_at,
         (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id OR LOWER(b.customer_email) = LOWER(c.email)) AS bookings_count
       FROM customers c ORDER BY c.created_at DESC`;
  const rows = q ? db.prepare(sql).all(q, q, q) : db.prepare(sql).all();
  res.json(rows.map(clean));
});

app.patch('/api/admin/customers/:id/status', requireAdmin, (req, res) => {
  const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!cust) return bad(res, 'Customer not found.', 404);
  const status = req.body.status;
  if (!['active', 'suspended'].includes(status)) return bad(res, 'Invalid customer status.');
  db.prepare('UPDATE customers SET status = ? WHERE id = ?').run(status, cust.id);
  res.json({ ok: true, status });
});

app.delete('/api/admin/customers/:id', requireAdmin, (req, res) => {
  const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!cust) return bad(res, 'Customer not found.', 404);
  db.prepare('DELETE FROM customers WHERE id = ?').run(cust.id);
  res.json({ ok: true });
});

// ================= ADMIN: CONTACT MESSAGES =================
app.get('/api/admin/messages', requireAdmin, (req, res) => {
  const { status } = req.query;
  const rows = status && MESSAGE_STATUSES.includes(status)
    ? db.prepare('SELECT * FROM contact_messages WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
  res.json(rows.map(clean));
});

app.patch('/api/admin/messages/:id', requireAdmin, (req, res) => {
  const msg = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(req.params.id);
  if (!msg) return bad(res, 'Message not found.', 404);
  const { status, admin_notes } = req.body || {};
  const nextStatus = status && MESSAGE_STATUSES.includes(status) ? status : msg.status;
  const nextNotes = admin_notes !== undefined ? String(admin_notes).trim() : msg.admin_notes;
  db.prepare('UPDATE contact_messages SET status = ?, admin_notes = ? WHERE id = ?').run(nextStatus, nextNotes, msg.id);
  res.json(clean(db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(msg.id)));
});

app.delete('/api/admin/messages/:id', requireAdmin, (req, res) => {
  const msg = db.prepare('SELECT id FROM contact_messages WHERE id = ?').get(req.params.id);
  if (!msg) return bad(res, 'Message not found.', 404);
  db.prepare('DELETE FROM contact_messages WHERE id = ?').run(msg.id);
  res.json({ ok: true });
});

// ================= ADMIN: SITE SETTINGS ("CONTROL EVERYTHING") =================
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(getSettings());
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  const upsert = db.prepare(`INSERT INTO site_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
  db.transaction(() => {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (body[key] !== undefined) {
        upsert.run(key, String(body[key]).trim());
      }
    }
  })();
  res.json(getSettings());
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`DriveEasy Rentals website running at http://localhost:${PORT}`);
  console.log(`Admin Control Center: http://localhost:${PORT}/admin.html  (admin / admin123)`);
});
