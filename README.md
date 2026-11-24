# DriveEasy Rentals — Full-Stack Car Rental Web Application

A complete, responsive car rental system with a customer storefront, client account portal and a protected
Admin Control Center. Built with **Node.js + Express** and vanilla HTML/CSS/JS; data lives in a local
SQLite database using Node's built-in `node:sqlite` driver (no external database server).

## Features

**Customer site**

- Multi-page site: Home (`/`), Book Now (`/book.html`), About, Contact, Register / My Account, My Booking lookup
- Fleet grid with photos, specs, ratings, live availability and category/price/transmission/seat filters
- All prices are in **NAD** with **15% VAT included** in the advertised daily rate (configurable in admin settings)
- Booking flow computes duration, add-ons and VAT-inclusive totals; clients can book **multiple/different vehicles** in one checkout
- Fleet quantity is respected: a model with several units stays available until every unit is booked for the dates
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
- **Full staff POS**: staff can select vehicles, enter client details, split payments across methods
  (card/cash/bank transfer/mobile money), calculate cash change and create a paid invoice for walk-in rentals
- Admin chooses each staff member's exact permissions; revenue and charts are restricted to admin/manager
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
- Admin sign-in: http://localhost:3000/admin-login.html (`admin` / `admin123`)
- Admin Control Center: http://localhost:3000/admin.html
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
├── admin-login.html # separate admin / staff sign-in page
├── admin.html       # Admin Control Center
├── render.yaml      # Render deployment blueprint
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

Permissions are declared in `ROLE_DEFAULT_PERMISSIONS` / `PERMISSION_CATALOG` in `server.js`,
stored per staff account, and enforced on every admin route with `requirePerm()`.

## Customization

| Setting | Where |
| --- | --- |
| Currency, VAT, add-on prices, site copy | Admin → Site Settings (stored in `site_settings`) |
| Port / session secret | env vars `PORT`, `SESSION_SECRET` (required in production) |
| Seeded passwords | env vars `ADMIN_PASSWORD`, `STAFF_PASSWORD`; otherwise dev defaults are used |

## Security Notes & Pre-Launch Checklist

Implemented hardening:

- Passwords hashed with salted Node `crypto.scrypt`, timing-safe verification, malformed-hash handling
- `SESSION_SECRET` is mandatory when `NODE_ENV=production` / `RENDER=true`; app exits if missing
- Session cookie: `httpOnly`, `SameSite=Strict`, `Secure` in production, regenerated on every login, destroyed on logout
- In-memory rate limits on auth, writes and booking lookup; JSON body limited to 50kb
- Security headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, CSP, HSTS behind HTTPS
- Backend source, dotfiles, `.env*`, database/WAL/SHM and common backup files are blocked from static serving
- Generic 404/500 responses — no stack traces, SQL errors or file paths are returned to clients
- Booking lookup returns only non-sensitive trip fields (no email, phone, licence, notes or customer name)
- All SQL uses parameterised statements; admin routes enforce exact per-staff permissions server-side
- Overlap/quantity checks and POS approvals run inside SQLite transactions
- All user text is length-limited; image URLs are restricted to `http(s)` or relative paths; pricing/VAT/status are always calculated server-side

Before going live:

1. Set `SESSION_SECRET` (long random value), `ADMIN_PASSWORD`, `STAFF_PASSWORD`, and `NODE_ENV=production`.
2. Terminate TLS at Render/your reverse proxy; confirm `Secure` cookies and HSTS in browser devtools.
3. Change seeded demo passwords and restrict admin sign-in to authorised staff only.
4. Confirm `carrental.db*`, `.env`, `server.js`, `db.js`, `package.json` return 404 over HTTP.
5. Manual exploit checks: unauthenticated `/api/admin/stats` → 401; customer token on admin API → 401;
   staff without `view_revenue` on stats → 403; XSS payload in name/notes renders as text;
   idor attempt on `/api/my-bookings/:id/cancel` for another user → 403; rapid failed logins → 429.
6. Keep the database file outside any public directory, back it up privately, and apply OS-level file permissions.

> The CSP currently permits inline scripts because several pages embed small controllers. For an even stricter
> posture, move those scripts into external `.js` files and replace `'unsafe-inline'` with a nonce.
