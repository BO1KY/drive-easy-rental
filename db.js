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

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_car      ON bookings(car_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status   ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_dates    ON bookings(pickup_date, return_date);
CREATE INDEX IF NOT EXISTS idx_cars_status       ON cars(status);
CREATE INDEX IF NOT EXISTS idx_cars_category     ON cars(category);
CREATE INDEX IF NOT EXISTS idx_messages_status   ON contact_messages(status);
`);

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

// ---------- seed bookings ----------
const bookingCount = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
if (bookingCount === 0) {
  const d = (offset) => {
    const dt = new Date();
    dt.setDate(dt.getDate() + offset);
    return dt.toISOString().slice(0, 10);
  };
  const insertBooking = db.prepare(`INSERT INTO bookings
    (booking_code, car_id, customer_id, customer_name, customer_email, customer_phone, license_ref, pickup_location, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    insertBooking.run('CR-7F3K2A', 1, 1, 'John Nangula', 'john@example.com', '+264 81 123 4567', 'DL-88213', 'Hosea Kutako Airport', d(-20), d(-15), 5, '{"insurance":true}', 255, 25.5, 280.5, 'completed', 'Airport pickup requested.');
    insertBooking.run('CR-M9X41P', 2, 2, 'Selma Ipinge', 'selma@example.com', '+264 85 765 4321', 'DL-45092', 'Main Office', d(-5), d(-1), 4, '{}', 260, 26.0, 286.0, 'completed', '');
    insertBooking.run('CR-Q2Z88R', 8, null, 'David Shilongo', 'david.s@example.com', '+264 81 555 0192', 'DL-30217', 'Main Office', d(3), d(7), 4, '{"child_seat":true,"insurance":true}', 304, 30.4, 334.4, 'confirmed', 'Will collect at 09:00.');
    insertBooking.run('CR-B5H61T', 7, null, 'Maria Andjaba', 'maria.andjaba@example.com', '+264 86 220 7788', 'DL-77104', 'City Center Branch', d(1), d(3), 2, '{}', 198, 19.8, 217.8, 'pending', '');
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
  currency_symbol: '$',
  vat_rate: '10',
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

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

module.exports = { db, hashPassword, verifyPassword, getSettings, DEFAULT_SETTINGS };
