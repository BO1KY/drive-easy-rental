// db.js — SQLite connection (Node built-in node:sqlite), schema, seed data, password helpers
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'carrental.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.transaction = (fn) => (...args) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Sedan','SUV','Hatchback','Van/Truck','Luxury')),
  year INTEGER NOT NULL CHECK (year >= 1990),
  daily_rate REAL NOT NULL CHECK (daily_rate >= 0),
  transmission TEXT NOT NULL CHECK (transmission IN ('Automatic','Manual')),
  fuel_type TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK (seats > 0),
  doors INTEGER NOT NULL DEFAULT 4 CHECK (doors > 0),
  image_url TEXT DEFAULT '',
  description TEXT DEFAULT '',
  features TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','maintenance','unavailable')),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  license_ref TEXT DEFAULT '',
  address TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_code TEXT NOT NULL UNIQUE,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE RESTRICT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  license_ref TEXT DEFAULT '',
  pickup_location TEXT DEFAULT 'Main Office',
  pickup_date TEXT NOT NULL,
  return_date TEXT NOT NULL,
  total_days INTEGER NOT NULL CHECK (total_days >= 1),
  add_ons TEXT NOT NULL DEFAULT '{}',
  subtotal REAL NOT NULL,
  vat REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL CHECK (total_amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','active','completed','cancelled')),
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT DEFAULT '',
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','replied','archived')),
  admin_notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  reviewer_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title TEXT DEFAULT '',
  comment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('staff','manager')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_no TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT DEFAULT '',
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE RESTRICT,
  pickup_date TEXT NOT NULL,
  return_date TEXT NOT NULL,
  total_days INTEGER NOT NULL,
  add_ons TEXT NOT NULL DEFAULT '{}',
  subtotal REAL NOT NULL,
  vat REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL,
  valid_until TEXT NOT NULL,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','cancelled')),
  converted_booking_id INTEGER,
  created_by TEXT DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL UNIQUE,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  booking_code TEXT DEFAULT '',
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT DEFAULT '',
  car_label TEXT NOT NULL,
  pickup_date TEXT NOT NULL,
  return_date TEXT NOT NULL,
  total_days INTEGER NOT NULL,
  subtotal REAL NOT NULL,
  vat REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid')),
  payment_method TEXT DEFAULT '',
  payment_reference TEXT DEFAULT '',
  paid_at TEXT,
  due_date TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_by TEXT DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_booking ON invoices(booking_id);

CREATE INDEX IF NOT EXISTS idx_bookings_car      ON bookings(car_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status   ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_dates    ON bookings(pickup_date, return_date);
CREATE INDEX IF NOT EXISTS idx_cars_status       ON cars(status);
CREATE INDEX IF NOT EXISTS idx_cars_category     ON cars(category);
CREATE INDEX IF NOT EXISTS idx_messages_status   ON contact_messages(status);
CREATE INDEX IF NOT EXISTS idx_reviews_car       ON reviews(car_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status    ON reviews(status);
`);

const carColumns = new Set(db.prepare('PRAGMA table_info(cars)').all().map(r => r.name));
if (!carColumns.has('quantity')) db.exec('ALTER TABLE cars ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');

const staffColumns = new Set(db.prepare('PRAGMA table_info(staff_accounts)').all().map(r => r.name));
if (!staffColumns.has('permissions')) db.exec("ALTER TABLE staff_accounts ADD COLUMN permissions TEXT DEFAULT ''");

const invoiceColumns = new Set(db.prepare('PRAGMA table_info(invoices)').all().map(r => r.name));
for (const [name, decl] of [
  ['amount_tendered', 'REAL'],
  ['change_amount', 'REAL'],
  ['client_company', "TEXT DEFAULT ''"],
  ['client_tax_no', "TEXT DEFAULT ''"],
  ['wants_tax_invoice', 'INTEGER DEFAULT 0'],
  ['payments', "TEXT DEFAULT '[]'"]
]) {
  if (!invoiceColumns.has(name)) db.exec(`ALTER TABLE invoices ADD COLUMN ${name} ${decl}`);
}

// ---------- password helpers (scrypt, no external deps) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

// ---------- seed cars ----------
const carCount = db.prepare('SELECT COUNT(*) AS n FROM cars').get().n;
if (carCount === 0) {
  const img = (txt) => `https://placehold.co/640x400/0f4c81/ffffff?text=${encodeURIComponent(txt)}`;
  const insertCar = db.prepare(`INSERT INTO cars
    (name, brand, category, year, daily_rate, transmission, fuel_type, seats, doors, image_url, description, features, status, featured)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const cars = [
    ['Corolla 1.8', 'Toyota', 'Sedan', 2023, 39, 'Automatic', 'Petrol', 5, 4, img('Toyota Corolla'), 'Reliable and fuel-efficient sedan, perfect for city driving and long highway trips.', 'AC,Bluetooth,Cruise Control,Reverse Camera,USB Charging', 'available', 1],
    ['CR-V Touring', 'Honda', 'SUV', 2024, 65, 'Automatic', 'Petrol', 7, 5, img('Honda CR-V'), 'Spacious family SUV with generous boot space and advanced safety features.', 'AC,GPS,Bluetooth,Apple CarPlay,Lane Assist,Heated Seats', 'available', 1],
    ['Mustang GT', 'Ford', 'Luxury', 2022, 120, 'Automatic', 'Petrol', 4, 2, img('Ford Mustang GT'), 'Iconic American muscle car for unforgettable weekend getaways.', 'AC,Leather Seats,Premium Sound,Launch Control,GPS', 'available', 1],
    ['Golf 1.4 TSI', 'Volkswagen', 'Hatchback', 2023, 45, 'Manual', 'Petrol', 5, 5, img('VW Golf'), 'Compact, agile hatchback — easy to park and great on fuel.', 'AC,Bluetooth,Parking Sensors,Apple CarPlay', 'available', 0],
    ['V-Class Executive', 'Mercedes-Benz', 'Van/Truck', 2023, 95, 'Automatic', 'Diesel', 8, 5, img('Mercedes V-Class'), 'Premium people-mover for groups, airport transfers, and executive travel.', 'AC,GPS,Leather Seats,Climate Control,Cruise Control', 'available', 1],
    ['Hilux 2.8 4x4', 'Toyota', 'Van/Truck', 2022, 70, 'Manual', 'Diesel', 5, 4, img('Toyota Hilux 4x4'), 'Tough double-cab built for gravel roads, safari routes, and towing.', 'AC,4x4,Tow Bar,Bull Bar,Bluetooth', 'available', 0],
    ['320i M Sport', 'BMW', 'Luxury', 2024, 99, 'Automatic', 'Petrol', 5, 4, img('BMW 320i'), 'Executive sport sedan blending comfort, tech, and sharp handling.', 'AC,GPS,Harman Kardon Sound,Leather Seats,Heads-Up Display', 'available', 0],
    ['Tucson NX4', 'Hyundai', 'SUV', 2024, 59, 'Automatic', 'Petrol', 5, 5, img('Hyundai Tucson'), 'Modern mid-size SUV with bold styling and a complete safety suite.', 'AC,Blind Spot Monitor,Apple CarPlay,Wireless Charging,GPS', 'available', 0],
    ['Picanto 1.0', 'Kia', 'Hatchback', 2022, 29, 'Manual', 'Petrol', 5, 5, img('Kia Picanto'), 'Budget-friendly city runabout — economical, nimble, and reliable.', 'AC,Bluetooth,Economical', 'available', 0],
    ['X-Trail 4x4', 'Nissan', 'SUV', 2023, 62, 'Automatic', 'Diesel', 7, 5, img('Nissan X-Trail'), 'Rugged 7-seater SUV, ideal for family road trips and light off-road.', 'AC,GPS,4x4,Roof Rails,Reverse Camera', 'maintenance', 0]
  ];

  db.transaction(() => {
    for (const c of cars) insertCar.run(...c);
    db.prepare('UPDATE cars SET quantity = 3 WHERE id = 1').run();
    db.prepare('UPDATE cars SET quantity = 2 WHERE id = 7').run();
  })();
}

// ---------- seed customers ----------
const customerCount = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
if (customerCount === 0) {
  const insertCust = db.prepare(`INSERT INTO customers
    (full_name, email, phone, license_ref, address, password_hash, status)
    VALUES (?,?,?,?,?,?,?)`);
  db.transaction(() => {
    insertCust.run('John Nangula', 'john@example.com', '+264 81 123 4567', 'DL-88213', '14 Sam Nujoma Dr, Windhoek', hashPassword('password123'), 'active');
    insertCust.run('Selma Ipinge', 'selma@example.com', '+264 85 765 4321', 'DL-45092', '88 Nelson Mandela Ave, Windhoek', hashPassword('password123'), 'active');
  })();
}

// ---------- seed bookings (including multi-month & prior-year history for analytics) ----------
const bookingCount = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
if (bookingCount <= 4) {
  const d = (offset) => {
    const dt = new Date();
    dt.setDate(dt.getDate() + offset);
    return dt.toISOString().slice(0, 10);
  };
  const inclusive = (total) => {
    const subtotal = Math.round((total / 1.15) * 100) / 100;
    return [subtotal, Math.round((total - subtotal) * 100) / 100];
  };
  const insertBooking = db.prepare(`INSERT OR IGNORE INTO bookings
    (booking_code, car_id, customer_id, customer_name, customer_email, customer_phone, license_ref, pickup_location, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    if (bookingCount === 0) {
      insertBooking.run('CR-7F3K2A', 1, 1, 'John Nangula', 'john@example.com', '+264 81 123 4567', 'DL-88213', 'Hosea Kutako Airport', d(-20), d(-15), 5, '{"insurance":true}', ...inclusive(280.5), 280.5, 'completed', 'Airport pickup requested.');
      insertBooking.run('CR-M9X41P', 2, 2, 'Selma Ipinge', 'selma@example.com', '+264 85 765 4321', 'DL-45092', 'Main Office', d(-5), d(-1), 4, '{}', ...inclusive(286), 286, 'completed', '');
      insertBooking.run('CR-Q2Z88R', 8, null, 'David Shilongo', 'david.s@example.com', '+264 81 555 0192', 'DL-30217', 'Main Office', d(3), d(7), 4, '{"child_seat":true,"insurance":true}', ...inclusive(334.4), 334.4, 'confirmed', 'Will collect at 09:00.');
      insertBooking.run('CR-B5H61T', 7, null, 'Maria Andjaba', 'maria.andjaba@example.com', '+264 86 220 7788', 'DL-77104', 'City Center Branch', d(1), d(3), 2, '{}', ...inclusive(217.8), 217.8, 'pending', '');
    }
    const nowYear = new Date().getFullYear();
    const prevYear = nowYear - 1;
    const hist = [
      ['CR-H101A', 1, 1, 'John Nangula', 'john@example.com', '+264 81 123 4567', `${prevYear}-02-10`, `${prevYear}-02-14`, 4, 156, 15.6, 171.6, 'completed'],
      ['CR-H102B', 2, 2, 'Selma Ipinge', 'selma@example.com', '+264 85 765 4321', `${prevYear}-04-05`, `${prevYear}-04-10`, 5, 325, 32.5, 357.5, 'completed'],
      ['CR-H103C', 3, null, 'Lucas Shikongo', 'lucas@example.com', '+264 81 221 9001', `${prevYear}-06-14`, `${prevYear}-06-18`, 4, 480, 48.0, 528.0, 'completed'],
      ['CR-H104D', 5, null, 'Anna Amutenya', 'anna@example.com', '+264 81 334 8812', `${prevYear}-08-19`, `${prevYear}-08-25`, 6, 570, 57.0, 627.0, 'completed'],
      ['CR-H105E', 7, 1, 'John Nangula', 'john@example.com', '+264 81 123 4567', `${prevYear}-10-03`, `${prevYear}-10-08`, 5, 495, 49.5, 544.5, 'completed'],
      ['CR-H106F', 6, null, 'Peter Hamutenya', 'peter@example.com', '+264 81 772 1190', `${prevYear}-12-11`, `${prevYear}-12-18`, 7, 490, 49.0, 539.0, 'completed'],
      ['CR-H201A', 2, 1, 'John Nangula', 'john@example.com', '+264 81 123 4567', `${nowYear}-01-12`, `${nowYear}-01-17`, 5, 325, 32.5, 357.5, 'completed'],
      ['CR-H202B', 3, null, 'Nadia Jacobs', 'nadia@example.com', '+264 85 410 3300', `${nowYear}-03-08`, `${nowYear}-03-12`, 4, 528, 52.8, 580.8, 'completed'],
      ['CR-H203C', 5, 2, 'Selma Ipinge', 'selma@example.com', '+264 85 765 4321', `${nowYear}-05-15`, `${nowYear}-05-21`, 6, 642, 64.2, 706.2, 'completed'],
      ['CR-H204D', 6, null, 'Kevin Vries', 'kevin@example.com', '+264 81 609 2214', `${nowYear}-07-04`, `${nowYear}-07-10`, 6, 420, 42.0, 462.0, 'completed'],
      ['CR-H205E', 7, 1, 'John Nangula', 'john@example.com', '+264 81 123 4567', `${nowYear}-08-20`, `${nowYear}-08-24`, 4, 444, 44.4, 488.4, 'completed'],
      ['CR-H206F', 4, null, 'Grace Ndapewa', 'grace@example.com', '+264 81 912 4401', `${nowYear}-09-10`, `${nowYear}-09-15`, 5, 225, 22.5, 247.5, 'completed'],
      ['CR-H207G', 8, 2, 'Selma Ipinge', 'selma@example.com', '+264 85 765 4321', `${nowYear}-10-14`, `${nowYear}-10-19`, 5, 295, 29.5, 324.5, 'completed']
    ];
    for (const h of hist) {
      insertBooking.run(h[0], h[1], h[2], h[3], h[4], h[5], 'DL-HIST', 'Main Office', h[6], h[7], h[8], '{}', ...inclusive(h[11]), h[11], h[12], 'Historical booking');
    }
  })();
}

// ---------- seed quotations & invoices ----------
if (db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n === 0) {
  const year = new Date().getFullYear();
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO quotes
    (quote_no, customer_name, customer_email, customer_phone, car_id, pickup_date, return_date, total_days,
     add_ons, subtotal, vat, total_amount, valid_until, notes, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','admin')`).run(
    `Q-${year}-0001`, 'Selma Ipinge', 'selma@example.com', '+264 85 765 4321', 8,
    day(10), day(13), 3, '{"insurance":true}', 185.22, 27.78, 213, day(7), 'Requested airport pickup.'
  );
}
if (db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n === 0) {
  const year = new Date().getFullYear();
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT b.*, c.brand, c.name FROM bookings b JOIN cars c ON c.id = b.car_id
    WHERE b.status IN ('completed','confirmed') ORDER BY b.id LIMIT 3`).all();
  const insert = db.prepare(`INSERT INTO invoices
    (invoice_no, booking_id, booking_code, customer_name, customer_email, customer_phone, car_label,
     pickup_date, return_date, total_days, subtotal, vat, total_amount, status, payment_method, paid_at,
     due_date, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'admin')`);
  rows.forEach((b, i) => {
    const paid = i !== rows.length - 1;
    insert.run(
      `INV-${year}-${String(i + 1).padStart(4, '0')}`, b.id, b.booking_code,
      b.customer_name, b.customer_email, b.customer_phone, `${b.brand} ${b.name}`,
      b.pickup_date, b.return_date, b.total_days, b.subtotal, b.vat, b.total_amount,
      paid ? 'paid' : 'unpaid', paid ? 'Bank transfer' : '', paid ? new Date().toISOString() : null,
      day(5), ''
    );
  });
}

// ---------- seed reviews ----------
const reviewCount = db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n;
if (reviewCount === 0) {
  const insertRev = db.prepare(`INSERT INTO reviews (car_id, customer_id, reviewer_name, rating, title, comment, status)
    VALUES (?,?,?,?,?,?,'published')`);
  db.transaction(() => {
    insertRev.run(1, 1, 'John Nangula', 5, 'Super economical and spotless', 'Picked it up at the airport right on time. Very smooth drive and great fuel economy.');
    insertRev.run(2, 2, 'Selma Ipinge', 5, 'Ideal family SUV', 'Plenty of luggage room for our weekend road trip and Apple CarPlay worked effortlessly.');
    insertRev.run(3, null, 'Lucas Shikongo', 5, 'Absolute head-turner', 'Amazing V8 sound and immaculate interior. Worth every dollar for a special weekend.');
    insertRev.run(7, 1, 'John Nangula', 4, 'Refined executive ride', 'Sharp handling on the highway and super comfortable seats. Pickup was fast.');
    insertRev.run(5, 2, 'Selma Ipinge', 5, 'Best group van', 'Carried 7 people and suitcases comfortably across town without any hassle.');
  })();
}

// ---------- seed contact messages ----------
const msgCount = db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get().n;
if (msgCount === 0) {
  db.prepare(`INSERT INTO contact_messages (name, email, phone, subject, message, status)
    VALUES (?,?,?,?,?,?)`).run(
    'Sarah Shikongo',
    'sarah.s@example.com',
    '+264 81 440 2211',
    'Corporate fleet inquiry',
    'Hello, we need 3 SUVs for a 10-day company tour next month. Do you offer corporate rates?',
    'new'
  );
}

// ---------- seed site settings ----------
const DEFAULT_SETTINGS = {
  site_name: 'DriveEasy',
  site_accent: 'Rentals',
  tagline: 'Drive easy, travel far.',
  hero_title: 'Find & book your perfect rental car',
  hero_subtitle: 'Transparent daily rates · Instant availability · Free cancellation on pending bookings',
  about_headline: 'Reliable Car Rentals Built Around Your Journey',
  about_story: 'Founded in 2016, DriveEasy Rentals began with five dependable sedans and a simple promise: honest pricing, spotless vehicles, and real human support whenever you need it. Today we serve business travelers, families, and explorers across the region.',
  about_mission: 'To make every trip effortless with transparent pricing, thoroughly inspected cars, and 24/7 roadside assistance.',
  stat_years: '10+',
  stat_clients: '15,000+',
  stat_rating: '4.9 / 5',
  contact_email: 'hello@driveeasy.com',
  contact_phone: '+264 81 555 0100',
  contact_address: '42 Independence Ave, Windhoek',
  contact_hours: 'Mon–Sat: 07:00 – 19:00 · Sun: 09:00 – 16:00',
  currency_symbol: 'N$',
  vat_rate: '15',
  addon_child_seat: '5',
  addon_additional_driver: '8',
  addon_insurance: '12',
  min_driver_age: '21',
  pickup_locations: 'Main Office, Hosea Kutako Airport, City Center Branch',
  footer_note: 'Transparent rates, modern vehicles & 24/7 roadside assistance.'
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)');
db.transaction(() => {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(k, v);
  }
})();

// ---------- seed default admin ----------
const adminCount = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
if (adminCount === 0) {
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('admin', hashPassword('admin123'));
}
if (db.prepare('SELECT COUNT(*) AS n FROM staff_accounts').get().n === 0) {
  const insertStaff = db.prepare('INSERT INTO staff_accounts (full_name, email, username, password_hash, role) VALUES (?,?,?,?,?)');
  insertStaff.run('Tomas Shivute', 'tomas@driveeasy.example', 'tomas', hashPassword('password123'), 'staff');
  insertStaff.run('Ndapewa Amutenya', 'ndapewa@driveeasy.example', 'ndapewa', hashPassword('password123'), 'manager');
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

module.exports = { db, hashPassword, verifyPassword, getSettings, DEFAULT_SETTINGS };
