# DriveEasy Rentals — Full-Stack Car Rental Web Application

A complete, responsive car rental system with a customer storefront and a protected admin panel.
Built with **Node.js + Express** and vanilla HTML5 / CSS3 / JavaScript (ES6+) — no external database
server required (data is persisted to a local JSON file).

## Features

**Customer site**

- Landing page showcasing the business: hero date search, fleet grid (photo, specs, colour, live `Available / Booked / Maintenance` badges, star ratings)
- All prices are in **NAD (Namibian Dollar)** and include **15% VAT** — the advertised rate is the final shelf price
- Filter by category, transmission, min seats, max price + live search by make/model
- Pickup & return dates drive **real-time availability** (overlapping bookings are excluded)
- Car details modal with full specs (including colour), features, rental terms and customer reviews
- Guests can **rate cars 1–5 stars and leave a comment**; ratings are averaged on cards and details
- Booking flow with automatic duration / add-ons / VAT-inclusive total (verified again server-side)
- Booking confirmation with unique reference code + **My Bookings** search by reference or email
- **About Us**, **Contact Us** (messages land in the admin inbox) and **Register** account pages
- **My Account** profile page: customers sign in, edit their details, change their password and view their own bookings

**Admin panel (`/admin.html`)**

- Session-based login for admins (`admin` / `admin123`) **and** staff/manager accounts by email
  (demo: `tomas@driveeasy.example` / `password123`, `ndapewa@driveeasy.example` / `password123`)
- Role-based permissions enforced server-side:
  - **Admin** — everything, including staff management
  - **Manager** — cars, bookings, quotes, invoices and messages (no staff management)
  - **Staff** — view fleet availability, create quotes, issue invoices, record payments and approve pending rentals;
    cannot add/edit/delete cars or change arbitrary booking statuses
- Dashboard: available cars, active rentals, pending approvals, monthly revenue, registered customers,
  open quotes, unpaid invoices, messages, upcoming pickups, recent bookings, status bars and fleet utilisation
- Staff management: add staff/manager accounts, change roles and delete accounts.
  Customer accounts are self-service (My Account) and never appear in the admin panel
- Car CRUD: edit anything — brand, model, category, year, daily rate, transmission, fuel, seats, doors, **colour**, status, image, description and features
- Booking management: filter by status, search by code/customer, update status
  (cancel/complete frees the car automatically — availability is always derived from bookings)
- **Quotations**: build a quote with live VAT-inclusive preview, print/save as PDF, then convert it to a booking
- **Tax invoices**: generate an invoice for any booking, mark it paid (payment method + date), print/save as PDF;
  staff can only approve a pending rental once its invoice is marked paid
- Messages inbox: read and delete contact-form submissions (deletion is manager/admin only)

**Backend / data**

- JSON datastore (`carrental-data.json`) created and seeded automatically on first run
- Server-side validation and scrypt-hashed passwords; sessions are `httpOnly`
- Prices are always computed from the stored daily rate — the client total is never trusted

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server (creates + seeds carrental-data.json automatically on first run)
npm start

