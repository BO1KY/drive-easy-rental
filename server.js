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
  '/profile': 'register.html',
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
  const total = round2((car.daily_rate + addonTotal) * days);
  const subtotal = round2(total / (1 + vatRate));
  const vat = round2(total - subtotal);
  return { days, subtotal, vat, total };
}

function bookingCode() {
  return 'CR-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ---------- auth middlewares ----------
const ROLE_PERMISSIONS = {
  admin: ['*'],
  manager: ['cars:write', 'bookings:write', 'quotes:write', 'quotes:delete',
    'invoices:write', 'invoices:delete', 'messages:write', 'reviews:write',
    'customers:write', 'settings:write'],
  staff: ['quotes:write', 'invoices:write', 'bookings:approve']
};
function sessionActor(req) {
  if (!req.session) return null;
  if (req.session.adminId) {
    return { id: req.session.adminId, name: req.session.adminUsername || 'admin', role: 'admin' };
  }
  if (req.session.staffId) {
    const s = db.prepare('SELECT id, full_name, role, status FROM staff_accounts WHERE id = ?').get(req.session.staffId);
    if (s && s.status === 'active') return { id: s.id, name: s.full_name, role: s.role };
  }
  return null;
}
function requireAdmin(req, res, next) {
  if (sessionActor(req)) return next();
  return res.status(401).json({ error: 'Admin login required.' });
}
function requirePerm(perm) {
  return (req, res, next) => {
    const a = sessionActor(req);
    if (!a) return res.status(401).json({ error: 'Admin login required.' });
    const perms = ROLE_PERMISSIONS[a.role] || [];
    if (!perms.includes('*') && !perms.includes(perm)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
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
    SELECT c.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM bookings b WHERE b.car_id = c.id
          AND b.status IN ('pending','confirmed','active')
          AND b.pickup_date <= date('now') AND b.return_date >= date('now')
      ) THEN 1 ELSE 0 END AS booked_now,
      COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.car_id = c.id AND r.status = 'published'), 0) AS avg_rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.car_id = c.id AND r.status = 'published') AS review_count
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
  const car = db.prepare(`SELECT c.*,
    COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.car_id = c.id AND r.status = 'published'), 0) AS avg_rating,
    (SELECT COUNT(*) FROM reviews r WHERE r.car_id = c.id AND r.status = 'published') AS review_count
    FROM cars c WHERE c.id = ?`).get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const busyRanges = db.prepare(`SELECT pickup_date, return_date, status FROM bookings
    WHERE car_id = ? AND status IN ('pending','confirmed','active')
      AND return_date >= date('now') ORDER BY pickup_date`).all(car.id);
  const bookedNow = busyRanges.some(r => r.pickup_date <= new Date().toISOString().slice(0, 10));
  res.json({ ...car, is_available: car.status === 'available' && !bookedNow, busy_ranges: busyRanges.map(clean) });
});

