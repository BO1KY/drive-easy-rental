# DriveEasy Rentals — Full-Stack Car Rental Web Application

A complete, responsive car rental system with a customer storefront, client account portal and a protected
Admin Control Center. Built with **Node.js + Express** and vanilla HTML/CSS/JS; data lives in a local
SQLite database using Node's built-in `node:sqlite` driver (no external database server).

## Features

**Customer site**

- Multi-page site: Home (`/`), Book Now (`/book.html`), About, Contact, Register / My Account, My Booking lookup
- Fleet grid with photos, specs, ratings, live availability and category/price/transmission/seat filters
- All prices are in **NAD** with **15% VAT included** in the advertised daily rate (configurable in admin settings)
- Booking flow computes duration, add-ons and VAT-inclusive totals; the server revalidates price and availability
- Booking confirmation with a unique reference code; lookup by code or view bookings while signed in
- Customer account portal: profile editing, password change, booking history, online cancellation of pending bookings
- Signed-in clients can rate vehicles 1–5 stars; **reviews are published automatically**

**Admin Control Center (`/admin.html`)**

- Intentionally **not linked** from customer pages — open by typing `/admin.html` in the browser
- Session login for `admin` / `admin123`, plus staff and manager accounts (by email or username)
- Role permissions enforced server-side:
  - **Admin** — everything, including staff management and admin password changes
  - **Manager** — all operational features, but cannot manage staff accounts
  - **Staff** — fleet availability, quotations, invoices/payments and Point-of-Sale approval;
    cannot add/edit cars, manage staff or change arbitrary booking statuses
- Dashboard with live KPIs and charts: sales by month/year with year comparison, car comparison
  (revenue/bookings/rating), category and booking-status donuts, recent bookings and messages
- Fleet management: add/edit cars (brand, model, category, rate, specs, status, **image URL**, featured flag)
- Booking management: search/filter, status changes, branch/notes editing, delete
- Customer management: search, suspend/reactivate and delete accounts
- Contact inbox and review moderation
- **Quotations**: build a VAT-inclusive quote, print/save as PDF, convert to a booking
- **Tax invoices**: generate invoices for online bookings **or walk-in clients**, mark as paid, print/save as PDF
- **Point of Sale**: approving a pending rental opens a POS dialog showing subtotal, VAT and total.
  Cash payments capture the amount tendered and display the change; the payer can supply company/tax details
  for a tax invoice. After processing, the invoice is generated/paid and sent to print automatically
- Invoice list has status filters, search and CSV export

**Backend / data**

- SQLite database (`carrental.db`) created and seeded automatically on first run
- Server-side validation, configurable site settings and scrypt-hashed passwords; sessions are `httpOnly`
- Prices are always computed from stored rates — client totals are never trusted

## Quick Start

```bash
npm install
npm start
```

- Customer site: http://localhost:3000
- Admin Control Center: http://localhost:3000/admin.html (`admin` / `admin123`)
- Staff demo: `tomas@driveeasy.example` / `password123`
- Manager demo: `ndapewa@driveeasy.example` / `password123`

Requires **Node.js 22.5+** (tested on Node 26).

## Project Structure

```
CAR RENTAL/
├── server.js        # Express app: public API, admin API, auth, sessions, POS
├── db.js            # SQLite schema, seed data, password helpers, site settings
├── carrental.db     # auto-created SQLite database (git-ignored)
├── package.json
├── index.html       # landing page
├── book.html        # Book Now page
├── about.html
├── contact.html
├── register.html    # registration, sign-in and professional client portal
├── admin.html       # Admin Control Center
├── style.css        # responsive stylesheet + printable document styles
├── main.js          # shared site helpers and booking page logic
├── admin.js         # dashboard charts, CRUD, quotes, invoices, POS, staff
└── README.md
```

## Data Model

Tables in `carrental.db`: `cars`, `customers`, `bookings`, `contact_messages`, `reviews`, `admins`,
`staff_accounts`, `site_settings`, `quotes`, `invoices`.

- Booking statuses: `pending`, `confirmed`, `active`, `completed`, `cancelled`
- Car statuses: `available`, `maintenance`, `unavailable`
- Staff roles: `staff`, `manager`; invoice statuses: `unpaid`, `paid`; quote statuses: `open`, `converted`, `cancelled`

## API Overview

Public: `GET /api/site`, `GET /api/cars`, `GET /api/cars/:id`, `GET/POST /api/cars/:id/reviews`,
`POST /api/bookings`, `GET /api/bookings/lookup/:code`, `POST /api/contact`,
`POST /api/auth/register|login|logout`, `GET /api/auth/me`, `PUT /api/auth/profile`,
`PATCH /api/my-bookings/:id/cancel`.

Admin (session + permissions): `POST /api/admin/login|logout`, `GET /api/admin/me`,
`GET /api/admin/stats`, `GET /api/admin/analytics`, car CRUD, booking CRUD/status, customer
management, message management, review moderation, `GET/PUT /api/admin/settings`,
`POST /api/admin/change-password`, quote CRUD/convert, invoice CRUD/pay (including walk-in invoices),
`POST /api/admin/bookings/:id/approve` (POS), and staff-account management.

Permissions are declared in `ROLE_PERMISSIONS` in `server.js` and checked per route with `requirePerm()`.

## Customization

| Setting | Where |
| --- | --- |
| Currency, VAT, add-on prices, site copy | Admin → Site Settings (stored in `site_settings`) |
| Port / session secret | env vars `PORT`, `SESSION_SECRET` |
| Default credentials | seeded in `db.js` via `hashPassword()` — change before deploying |

## Security Notes

- Passwords hashed with Node `crypto.scrypt` (salted, timing-safe compare)
- Backend source and database files are blocked from static serving
- Session cookie is `httpOnly`; admin endpoints are protected server-side by role permissions
- POS approval is transactional: only pending bookings can be approved and the invoice is paid in the same operation
- Set a strong `SESSION_SECRET` and change the default admin password before deploying