# 3. Open
#    Customer site: http://localhost:3000
#    Admin panel:   http://localhost:3000/admin.html   (admin / admin123)
```

Requires **Node.js 18+** (tested on Node 26).

## Project Structure

```
CAR RENTAL/
├── server.js            # Express app: public API + admin API + sessions
├── db.js                # JSON store, seed data, scrypt password helpers
├── carrental-data.json  # auto-created data file (cars, bookings, users, messages)
├── package.json
├── index.html           # landing page: hero search, filters, fleet, how-it-works, lookup
├── about.html           # About Us
├── contact.html         # Contact Us (posts to /api/contact)
├── register.html        # Customer account registration
├── profile.html         # Customer account: sign in, profile, password, own bookings
├── admin.html           # Admin panel (login + dashboard + cars + bookings + quotes + invoices + staff + messages)
├── style.css            # full responsive stylesheet (includes printable quote/invoice layout)
├── main.js              # customer logic (nav, filters, availability, booking, forms)
├── admin.js             # admin logic (login/roles, stats, CRUD, quotes, invoices, documents, messages)
└── README.md
```

## Data Model (`carrental-data.json`)

- `cars[]{id, name, brand, category, year, daily_rate, transmission, fuel_type, seats, doors, color, image_url, description, features, status, created_at}`
- `bookings[]{id, booking_code, car_id, customer_name, customer_email, customer_phone, license_ref, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, status, notes, created_at}`
- `users[]{id, name, email, phone, role (customer|staff|manager), password_hash, created_at}`
- `admins[]{id, username, password_hash, created_at}`
- `messages[]{id, name, email, phone, subject, message, created_at}`
- `reviews[]{id, car_id, name, rating (1–5), comment, created_at}`
- `quotes[]{id, quote_no, customer_name, customer_email, customer_phone, car_id, pickup_date, return_date, total_days, add_ons, subtotal, vat, total_amount, valid_until, notes, status (open|converted), created_by, created_at}`
- `invoices[]{id, invoice_no, booking_id, booking_code, customer_name, customer_email, customer_phone, car_label, pickup_date, return_date, total_days, subtotal, vat, total_amount, status (unpaid|paid), payment_method, paid_at, due_date, notes, created_by, created_at}`
- `seq{}` — id counters

Booking statuses: `pending`, `confirmed`, `active`, `completed`, `cancelled`.
Car statuses: `available`, `maintenance`, `unavailable`.

## API Overview

Public:

- `GET  /api/cars` — filter params: `category, transmission, seats, minPrice, maxPrice, search, pickup, ret`
- `GET  /api/cars/:id`
- `POST /api/bookings` — create booking (server-side pricing + overlap check)
- `GET  /api/bookings/lookup/:code` · `GET /api/bookings/my?email=`
- `POST /api/reviews` — rate a car 1–5 stars and leave a comment
- `POST /api/contact` · `POST /api/users/register`
- Customer accounts: `POST /api/users/login` · `POST /api/users/logout` · `GET/PUT /api/users/me`
  · `PUT /api/users/me/password` · `GET /api/users/me/bookings`

Admin (session required):

- `POST /api/admin/login` (admin username or staff/manager email) · `POST /api/admin/logout` · `GET /api/admin/me`
- `GET  /api/admin/stats`
- `GET/POST /api/admin/cars` · `PUT/DELETE /api/admin/cars/:id` · `PATCH /api/admin/cars/:id/status`
- `GET  /api/admin/bookings?status=&q=` · `PATCH /api/admin/bookings/:id/status`
- Quotes: `GET/POST /api/admin/quotes` · `DELETE /api/admin/quotes/:id` · `POST /api/admin/quotes/:id/convert`
- Invoices: `GET/POST /api/admin/invoices` · `PATCH /api/admin/invoices/:id/pay` · `DELETE /api/admin/invoices/:id`
- `GET  /api/admin/messages` · `DELETE /api/admin/messages/:id`
- Staff accounts: `GET/POST /api/admin/users` · `PATCH /api/admin/users/:id/role` · `DELETE /api/admin/users/:id`
  (staff and manager roles only; admin-only permission `staff:manage`)

Permissions are declared in `ROLE_PERMISSIONS` in `server.js`; every protected route checks a specific
permission (`cars:write`, `bookings:any`, `bookings:approve`, `quotes:write`, `quotes:delete`,
`invoices:write`, `invoices:delete`, `messages:delete`, `staff:manage`).

## Customization

| Setting | Where |
| --- | --- |
| Currency / VAT / add-on prices | `server.js` (`ADDONS`, `VAT_RATE = 0.15`, VAT-inclusive) and `main.js` (`ADDONS`, `VAT_RATE`) |
| Brand name & colors | HTML pages + `style.css` (`:root` variables) |
| Port / session secret | env vars `PORT`, `SESSION_SECRET` |
| Admin credentials | seeded in `db.js` via `hashPassword()`; change the password before deploying |

## Security Notes

- Passwords hashed with Node `crypto.scrypt` (salted, timing-safe compare)
- Source and data files (`server.js`, `db.js`, `carrental-data.json`, …) are blocked from static serving
- Session cookie is `httpOnly`; every admin endpoint is protected server-side by role permissions
- Staff approval is double-checked: only `pending → confirmed`, and only when a paid invoice exists
- Set a strong `SESSION_SECRET` and change the default admin password before deploying