app.get('/api/cars/:id/reviews', (req, res) => {
  const car = db.prepare('SELECT id FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const reviews = db.prepare(`SELECT id, car_id, reviewer_name, rating, title, comment, created_at
    FROM reviews WHERE car_id = ? AND status = 'published' ORDER BY created_at DESC`).all(car.id).map(clean);
  const summary = db.prepare(`SELECT COALESCE(ROUND(AVG(rating), 1), 0) AS avg_rating, COUNT(*) AS review_count
    FROM reviews WHERE car_id = ? AND status = 'published'`).get(car.id);
  res.json({ ...clean(summary), reviews });
});

app.post('/api/cars/:id/reviews', requireCustomer, (req, res) => {
  const car = db.prepare('SELECT id, brand, name FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const { rating, title, comment } = req.body || {};
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return bad(res, 'Rating must be between 1 and 5 stars.');
  if (!comment || String(comment).trim().length < 5) return bad(res, 'Review comment must be at least 5 characters.');

  const existing = db.prepare('SELECT id FROM reviews WHERE car_id = ? AND customer_id = ?').get(car.id, req.customer.id);
  let reviewId;
  if (existing) {
    db.prepare(`UPDATE reviews SET reviewer_name = ?, rating = ?, title = ?, comment = ?, status = 'published', created_at = datetime('now') WHERE id = ?`).run(
      req.customer.full_name, r, String(title || '').trim(), String(comment).trim(), existing.id
    );
    reviewId = existing.id;
  } else {
    const info = db.prepare(`INSERT INTO reviews (car_id, customer_id, reviewer_name, rating, title, comment, status)
      VALUES (?,?,?,?,?,?,'published')`).run(
      car.id, req.customer.id, req.customer.full_name, r, String(title || '').trim(), String(comment).trim()
    );
    reviewId = Number(info.lastInsertRowid);
  }
  const summary = db.prepare(`SELECT COALESCE(ROUND(AVG(rating), 1), 0) AS avg_rating, COUNT(*) AS review_count
    FROM reviews WHERE car_id = ? AND status = 'published'`).get(car.id);
  const review = db.prepare('SELECT id, car_id, reviewer_name, rating, title, comment, created_at FROM reviews WHERE id = ?').get(reviewId);
  res.status(existing ? 200 : 201).json({ review: clean(review), summary: clean(summary) });
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
  const myReviews = db.prepare(`SELECT r.*, c.brand AS car_brand, c.name AS car_name
    FROM reviews r JOIN cars c ON c.id = r.car_id
    WHERE r.customer_id = ? ORDER BY r.created_at DESC`).all(req.customer.id);
  res.json({ customer: req.customer, bookings: bookings.map(clean), reviews: myReviews.map(clean) });
});

app.put('/api/auth/profile', requireCustomer, (req, res) => {
  const { full_name, phone, license_ref, address, current_password, new_password } = req.body || {};
  if (!full_name || String(full_name).trim().length < 2) return bad(res, 'Full name is required.');
  if (!phone || String(phone).trim().length < 5) return bad(res, 'Phone number is required.');
  if (new_password) {
    if (String(new_password).length < 6) return bad(res, 'New password must be at least 6 characters.');
    if (current_password !== undefined) {
      const custRow = db.prepare('SELECT password_hash FROM customers WHERE id = ?').get(req.customer.id);
      if (!custRow || !verifyPassword(String(current_password), custRow.password_hash)) {
        return bad(res, 'Current password is incorrect.');
      }
    }
  }

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
  const ident = String(username || '').trim().toLowerCase();
  const pass = String(password || '');
  const admin = db.prepare('SELECT * FROM admins WHERE lower(username) = ?').get(ident);
  if (admin && verifyPassword(pass, admin.password_hash)) {
    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;
    return res.json({ username: admin.username, name: 'Administrator', role: 'admin', permissions: ROLE_PERMISSIONS.admin });
  }
  const staff = db.prepare('SELECT * FROM staff_accounts WHERE lower(email) = ? OR lower(username) = ?').get(ident, ident);
  if (staff && staff.status === 'active' && verifyPassword(pass, staff.password_hash)) {
    req.session.staffId = staff.id;
    return res.json({ username: staff.username, name: staff.full_name, role: staff.role, permissions: ROLE_PERMISSIONS[staff.role] });
  }
  return bad(res, 'Invalid username or password.', 401);
});

app.post('/api/admin/logout', (req, res) => {
  if (req.session) {
    delete req.session.adminId;
    delete req.session.adminUsername;
    delete req.session.staffId;
  }
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  const a = sessionActor(req);
  res.json({ username: a.name, name: a.name, role: a.role, permissions: ROLE_PERMISSIONS[a.role] || [] });
});

const publicStaff = (s) => ({
  id: s.id, full_name: s.full_name, email: s.email, username: s.username,
  role: s.role, status: s.status, created_at: s.created_at
});

app.get('/api/admin/staff', requirePerm('staff:manage'), (req, res) => {
  res.json(db.prepare('SELECT * FROM staff_accounts ORDER BY created_at DESC').all().map(publicStaff));
});

app.post('/api/admin/staff', requirePerm('staff:manage'), (req, res) => {
  const b = req.body || {};
  if (!b.full_name || String(b.full_name).trim().length < 2) return bad(res, 'Full name is required.');
  if (!isEmail(b.email)) return bad(res, 'A valid email address is required.');
  if (!b.username || String(b.username).trim().length < 3) return bad(res, 'Username must be at least 3 characters.');
  if (!b.password || String(b.password).length < 6) return bad(res, 'Password must be at least 6 characters.');
  if (!['staff', 'manager'].includes(b.role)) return bad(res, 'Role must be staff or manager.');
  const email = String(b.email).trim().toLowerCase();
  const username = String(b.username).trim().toLowerCase();
  if (db.prepare('SELECT id FROM staff_accounts WHERE lower(email) = ? OR lower(username) = ?').get(email, username)) {
    return bad(res, 'A staff account with this email or username already exists.', 409);
  }
  const info = db.prepare(`INSERT INTO staff_accounts (full_name, email, username, password_hash, role)
    VALUES (?,?,?,?,?)`).run(
    String(b.full_name).trim(), email, username, hashPassword(String(b.password)), b.role
  );
  res.status(201).json(publicStaff(db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(Number(info.lastInsertRowid))));
});

app.patch('/api/admin/staff/:id/role', requirePerm('staff:manage'), (req, res) => {
  const s = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(req.params.id);
  if (!s) return bad(res, 'Staff account not found.', 404);
  const role = (req.body || {}).role;
  if (!['staff', 'manager'].includes(role)) return bad(res, 'Role must be staff or manager.');
  db.prepare('UPDATE staff_accounts SET role = ? WHERE id = ?').run(role, s.id);
  res.json(publicStaff(db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(s.id)));
});

app.patch('/api/admin/staff/:id/status', requirePerm('staff:manage'), (req, res) => {
  const s = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(req.params.id);
  if (!s) return bad(res, 'Staff account not found.', 404);
  const status = (req.body || {}).status;
  if (!['active', 'suspended'].includes(status)) return bad(res, 'Invalid status.');
  db.prepare('UPDATE staff_accounts SET status = ? WHERE id = ?').run(status, s.id);
  res.json(publicStaff(db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(s.id)));
});

app.delete('/api/admin/staff/:id', requirePerm('staff:manage'), (req, res) => {
  if (!db.prepare('SELECT id FROM staff_accounts WHERE id = ?').get(req.params.id)) return bad(res, 'Staff account not found.', 404);
  db.prepare('DELETE FROM staff_accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/change-password', requirePerm('admin:only'), (req, res) => {
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

// ================= ADMIN: DASHBOARD & ANALYTICS =================
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
    open_quotes: one("SELECT COUNT(*) AS n FROM quotes WHERE status = 'open'"),
    unpaid_invoices: one("SELECT COUNT(*) AS n FROM invoices WHERE status = 'unpaid'"),
    active_bookings: one("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('confirmed','active')"),
    total_customers: one('SELECT COUNT(*) AS n FROM customers'),
    unread_messages: one("SELECT COUNT(*) AS n FROM contact_messages WHERE status = 'new'"),
    total_reviews: one("SELECT COUNT(*) AS n FROM reviews WHERE status = 'published'"),
    revenue: db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS n FROM bookings WHERE status IN ('confirmed','active','completed')`).get().n,
    recent_bookings: recentBookings,
    recent_messages: recentMessages
  });
});

