// server.js — DriveEasy Car Rental full-stack multi-page website & admin control API
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { db, hashPassword, verifyPassword, getSettings, DEFAULT_SETTINGS } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const STATIC_DIR = __dirname;
const isProd = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (isProd && !SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production.');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set — using a development-only secret.');
}
if (isProd) app.set('trust proxy', 1);

app.use(express.json({ limit: '50kb' }));
app.use(session({
  secret: SESSION_SECRET || 'dev-only-insecure-secret-do-not-deploy',
  resave: false,
  saveUninitialized: false,
  name: 'driveeasy.sid',
  cookie: {
    maxAge: 1000 * 60 * 60 * 12,
    httpOnly: true,
    sameSite: 'strict',
    secure: isProd
  }
}));

// ---------- security response headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (isProd && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ---------- lightweight in-memory rate limiting ----------
const rateBuckets = new Map();
function rateLimit(prefix, max, windowMs) {
  return (req, res, next) => {
    const key = `${prefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
}
const authLimiter = rateLimit('auth', 20, 5 * 60 * 1000);
const writeLimiter = rateLimit('write', 100, 5 * 60 * 1000);
const lookupLimiter = rateLimit('lookup', 60, 5 * 60 * 1000);

// ---------- block direct HTTP access to backend/internal files ----------
const BLOCKED_PATHS = new Set([
  '/server.js', '/db.js', '/package.json', '/package-lock.json', '/readme.md', '/render.yaml'
]);
const BLOCKED_EXT = /\.(db|db-wal|db-shm|bak|backup|sql|zip|gz|tar|log|env|pem|key)$/i;
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    BLOCKED_PATHS.has(p) ||
    p.startsWith('/node_modules') ||
    p.startsWith('/.') ||
    BLOCKED_EXT.test(p) ||
    p.endsWith('~')
  ) {
    return res.status(404).json({ error: 'Not found' });
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
  '/admin': 'admin.html',
  '/admin-login': 'admin-login.html'
};
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res) => res.sendFile(path.join(STATIC_DIR, file)));
}
app.use(express.static(STATIC_DIR));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

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
const LIMITS = { name: 120, email: 254, phone: 40, short: 80, text: 2000, url: 500 };
const text = (value, max = LIMITS.text) => String(value == null ? '' : value).trim().slice(0, max);
const validPhone = (value) => /^[+0-9()\-\s]{5,40}$/.test(String(value || '').trim());
function safeImageUrl(value) {
  const url = text(value, LIMITS.url);
  if (!url) return '';
  return /^(https?:\/\/|\/)/i.test(url) ? url : '';
}

function getAddonsConfig(settings) {
  return {
    child_seat: { label: 'Child Seat', price: Math.max(0, Number(settings.addon_child_seat) || 0) },
    additional_driver: { label: 'Additional Driver', price: Math.max(0, Number(settings.addon_additional_driver) || 0) },
    insurance: { label: 'Full Insurance', price: Math.max(0, Number(settings.addon_insurance) || 0) }
  };
}

function overlapCount(carId, pickup, ret) {
  return db.prepare(`SELECT COUNT(*) AS n FROM bookings
    WHERE car_id = ? AND status IN ('pending','confirmed','active')
      AND pickup_date < ? AND return_date > ?`).get(carId, ret, pickup).n;
}
function bookedNowCount(carId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`SELECT COUNT(*) AS n FROM bookings
    WHERE car_id = ? AND status IN ('pending','confirmed','active')
      AND pickup_date <= ? AND return_date >= ?`).get(carId, today, today).n;
}
const carUnits = (car) => Math.max(1, Number(car && car.quantity) || 1);

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
const PERMISSION_CATALOG = [
  'view_dashboard', 'view_revenue', 'view_cars', 'cars:write', 'view_bookings', 'bookings:write',
  'bookings:approve', 'quotes:write', 'quotes:delete', 'invoices:write', 'invoices:delete',
  'view_messages', 'messages:write', 'view_reviews', 'reviews:write', 'view_customers',
  'customers:write', 'view_settings', 'settings:write', 'staff:manage'
];
const ROLE_DEFAULT_PERMISSIONS = {
  admin: ['*'],
  manager: PERMISSION_CATALOG.filter(p => p !== 'staff:manage'),
  staff: [
    'view_cars', 'view_bookings', 'bookings:approve',
    'quotes:write', 'invoices:write', 'view_messages', 'view_reviews'
  ]
};
function parsePermissions(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    return Array.isArray(arr) ? arr.filter(p => PERMISSION_CATALOG.includes(p)) : [];
  } catch { return []; }
}
function sessionActor(req) {
  if (!req.session) return null;
  if (req.session.adminId) {
    return { id: req.session.adminId, name: req.session.adminUsername || 'admin', role: 'admin',
      permissions: ROLE_DEFAULT_PERMISSIONS.admin };
  }
  if (req.session.staffId) {
    const s = db.prepare('SELECT id, full_name, role, status, permissions FROM staff_accounts WHERE id = ?').get(req.session.staffId);
    if (s && s.status === 'active') {
      const stored = parsePermissions(s.permissions);
      return { id: s.id, name: s.full_name, role: s.role,
        permissions: stored.length ? stored : ROLE_DEFAULT_PERMISSIONS[s.role] || [] };
    }
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
    const perms = a.permissions || [];
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

  const rows = db.prepare(`
    SELECT c.*,
      COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.car_id = c.id AND r.status = 'published'), 0) AS avg_rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.car_id = c.id AND r.status = 'published') AS review_count
    FROM cars c WHERE ${where.join(' AND ')}
    ORDER BY c.featured DESC, c.daily_rate ASC`).all(...params);

  const hasDates = isDate(pickup) && isDate(ret) && ret > pickup;
  res.json(rows.map((car) => {
    const units = carUnits(car);
    const unitsBooked = hasDates ? overlapCount(car.id, pickup, ret) : bookedNowCount(car.id);
    const unitsAvailable = Math.max(0, units - unitsBooked);
    return {
      ...car, quantity: units, units_booked: unitsBooked, units_available: unitsAvailable,
      is_available: car.status === 'available' && unitsAvailable > 0
    };
  }));
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
  const hasDates = isDate(req.query.pickup) && isDate(req.query.ret) && req.query.ret > req.query.pickup;
  const units = carUnits(car);
  const unitsBooked = hasDates ? overlapCount(car.id, req.query.pickup, req.query.ret) : bookedNowCount(car.id);
  const unitsAvailable = Math.max(0, units - unitsBooked);
  res.json({
    ...car, quantity: units, units_booked: unitsBooked, units_available: unitsAvailable,
    is_available: car.status === 'available' && unitsAvailable > 0,
    busy_ranges: busyRanges.map(clean)
  });
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

app.post('/api/cars/:id/reviews', writeLimiter, requireCustomer, (req, res) => {
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

app.post('/api/bookings', writeLimiter, (req, res) => {
  const b = req.body || {};
  const required = ['car_id', 'customer_name', 'customer_email', 'customer_phone', 'pickup_date', 'return_date'];
  for (const f of required) {
    if (!b[f] || String(b[f]).trim() === '') return bad(res, `Missing required field: ${f}`);
  }
  if (!isEmail(b.customer_email) || text(b.customer_email, LIMITS.email).length > LIMITS.email) return bad(res, 'Invalid email address.');
  if (!validPhone(b.customer_phone)) return bad(res, 'Invalid phone number.');
  if (text(b.customer_name, LIMITS.name).length < 2) return bad(res, 'Invalid customer name.');
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
    const used = overlapCount(car.id, b.pickup_date, b.return_date);
    if (used >= carUnits(car)) {
      const err = new Error('All units of this vehicle are booked for the selected dates. Please choose different dates.');
      err.status = 409;
      throw err;
    }
    const q = priceQuote(car, b.pickup_date, b.return_date, addOns, settings);
    const info = db.prepare(`INSERT INTO bookings
      (booking_code, car_id, customer_id, customer_name, customer_email, customer_phone, license_ref,
       pickup_location, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, status, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(
      bookingCode(), car.id, customerId,
      text(b.customer_name, LIMITS.name), text(b.customer_email, LIMITS.email).toLowerCase(), text(b.customer_phone, LIMITS.phone),
      text(b.license_ref || '', LIMITS.short), text(b.pickup_location || 'Main Office', LIMITS.short),
      b.pickup_date, b.return_date, q.days, JSON.stringify(addOns),
      q.subtotal, q.vat, q.total, text(b.notes || '')
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

app.post('/api/bookings/multiple', writeLimiter, (req, res) => {
  const b = req.body || {};
  const required = ['customer_name', 'customer_email', 'customer_phone', 'pickup_date', 'return_date'];
  for (const f of required) {
    if (!b[f] || String(b[f]).trim() === '') return bad(res, `Missing required field: ${f}`);
  }
  if (!isEmail(b.customer_email) || text(b.customer_email, LIMITS.email).length > LIMITS.email) return bad(res, 'Invalid email address.');
  if (!validPhone(b.customer_phone)) return bad(res, 'Invalid phone number.');
  if (text(b.customer_name, LIMITS.name).length < 2) return bad(res, 'Invalid customer name.');
  if (!isDate(b.pickup_date) || !isDate(b.return_date)) return bad(res, 'Invalid dates.');
  if (b.pickup_date < new Date().toISOString().slice(0, 10)) return bad(res, 'Pickup date cannot be in the past.');
  if (b.return_date <= b.pickup_date) return bad(res, 'Return date must be after pickup date.');
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return bad(res, 'Add at least one vehicle to book.');
  const settings = getSettings();
  const addonsCfg = getAddonsConfig(settings);
  const customerId = req.session && req.session.customerId ? req.session.customerId : null;
  const created = [];
  const quotes = [];
  try {
    db.transaction(() => {
      for (const it of items) {
        const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(it.car_id);
        if (!car) { const e = new Error('One of the selected vehicles was not found.'); e.status = 404; throw e; }
        if (car.status !== 'available') { const e = new Error(`${car.brand} ${car.name} is currently ${car.status}.`); e.status = 400; throw e; }
        if (overlapCount(car.id, b.pickup_date, b.return_date) >= carUnits(car)) {
          const e = new Error(`All units of ${car.brand} ${car.name} are booked for those dates.`);
          e.status = 409;
          throw e;
        }
        const addOns = {};
        for (const k of Object.keys(addonsCfg)) addOns[k] = !!(it.add_ons && it.add_ons[k]);
        const q = priceQuote(car, b.pickup_date, b.return_date, addOns, settings);
        const info = db.prepare(`INSERT INTO bookings
          (booking_code, car_id, customer_id, customer_name, customer_email, customer_phone, license_ref,
           pickup_location, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, status, notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(
          bookingCode(), car.id, customerId, text(b.customer_name, LIMITS.name),
          text(b.customer_email, LIMITS.email).toLowerCase(), text(b.customer_phone, LIMITS.phone),
          text(b.license_ref || '', LIMITS.short), text(b.pickup_location || 'Main Office', LIMITS.short),
          b.pickup_date, b.return_date, q.days, JSON.stringify(addOns),
          q.subtotal, q.vat, q.total, text(b.notes || '')
        );
        created.push(db.prepare(`SELECT b.*, c.name AS car_name, c.brand AS car_brand
          FROM bookings b JOIN cars c ON c.id = b.car_id WHERE b.id = ?`).get(Number(info.lastInsertRowid)));
        quotes.push(q);
      }
    })();
    res.status(201).json({ bookings: created.map(clean), quotes });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Booking failed.' });
  }
});

app.get('/api/bookings/lookup/:code', lookupLimiter, (req, res) => {
  const row = db.prepare(`SELECT b.booking_code, b.car_id, b.pickup_date, b.return_date, b.total_days,
      b.add_ons, b.subtotal, b.vat, b.total_amount, b.status, b.pickup_location,
      c.name AS car_name, c.brand AS car_brand, c.category, c.image_url
    FROM bookings b JOIN cars c ON c.id = b.car_id WHERE b.booking_code = ?`)
    .get(text(req.params.code, 20).toUpperCase());
  if (!row) return bad(res, 'Booking not found.', 404);
  res.json(clean(row));
});

// ================= PUBLIC CONTACT MESSAGES =================
app.post('/api/contact', writeLimiter, (req, res) => {
  const { name, email, phone, subject, message } = req.body || {};
  if (!name || text(name, LIMITS.name).length < 2) return bad(res, 'Please enter your name.');
  if (!isEmail(email) || text(email, LIMITS.email).length > LIMITS.email) return bad(res, 'Please enter a valid email address.');
  if (phone && !validPhone(phone)) return bad(res, 'Please enter a valid phone number.');
  if (!subject || text(subject, LIMITS.short).length < 2) return bad(res, 'Please enter a subject.');
  if (!message || text(message).length < 10) return bad(res, 'Message must be at least 10 characters.');

  const info = db.prepare(`INSERT INTO contact_messages (name, email, phone, subject, message)
    VALUES (?,?,?,?,?)`).run(
    text(name, LIMITS.name),
    text(email, LIMITS.email).toLowerCase(),
    text(phone || '', LIMITS.phone),
    text(subject, LIMITS.short),
    text(message)
  );
  res.status(201).json({ id: Number(info.lastInsertRowid), ok: true });
});

// ================= CUSTOMER AUTH & PORTAL =================
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { full_name, email, phone, license_ref, address, password } = req.body || {};
  if (text(full_name, LIMITS.name).length < 2) return bad(res, 'Full name is required.');
  if (!isEmail(email) || text(email, LIMITS.email).length > LIMITS.email) return bad(res, 'Valid email address is required.');
  if (!validPhone(phone)) return bad(res, 'Valid phone number is required.');
  if (!password || String(password).length < 6 || String(password).length > 200) {
    return bad(res, 'Password must be between 6 and 200 characters.');
  }

  const normalizedEmail = text(email, LIMITS.email).toLowerCase();
  const exists = db.prepare('SELECT id FROM customers WHERE email = ?').get(normalizedEmail);
  if (exists) return bad(res, 'An account with this email already exists.', 409);

  const info = db.prepare(`INSERT INTO customers (full_name, email, phone, license_ref, address, password_hash)
    VALUES (?,?,?,?,?,?)`).run(
    text(full_name, LIMITS.name),
    normalizedEmail,
    text(phone, LIMITS.phone),
    text(license_ref || '', LIMITS.short),
    text(address || '', LIMITS.short),
    hashPassword(String(password))
  );
  const customerId = Number(info.lastInsertRowid);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.customerId = customerId;
    const cust = db.prepare('SELECT id, full_name, email, phone, license_ref, address, status, created_at FROM customers WHERE id = ?').get(customerId);
    res.status(201).json({ customer: clean(cust) });
  });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || text(email, LIMITS.email).length > LIMITS.email || String(password || '').length > 200) {
    return bad(res, 'Invalid email or password.', 401);
  }
  const cust = db.prepare('SELECT * FROM customers WHERE email = ?').get(text(email, LIMITS.email).toLowerCase());
  if (!cust || !verifyPassword(String(password || ''), cust.password_hash)) {
    return bad(res, 'Invalid email or password.', 401);
  }
  if (cust.status !== 'active') return bad(res, 'Your account has been suspended. Please contact support.', 403);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.customerId = cust.id;
    const { password_hash, ...safe } = cust;
    res.json({ customer: safe });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Could not sign out.' });
    res.clearCookie('driveeasy.sid');
    res.json({ ok: true });
  });
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
  if (text(full_name, LIMITS.name).length < 2) return bad(res, 'Full name is required.');
  if (!validPhone(phone)) return bad(res, 'Phone number is required.');
  if (new_password) {
    if (String(new_password).length < 6 || String(new_password).length > 200) {
      return bad(res, 'New password must be between 6 and 200 characters.');
    }
    if (current_password !== undefined) {
      const custRow = db.prepare('SELECT password_hash FROM customers WHERE id = ?').get(req.customer.id);
      if (!custRow || !verifyPassword(String(current_password), custRow.password_hash)) {
        return bad(res, 'Current password is incorrect.');
      }
    }
  }

  db.prepare(`UPDATE customers SET full_name = ?, phone = ?, license_ref = ?, address = ? WHERE id = ?`).run(
    text(full_name, LIMITS.name),
    text(phone, LIMITS.phone),
    text(license_ref || '', LIMITS.short),
    text(address || '', LIMITS.short),
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
function completeAdminLogin(req, res, fields, payload) {
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    Object.assign(req.session, fields);
    res.json(payload);
  });
}

app.post('/api/admin/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const ident = String(username || '').trim().toLowerCase();
  const pass = String(password || '');
  const admin = db.prepare('SELECT * FROM admins WHERE lower(username) = ?').get(ident);
  if (admin && verifyPassword(pass, admin.password_hash)) {
    return completeAdminLogin(req, res,
      { adminId: admin.id, adminUsername: admin.username },
      { username: admin.username, name: 'Administrator', role: 'admin', permissions: ROLE_DEFAULT_PERMISSIONS.admin });
  }
  const staff = db.prepare('SELECT * FROM staff_accounts WHERE lower(email) = ? OR lower(username) = ?').get(ident, ident);
  if (staff && staff.status === 'active' && verifyPassword(pass, staff.password_hash)) {
    const stored = parsePermissions(staff.permissions);
    return completeAdminLogin(req, res,
      { staffId: staff.id },
      { username: staff.username, name: staff.full_name, role: staff.role,
        permissions: stored.length ? stored : ROLE_DEFAULT_PERMISSIONS[staff.role] });
  }
  return bad(res, 'Invalid username or password.', 401);
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Could not sign out.' });
    res.clearCookie('driveeasy.sid');
    res.json({ ok: true });
  });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  const a = sessionActor(req);
  res.json({ username: a.name, name: a.name, role: a.role, permissions: a.permissions || [] });
});

const publicStaff = (s) => ({
  id: s.id, full_name: s.full_name, email: s.email, username: s.username,
  role: s.role, status: s.status, created_at: s.created_at,
  permissions: parsePermissions(s.permissions),
  has_custom_permissions: parsePermissions(s.permissions).length > 0
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

app.patch('/api/admin/staff/:id/permissions', requirePerm('staff:manage'), (req, res) => {
  const s = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(req.params.id);
  if (!s) return bad(res, 'Staff account not found.', 404);
  const list = (req.body || {}).permissions;
  if (!Array.isArray(list)) return bad(res, 'Permissions must be a list.');
  const badPerm = list.find(p => !PERMISSION_CATALOG.includes(p));
  if (badPerm) return bad(res, `Unknown permission: ${badPerm}.`);
  db.prepare('UPDATE staff_accounts SET permissions = ? WHERE id = ?').run(JSON.stringify([...new Set(list)]), s.id);
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
app.get('/api/admin/stats', requirePerm('view_revenue'), (req, res) => {
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

app.get('/api/admin/analytics', requirePerm('view_revenue'), (req, res) => {
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
app.get('/api/admin/reviews', requirePerm('view_reviews'), (req, res) => {
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
app.get('/api/admin/cars', requirePerm('view_cars'), (req, res) => {
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
  if (!partial || b.daily_rate !== undefined) {
    const r = +b.daily_rate;
    if (!Number.isFinite(r) || r < 0 || r > 1000000) errs.push('Daily rate must be between 0 and 1,000,000.');
  }
  if (!partial || b.transmission !== undefined) { if (!['Automatic', 'Manual'].includes(b.transmission)) errs.push('Invalid transmission.'); }
  if (!partial || b.fuel_type !== undefined) {
    if (text(b.fuel_type, LIMITS.short).length < 1) errs.push('Fuel type is required.');
  }
  if (text(b.name || '', LIMITS.name).length > LIMITS.name) errs.push('Name is too long.');
  if (text(b.brand || '', LIMITS.name).length > LIMITS.name) errs.push('Brand is too long.');
  if (b.image_url !== undefined && b.image_url && !safeImageUrl(b.image_url)) {
    errs.push('Image URL must be an http(s) link or a relative path.');
  }
  if (!partial || b.seats !== undefined) { const s = +b.seats; if (!Number.isInteger(s) || s < 1 || s > 60) errs.push('Invalid seats.'); }
  if (b.doors !== undefined) { const d = +b.doors; if (!Number.isInteger(d) || d < 1 || d > 10) errs.push('Invalid doors.'); }
  if (b.status !== undefined && !CAR_STATUSES.includes(b.status)) errs.push('Invalid status.');
  if (b.quantity !== undefined) {
    const qty = +b.quantity;
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) errs.push('Quantity must be between 1 and 100.');
  }
  return errs;
}

app.post('/api/admin/cars', requirePerm('cars:write'), (req, res) => {
  const b = req.body || {};
  const errs = validateCar(b);
  if (errs.length) return bad(res, errs.join(' '));
  const info = db.prepare(`INSERT INTO cars (name, brand, category, year, daily_rate, transmission, fuel_type, seats, doors, image_url, description, features, status, featured, quantity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    text(b.name, LIMITS.name), text(b.brand, LIMITS.name), b.category, +b.year, +b.daily_rate, b.transmission,
    text(b.fuel_type, LIMITS.short), +b.seats, +(b.doors || 4), safeImageUrl(b.image_url),
    text(b.description || ''), text(b.features || ''),
    CAR_STATUSES.includes(b.status) ? b.status : 'available', b.featured ? 1 : 0,
    Math.max(1, +b.quantity || 1)
  );
  res.status(201).json(clean(db.prepare('SELECT * FROM cars WHERE id = ?').get(Number(info.lastInsertRowid))));
});

app.put('/api/admin/cars/:id', requirePerm('cars:write'), (req, res) => {
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!car) return bad(res, 'Car not found.', 404);
  const b = { ...car, ...req.body };
  const errs = validateCar(b);
  if (errs.length) return bad(res, errs.join(' '));
  db.prepare(`UPDATE cars SET name=?, brand=?, category=?, year=?, daily_rate=?, transmission=?, fuel_type=?, seats=?, doors=?, image_url=?, description=?, features=?, status=?, featured=?, quantity=? WHERE id=?`).run(
    text(b.name, LIMITS.name), text(b.brand, LIMITS.name), b.category, +b.year, +b.daily_rate, b.transmission,
    text(b.fuel_type, LIMITS.short), +b.seats, +b.doors, safeImageUrl(b.image_url),
    text(b.description || ''), text(b.features || ''),
    CAR_STATUSES.includes(b.status) ? b.status : car.status, b.featured ? 1 : 0,
    Math.max(1, +b.quantity || 1), car.id
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
app.get('/api/admin/bookings', requirePerm('view_bookings'), (req, res) => {
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

app.get('/api/admin/quotes', requirePerm('quotes:write'), (req, res) => {
  const rows = db.prepare(`SELECT q.*, c.brand AS car_brand, c.name AS car_name
    FROM quotes q LEFT JOIN cars c ON c.id = q.car_id ORDER BY q.created_at DESC`).all();
  res.json(rows.map(r => ({ ...clean(r), add_ons: JSON.parse(r.add_ons || '{}') })));
});

app.post('/api/admin/quotes', requirePerm('quotes:write'), (req, res) => {
  const b = req.body || {};
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(b.car_id);
  if (!car) return bad(res, 'Car not found.', 404);
  if (text(b.customer_name, LIMITS.name).length < 2) return bad(res, 'Please enter the customer name.');
  if (!isEmail(b.customer_email) || text(b.customer_email, LIMITS.email).length > LIMITS.email) return bad(res, 'Please enter a valid customer email.');
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
    text(b.customer_name, LIMITS.name), text(b.customer_email, LIMITS.email), text(b.customer_phone || '', LIMITS.phone),
    car.id, b.pickup_date, b.return_date, q.days, JSON.stringify(addOns), q.subtotal, q.vat, q.total,
    validUntil, text(b.notes || ''), (sessionActor(req) || {}).name || 'admin'
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

app.post('/api/admin/quotes/:id/convert', requirePerm('quotes:write'), (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return bad(res, 'Quote not found.', 404);
  if (quote.status !== 'open') return bad(res, 'Only open quotes can be converted.', 409);
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(quote.car_id);
  if (!car) return bad(res, 'The quoted car no longer exists.', 409);
  if (car.status !== 'available') return bad(res, `This car is currently ${car.status}.`, 409);
  if (overlapCount(car.id, quote.pickup_date, quote.return_date) >= carUnits(car)) {
    return bad(res, 'All units of this car are booked for the quoted dates.', 409);
  }
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

app.get('/api/admin/invoices', requirePerm('invoices:write'), (req, res) => {
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
  if (text(b.customer_name, LIMITS.name).length < 2) return bad(res, 'Please enter the client name.');
  if (b.customer_email && !isEmail(b.customer_email)) return bad(res, 'Please enter a valid email address.');
  if (b.customer_phone && !validPhone(b.customer_phone)) return bad(res, 'Please enter a valid phone number.');
  const description = text(b.description || b.car_label || '', LIMITS.short);
  if (!description) return bad(res, 'Please enter the item or service description.');
  const amount = Number(b.total_amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) return bad(res, 'Please enter a valid amount.');
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
    '', null, 'WALK-IN', text(b.customer_name, LIMITS.name), text(b.customer_email || '', LIMITS.email).toLowerCase(),
    text(b.customer_phone || '', LIMITS.phone), description,
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

app.patch('/api/admin/invoices/:id/pay', requirePerm('invoices:write'), (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return bad(res, 'Invoice not found.', 404);
  if (invoice.status === 'paid') return bad(res, 'This invoice has already been paid.', 409);
  const body = req.body || {};
  const payments = Array.isArray(body.payments) ? body.payments : [];
  let method = '', reference = '', cashTendered = null, cashChange = 0, storedPayments = [];
  if (payments.length) {
    let paid = 0;
    for (const p of payments) {
      const m = text(p.method, LIMITS.short);
      const amount = Number(p.amount);
      if (!m) return bad(res, 'Select a payment method.');
      if (!Number.isFinite(amount) || amount <= 0) return bad(res, 'Each payment needs a valid amount.');
      let tendered = null, change = 0;
      if (m.toLowerCase() === 'cash') {
        tendered = Number(p.tendered);
        if (!Number.isFinite(tendered) || tendered < amount) return bad(res, 'Cash received must cover the cash portion.');
        change = round2(tendered - amount);
        cashTendered = round2((cashTendered || 0) + tendered);
        cashChange = round2(cashChange + change);
      }
      paid = round2(paid + amount);
      storedPayments.push({ method: m, amount: round2(amount), reference: text(p.reference, LIMITS.short), tendered, change });
    }
    if (paid + 0.01 < invoice.total_amount) return bad(res, `Payments are short by ${round2(invoice.total_amount - paid)}.`);
    method = storedPayments.map(p => p.method).join(' + ');
    reference = storedPayments.map(p => p.reference).filter(Boolean).join(' · ');
  } else {
    method = text(body.payment_method, LIMITS.short);
    if (!method) return bad(res, 'Please select a payment method.');
    reference = text(body.payment_reference, LIMITS.short);
  }
  const client = body.client || {};
  const company = text(client.company, LIMITS.short);
  const taxNo = text(client.tax_number, LIMITS.short);
  const wantsTax = !!client.wants_tax_invoice;
  db.prepare(`UPDATE invoices SET status='paid', payment_method=?, payment_reference=?, paid_at=datetime('now'),
    payments=?, amount_tendered=?, change_amount=?, client_company=CASE WHEN ? <> '' THEN ? ELSE client_company END,
    client_tax_no=CASE WHEN ? <> '' THEN ? ELSE client_tax_no END, wants_tax_invoice=? WHERE id=?`).run(
    method, reference, JSON.stringify(storedPayments), cashTendered, cashChange,
    company, company, taxNo, taxNo, wantsTax ? 1 : (client.wants_tax_invoice ? 1 : 0), invoice.id
  );
  res.json(clean(db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id)));
});

app.delete('/api/admin/invoices/:id', requirePerm('invoices:delete'), (req, res) => {
  if (!db.prepare('SELECT id FROM invoices WHERE id = ?').get(req.params.id)) return bad(res, 'Invoice not found.', 404);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/pos/sale', writeLimiter, requirePerm('invoices:write'), (req, res) => {
  const b = req.body || {};
  const client = b.client || {};
  if (text(client.name, LIMITS.name).length < 2) return bad(res, 'Please enter the client name.');
  if (client.email && !isEmail(client.email)) return bad(res, 'Please enter a valid email address.');
  if (client.phone && !validPhone(client.phone)) return bad(res, 'Please enter a valid phone number.');
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return bad(res, 'Choose at least one vehicle.');
  if (!isDate(b.pickup_date) || !isDate(b.return_date) || b.return_date <= b.pickup_date) {
    return bad(res, 'Choose valid pickup and return dates.');
  }
  const payments = Array.isArray(b.payments) ? b.payments : [];
  if (!payments.length) return bad(res, 'Add at least one payment.');
  const settings = getSettings();
  const addonsCfg = getAddonsConfig(settings);
  const cleanPayments = [];
  let paidTotal = 0, cashTendered = 0, cashChange = 0;
  for (const p of payments) {
    const method = String(p.method || '').trim();
    const amount = Number(p.amount);
    if (!method) return bad(res, 'Select a payment method.');
    if (!Number.isFinite(amount) || amount <= 0) return bad(res, 'Each payment needs a valid amount.');
    let tendered = null, change = 0;
    if (method.toLowerCase() === 'cash') {
      tendered = Number(p.tendered);
      if (!Number.isFinite(tendered) || tendered < amount) return bad(res, 'Cash tendered must cover the cash portion.');
      change = round2(tendered - amount);
      cashTendered = round2(cashTendered + tendered);
      cashChange = round2(cashChange + change);
    }
    paidTotal = round2(paidTotal + amount);
    cleanPayments.push({ method, amount: round2(amount), reference: String(p.reference || '').trim(), tendered, change });
  }

  let subtotal = 0, vat = 0, total = 0;
  const priced = [];
  for (const it of items) {
    const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(it.car_id);
    if (!car) return bad(res, 'One of the chosen vehicles was not found.', 404);
    if (car.status !== 'available') return bad(res, `${car.brand} ${car.name} is ${car.status}.`, 400);
    if (overlapCount(car.id, b.pickup_date, b.return_date) >= carUnits(car)) {
      return bad(res, `All units of ${car.brand} ${car.name} are booked for those dates.`, 409);
    }
    const addOns = {};
    for (const k of Object.keys(addonsCfg)) addOns[k] = !!(it.add_ons && it.add_ons[k]);
    const q = priceQuote(car, b.pickup_date, b.return_date, addOns, settings);
    subtotal = round2(subtotal + q.subtotal);
    vat = round2(vat + q.vat);
    total = round2(total + q.total);
    priced.push({ car, addOns, quote: q });
  }
  if (paidTotal + 0.01 < total) return bad(res, `Payment is short by ${total - paidTotal}.`);

  const company = String(client.company || '').trim();
  const taxNo = String(client.tax_number || '').trim();
  const wantsTax = !!client.wants_tax_invoice;
  if (wantsTax && !company && !taxNo) return bad(res, 'Add company or tax number for a tax invoice.');
  const actorName = (sessionActor(req) || {}).name || 'admin';
  try {
    const result = db.transaction(() => {
      const bookings = [];
      for (const p of priced) {
        const info = db.prepare(`INSERT INTO bookings
          (booking_code, car_id, customer_id, customer_name, customer_email, customer_phone, license_ref,
           pickup_location, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, status, notes)
          VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',?)`).run(
          bookingCode(), p.car.id, text(client.name, LIMITS.name), text(client.email || '', LIMITS.email).toLowerCase(),
          text(client.phone || '', LIMITS.phone), text(client.license || '', LIMITS.short), 'Main Office',
          b.pickup_date, b.return_date, p.quote.days, JSON.stringify(p.addOns),
          p.quote.subtotal, p.quote.vat, p.quote.total, text(b.notes || '')
        );
        bookings.push(db.prepare(`SELECT b.*, c.name AS car_name, c.brand AS car_brand
          FROM bookings b JOIN cars c ON c.id = b.car_id WHERE b.id = ?`).get(Number(info.lastInsertRowid)));
      }
      const label = priced.map(p => `${p.car.brand} ${p.car.name}`).join(', ');
      const noteParts = [wantsTax ? `TAX INVOICE — ${client.name}` : '', company ? `Company: ${company}` : '', taxNo ? `Tax No: ${taxNo}` : ''].filter(Boolean);
      const info = db.prepare(`INSERT INTO invoices
        (invoice_no, booking_id, booking_code, customer_name, customer_email, customer_phone, car_label,
         pickup_date, return_date, total_days, subtotal, vat, total_amount, status, payment_method, payment_reference,
         paid_at, due_date, notes, created_by, amount_tendered, change_amount, client_company, client_tax_no,
         wants_tax_invoice, payments)
        VALUES ('',NULL,?,?,?,?,?,?,?,?,?,?,?,'paid',?,?,datetime('now'),?,?,?,?,?,?,?,?,?)`).run(
        'POS-' + Date.now().toString(36).toUpperCase(), text(client.name, LIMITS.name),
        text(client.email || '', LIMITS.email).toLowerCase(), text(client.phone || '', LIMITS.phone), label,
        b.pickup_date, b.return_date, Math.max(...priced.map(p => p.quote.days)),
        subtotal, vat, total, cleanPayments.map(p => p.method).join(' + '),
        cleanPayments.map(p => p.reference).filter(Boolean).join(' · '),
        b.pickup_date, noteParts.join(' | '), actorName,
        cashTendered || null, cashChange, company, taxNo, wantsTax ? 1 : 0, JSON.stringify(cleanPayments)
      );
      const id = Number(info.lastInsertRowid);
      db.prepare('UPDATE invoices SET invoice_no = ? WHERE id = ?').run(`INV-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`, id);
      return { bookings, invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) };
    })();
    res.status(201).json({ bookings: result.bookings.map(clean), invoice: clean(result.invoice) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not complete sale.' });
  }
});

app.post('/api/admin/bookings/:id/approve', requirePerm('bookings:approve'), (req, res) => {
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
app.get('/api/admin/customers', requirePerm('view_customers'), (req, res) => {
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
app.get('/api/admin/messages', requirePerm('view_messages'), (req, res) => {
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
  const nextNotes = admin_notes !== undefined ? text(admin_notes) : msg.admin_notes;
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
app.get('/api/admin/settings', requirePerm('view_settings'), (req, res) => {
  res.json(getSettings());
});

app.put('/api/admin/settings', requirePerm('settings:write'), (req, res) => {
  const body = req.body || {};
  const upsert = db.prepare(`INSERT INTO site_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
  const numericSettings = new Set(['vat_rate', 'addon_child_seat', 'addon_additional_driver', 'addon_insurance', 'min_driver_age']);
  try {
    db.transaction(() => {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (body[key] === undefined) continue;
        const max = key === 'currency_symbol' ? 4 : (numericSettings.has(key) ? 10 : LIMITS.short);
        const value = text(body[key], max).replace(/[\r\n]+/g, ' ');
        if (numericSettings.has(key) && !/^\d+(\.\d+)?$/.test(value)) {
          const err = new Error(`Invalid value for ${key}.`);
          err.status = 400;
          throw err;
        }
        upsert.run(key, value);
      }
    })();
    res.json(getSettings());
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save settings.' });
  }
});

// ---------- 404 + generic error handlers (no stack traces leaked) ----------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).send('Not found');
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Invalid JSON.' });
  }
  if (err && err.status && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message || 'Bad request.' });
  }
  console.error('Unhandled error:', err && err.message);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error.' });
  res.status(500).send('Internal server error.');
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`DriveEasy Rentals website running at http://localhost:${PORT}`);
  if (!isProd) console.log('Admin sign-in: http://localhost:' + PORT + '/admin-login.html');
});