app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const currentYear = new Date().getFullYear();
  const year = Number(req.query.year) || currentYear;
  const compareYear = Number(req.query.compareYear) || (year - 1);

  const yearsRows = db.prepare(`SELECT DISTINCT CAST(substr(pickup_date, 1, 4) AS INTEGER) AS y FROM bookings ORDER BY y DESC`).all();
  const yearSet = new Set([currentYear, currentYear - 1, ...yearsRows.map(r => r.y).filter(Boolean)]);
  const availableYears = [...yearSet].sort((a, b) => b - a);

  const monthlyQuery = db.prepare(`
    SELECT substr(pickup_date, 6, 2) AS m,
           COALESCE(SUM(total_amount), 0) AS revenue,
           COUNT(*) AS bookings
    FROM bookings
    WHERE substr(pickup_date, 1, 4) = ? AND status IN ('confirmed','active','completed')
    GROUP BY m
  `);
  const toMonthMap = (yr) => {
    const map = {};
    for (const row of monthlyQuery.all(String(yr))) map[row.m] = { revenue: round2(row.revenue), bookings: row.bookings };
    return map;
  };
  const yMap = toMonthMap(year);
  const cMap = toMonthMap(compareYear);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthly = monthNames.map((label, idx) => {
    const key = String(idx + 1).padStart(2, '0');
    return {
      month: label,
      revenue: yMap[key]?.revenue || 0,
      bookings: yMap[key]?.bookings || 0,
      compare_revenue: cMap[key]?.revenue || 0,
      compare_bookings: cMap[key]?.bookings || 0
    };
  });

  const yearly = db.prepare(`
    SELECT CAST(substr(pickup_date, 1, 4) AS INTEGER) AS year,
           COALESCE(SUM(total_amount), 0) AS revenue,
           COUNT(*) AS bookings
    FROM bookings
    WHERE status IN ('confirmed','active','completed')
    GROUP BY year
    ORDER BY year ASC
  `).all().map(r => ({ year: r.year, revenue: round2(r.revenue), bookings: r.bookings }));

  const byCar = db.prepare(`
    SELECT c.id, c.brand || ' ' || c.name AS label, c.category,
           COALESCE(SUM(CASE WHEN b.status IN ('confirmed','active','completed') THEN b.total_amount ELSE 0 END), 0) AS revenue,
           COUNT(CASE WHEN b.status != 'cancelled' THEN b.id END) AS bookings,
           COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.car_id = c.id AND r.status = 'published'), 0) AS avg_rating,
           (SELECT COUNT(*) FROM reviews r WHERE r.car_id = c.id AND r.status = 'published') AS review_count
    FROM cars c
    LEFT JOIN bookings b ON b.car_id = c.id
    GROUP BY c.id
    ORDER BY revenue DESC, bookings DESC
  `).all().map(r => ({ ...clean(r), revenue: round2(r.revenue) }));

  const byCategory = db.prepare(`
    SELECT c.category,
           COUNT(DISTINCT c.id) AS car_count,
           COALESCE(SUM(CASE WHEN b.status IN ('confirmed','active','completed') THEN b.total_amount ELSE 0 END), 0) AS revenue,
           COUNT(CASE WHEN b.status != 'cancelled' THEN b.id END) AS bookings
    FROM cars c
    LEFT JOIN bookings b ON b.car_id = c.id
    GROUP BY c.category
    ORDER BY revenue DESC
  `).all().map(r => ({ ...clean(r), revenue: round2(r.revenue) }));

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS revenue
    FROM bookings GROUP BY status
  `).all().map(r => ({ ...clean(r), revenue: round2(r.revenue) }));

  res.json({ year, compareYear, availableYears, monthly, yearly, byCar, byCategory, byStatus });
});

// ================= ADMIN: REVIEWS =================
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.brand AS car_brand, c.name AS car_name
    FROM reviews r JOIN cars c ON c.id = r.car_id
    ORDER BY r.created_at DESC
  `).all();
  res.json(rows.map(clean));
});

app.patch('/api/admin/reviews/:id', requirePerm('reviews:write'), (req, res) => {
  const rev = db.prepare('SELECT id FROM reviews WHERE id = ?').get(req.params.id);
  if (!rev) return bad(res, 'Review not found.', 404);
  const status = req.body.status;
  if (!['published', 'hidden'].includes(status)) return bad(res, 'Invalid review status.');
  db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, rev.id);
  res.json({ ok: true, status });
});

app.delete('/api/admin/reviews/:id', requirePerm('reviews:write'), (req, res) => {
  const rev = db.prepare('SELECT id FROM reviews WHERE id = ?').get(req.params.id);
  if (!rev) return bad(res, 'Review not found.', 404);
  db.prepare('DELETE FROM reviews WHERE id = ?').run(rev.id);
  res.json({ ok: true });
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

app.post('/api/admin/cars', requirePerm('cars:write'), (req, res) => {
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

app.put('/api/admin/cars/:id', requirePerm('cars:write'), (req, res) => {
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

app.patch('/api/admin/cars/:id/status', requirePerm('cars:write'), (req, res) => {
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const status = req.body.status;
  if (!CAR_STATUSES.includes(status)) return bad(res, 'Invalid status.');
  db.prepare('UPDATE cars SET status = ? WHERE id = ?').run(status, car.id);
  res.json({ ok: true, status });
});

app.patch('/api/admin/cars/:id/featured', requirePerm('cars:write'), (req, res) => {
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const featured = req.body.featured ? 1 : 0;
  db.prepare('UPDATE cars SET featured = ? WHERE id = ?').run(featured, car.id);
  res.json({ ok: true, featured });
});

app.delete('/api/admin/cars/:id', requirePerm('cars:write'), (req, res) => {
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
  const rows = db.prepare(`SELECT b.*, c.name AS car_name, c.brand AS car_brand, c.image_url,
    (SELECT i.id FROM invoices i WHERE i.booking_id = b.id LIMIT 1) AS invoice_id,
    (SELECT i.invoice_no FROM invoices i WHERE i.booking_id = b.id LIMIT 1) AS invoice_no,
    (SELECT i.status FROM invoices i WHERE i.booking_id = b.id LIMIT 1) AS invoice_status
    FROM bookings b JOIN cars c ON c.id = b.car_id WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC`).all(...params);
  res.json(rows.map(clean));
});

app.patch('/api/admin/bookings/:id/status', requirePerm('bookings:write'), (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return bad(res, 'Booking not found.', 404);
  const status = req.body.status;
  if (!BOOKING_STATUSES.includes(status)) return bad(res, 'Invalid status.');
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
  res.json({ ok: true, status });
});

app.put('/api/admin/bookings/:id', requirePerm('bookings:write'), (req, res) => {
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

app.delete('/api/admin/bookings/:id', requirePerm('bookings:write'), (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return bad(res, 'Booking not found.', 404);
  db.prepare('DELETE FROM bookings WHERE id = ?').run(booking.id);
  res.json({ ok: true });
});

// ================= ADMIN: QUOTES, INVOICES & POS APPROVAL =================
function makeInvoiceForBooking(booking, method = '', reference = '', status = 'unpaid') {
  const car = db.prepare('SELECT brand, name FROM cars WHERE id = ?').get(booking.car_id) || {};
  const info = db.prepare(`INSERT INTO invoices
    (invoice_no, booking_id, booking_code, customer_name, customer_email, customer_phone, car_label,
     pickup_date, return_date, total_days, subtotal, vat, total_amount, status, payment_method, payment_reference,
     paid_at, due_date, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    '', booking.id, booking.booking_code, booking.customer_name, booking.customer_email, booking.customer_phone,
    `${car.brand || ''} ${car.name || ''}`.trim(), booking.pickup_date, booking.return_date, booking.total_days,
    booking.subtotal, booking.vat, booking.total_amount, status, method, reference,
    status === 'paid' ? new Date().toISOString() : null,
    new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), '', 'admin'
  );
  const id = Number(info.lastInsertRowid);
  const no = `INV-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
  db.prepare('UPDATE invoices SET invoice_no = ? WHERE id = ?').run(no, id);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
}

app.get('/api/admin/quotes', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT q.*, c.brand AS car_brand, c.name AS car_name
    FROM quotes q LEFT JOIN cars c ON c.id = q.car_id ORDER BY q.created_at DESC`).all();
  res.json(rows.map(r => ({ ...clean(r), add_ons: JSON.parse(r.add_ons || '{}') })));
});

app.post('/api/admin/quotes', requireAdmin, (req, res) => {
  const b = req.body || {};
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(b.car_id);
  if (!car) return bad(res, 'Car not found.', 404);
  if (!b.customer_name || String(b.customer_name).trim().length < 2) return bad(res, 'Please enter the customer name.');
  if (!isEmail(b.customer_email)) return bad(res, 'Please enter a valid customer email.');
  if (!isDate(b.pickup_date) || !isDate(b.return_date)) return bad(res, 'Invalid dates. Use YYYY-MM-DD.');
  if (b.return_date <= b.pickup_date) return bad(res, 'Return date must be after the pickup date.');
  const settings = getSettings();
  const addOns = {};
  for (const k of Object.keys(getAddonsConfig(settings))) addOns[k] = !!(b.add_ons && b.add_ons[k]);
  const q = priceQuote(car, b.pickup_date, b.return_date, addOns, settings);
  const validUntil = isDate(b.valid_until) ? b.valid_until : new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const info = db.prepare(`INSERT INTO quotes
    (quote_no, customer_name, customer_email, customer_phone, car_id, pickup_date, return_date, total_days,
     add_ons, subtotal, vat, total_amount, valid_until, notes, status, created_by)
    VALUES ('',?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)`).run(
    String(b.customer_name).trim(), String(b.customer_email).trim(), String(b.customer_phone || '').trim(),
    car.id, b.pickup_date, b.return_date, q.days, JSON.stringify(addOns), q.subtotal, q.vat, q.total,
    validUntil, String(b.notes || '').trim(), 'admin'
  );
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE quotes SET quote_no = ? WHERE id = ?').run(`Q-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`, id);
  const row = db.prepare(`SELECT q.*, c.brand AS car_brand, c.name AS car_name FROM quotes q
    LEFT JOIN cars c ON c.id = q.car_id WHERE q.id = ?`).get(id);
  res.status(201).json({ ...clean(row), add_ons: JSON.parse(row.add_ons) });
});

app.delete('/api/admin/quotes/:id', requirePerm('quotes:delete'), (req, res) => {
  if (!db.prepare('SELECT id FROM quotes WHERE id = ?').get(req.params.id)) return bad(res, 'Quote not found.', 404);
  db.prepare('DELETE FROM quotes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/quotes/:id/convert', requireAdmin, (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return bad(res, 'Quote not found.', 404);
  if (quote.status !== 'open') return bad(res, 'Only open quotes can be converted.', 409);
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(quote.car_id);
  if (!car) return bad(res, 'The quoted car no longer exists.', 409);
  if (car.status !== 'available') return bad(res, `This car is currently ${car.status}.`, 409);
  if (overlaps(car.id, quote.pickup_date, quote.return_date)) return bad(res, 'This car is already booked for the quoted dates.', 409);
  try {
    const booking = db.transaction(() => {
      const info = db.prepare(`INSERT INTO bookings
        (booking_code, car_id, customer_id, customer_name, customer_email, customer_phone, license_ref,
         pickup_location, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, status, notes)
        VALUES (?,?,NULL,?,?,?,'','Main Office',?,?,?,?,?,?,?,'pending',?)`).run(
        bookingCode(), car.id, quote.customer_name, quote.customer_email, quote.customer_phone,
        quote.pickup_date, quote.return_date, quote.total_days, quote.add_ons,
        quote.subtotal, quote.vat, quote.total_amount, quote.notes || ''
      );
      const id = Number(info.lastInsertRowid);
      db.prepare("UPDATE quotes SET status = 'converted', converted_booking_id = ? WHERE id = ?").run(id, quote.id);
      return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    })();
    res.status(201).json({ booking: clean(booking), quote: clean(db.prepare('SELECT * FROM quotes WHERE id = ?').get(quote.id)) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not convert quote.' });
  }
});

app.get('/api/admin/invoices', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all().map(clean));
});

app.post('/api/admin/invoices', requirePerm('invoices:write'), (req, res) => {
  const b = req.body || {};
  if (b.booking_id) {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.booking_id);
    if (!booking) return bad(res, 'Booking not found.', 404);
    if (db.prepare('SELECT id FROM invoices WHERE booking_id = ?').get(booking.id)) {
      return bad(res, 'An invoice already exists for this booking.', 409);
    }
    return res.status(201).json(clean(makeInvoiceForBooking(booking)));
  }
  if (!b.customer_name || String(b.customer_name).trim().length < 2) return bad(res, 'Please enter the client name.');
  const description = String(b.description || b.car_label || '').trim();
  if (!description) return bad(res, 'Please enter the item or service description.');
  const amount = Number(b.total_amount);
  if (!Number.isFinite(amount) || amount < 0) return bad(res, 'Please enter a valid amount.');
  const vatRate = Math.max(0, Number(getSettings().vat_rate) || 0) / 100;
  const total = round2(amount);
  const subtotal = round2(total / (1 + vatRate));
  const vat = round2(total - subtotal);
  const today = new Date().toISOString().slice(0, 10);
  const info = db.prepare(`INSERT INTO invoices
    (invoice_no, booking_id, booking_code, customer_name, customer_email, customer_phone, car_label,
     pickup_date, return_date, total_days, subtotal, vat, total_amount, status, payment_method, payment_reference,
     paid_at, due_date, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    '', null, 'WALK-IN', String(b.customer_name).trim(), String(b.customer_email || '').trim().toLowerCase(),
    String(b.customer_phone || '').trim(), description,
    isDate(b.pickup_date) ? b.pickup_date : today,
    isDate(b.return_date) ? b.return_date : today,
    Math.max(1, Number(b.total_days) || 1), subtotal, vat, total,
    'unpaid', '', '', null,
    isDate(b.due_date) ? b.due_date : new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    String(b.notes || '').trim(), (sessionActor(req) || {}).name || 'admin'
  );
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE invoices SET invoice_no = ? WHERE id = ?').run(`INV-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`, id);
  res.status(201).json(clean(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id)));
});

app.patch('/api/admin/invoices/:id/pay', requireAdmin, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return bad(res, 'Invoice not found.', 404);
  if (invoice.status === 'paid') return bad(res, 'This invoice has already been paid.', 409);
  const method = String((req.body || {}).payment_method || '').trim();
  if (!method) return bad(res, 'Please select a payment method.');
  const reference = String((req.body || {}).payment_reference || '').trim();
  db.prepare("UPDATE invoices SET status = 'paid', payment_method = ?, payment_reference = ?, paid_at = datetime('now') WHERE id = ?")
    .run(method, reference, invoice.id);
  res.json(clean(db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id)));
});

app.delete('/api/admin/invoices/:id', requirePerm('invoices:delete'), (req, res) => {
  if (!db.prepare('SELECT id FROM invoices WHERE id = ?').get(req.params.id)) return bad(res, 'Invoice not found.', 404);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/approve', requireAdmin, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return bad(res, 'Booking not found.', 404);
  if (booking.status !== 'pending') return bad(res, 'Only pending bookings can be approved.', 409);
  const b = req.body || {};
  const method = String(b.payment_method || '').trim();
  if (!method) return bad(res, 'Please select a payment method.');
  const reference = String(b.payment_reference || '').trim();
  const isCash = method.toLowerCase() === 'cash';
  let tendered = null;
  let change = 0;
  if (isCash) {
    tendered = Number(b.amount_tendered);
    if (!Number.isFinite(tendered) || tendered < booking.total_amount) {
      return bad(res, `Cash amount must be at least ${booking.total_amount}.`);
    }
    change = round2(tendered - booking.total_amount);
  }
  const client = b.client_details || {};
  const cName = String(client.customer_name || '').trim();
  const cEmail = String(client.customer_email || '').trim().toLowerCase();
  const cPhone = String(client.customer_phone || '').trim();
  const company = String(client.company || '').trim();
  const taxNo = String(client.tax_number || '').trim();
  const wantsTax = !!client.wants_tax_invoice;
  if (wantsTax && !cName) return bad(res, 'Please enter the client name for the tax invoice.');
  try {
    const result = db.transaction(() => {
      let invoice = db.prepare('SELECT * FROM invoices WHERE booking_id = ?').get(booking.id);
      if (!invoice) invoice = makeInvoiceForBooking(booking, method, reference, 'paid');
      else if (invoice.status === 'paid') return { invoice, alreadyPaid: true };

      const sets = [
        "status = 'paid'", 'payment_method = ?', 'payment_reference = ?', "paid_at = datetime('now')",
        'amount_tendered = ?', 'change_amount = ?', 'client_company = ?', 'client_tax_no = ?', 'wants_tax_invoice = ?'
      ];
      const params = [method, reference, isCash ? round2(tendered) : null, change, company, taxNo, wantsTax ? 1 : 0];
      if (cName) { sets.push('customer_name = ?'); params.push(cName); }
      if (cEmail) { sets.push('customer_email = ?'); params.push(cEmail); }
      if (cPhone) { sets.push('customer_phone = ?'); params.push(cPhone); }
      if (wantsTax) {
        const extra = [`TAX INVOICE — ${cName}`, company ? `Company: ${company}` : '', taxNo ? `Tax No: ${taxNo}` : ''].filter(Boolean).join(' | ');
        sets.push('notes = ?');
        params.push(extra);
      }
      params.push(invoice.id);
      db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
      db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(booking.id);
      return { invoice, alreadyPaid: false };
    })();
    res.json({ ok: true, invoice: clean(result.invoice), booking: clean(db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id)) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not approve booking.' });
  }
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

app.patch('/api/admin/customers/:id/status', requirePerm('customers:write'), (req, res) => {
  const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!cust) return bad(res, 'Customer not found.', 404);
  const status = req.body.status;
  if (!['active', 'suspended'].includes(status)) return bad(res, 'Invalid customer status.');
  db.prepare('UPDATE customers SET status = ? WHERE id = ?').run(status, cust.id);
  res.json({ ok: true, status });
});

app.delete('/api/admin/customers/:id', requirePerm('customers:write'), (req, res) => {
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

app.patch('/api/admin/messages/:id', requirePerm('messages:write'), (req, res) => {
  const msg = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(req.params.id);
  if (!msg) return bad(res, 'Message not found.', 404);
  const { status, admin_notes } = req.body || {};
  const nextStatus = status && MESSAGE_STATUSES.includes(status) ? status : msg.status;
  const nextNotes = admin_notes !== undefined ? String(admin_notes).trim() : msg.admin_notes;
  db.prepare('UPDATE contact_messages SET status = ?, admin_notes = ? WHERE id = ?').run(nextStatus, nextNotes, msg.id);
  res.json(clean(db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(msg.id)));
});

app.delete('/api/admin/messages/:id', requirePerm('messages:write'), (req, res) => {
  const msg = db.prepare('SELECT id FROM contact_messages WHERE id = ?').get(req.params.id);
  if (!msg) return bad(res, 'Message not found.', 404);
  db.prepare('DELETE FROM contact_messages WHERE id = ?').run(msg.id);
  res.json({ ok: true });
});

// ================= ADMIN: SITE SETTINGS ("CONTROL EVERYTHING") =================
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(getSettings());
});

app.put('/api/admin/settings', requirePerm('settings:write'), (req, res) => {
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
