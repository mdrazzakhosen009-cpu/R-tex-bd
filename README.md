# R TEX BD v5

Production-ready fashion commerce website with a secure Admin Panel and Turso/libSQL database.

## Required Render environment variables

- `NODE_ENV=production`
- `TURSO_DATABASE_URL` — your real `libsql://...turso.io` URL
- `TURSO_AUTH_TOKEN` — your Turso auth token
- `ADMIN_EMAIL` — admin login email
- `ADMIN_PASSWORD` — minimum 12 characters
- `SITE_URL` — deployed website URL

Turso is mandatory. The server verifies the connection with `SELECT 1` before initializing the schema. A missing or invalid Turso configuration now fails startup instead of silently creating/using a local database.

## Media uploads

The Admin Panel accepts JPG/PNG/WebP uploads up to 2 MB and stores them in the `media` table in Turso. The returned `/api/media/:id` URL can be used for the logo, landing images, category images, product images/gallery and customer review images.

## Features added in v5

- Admin sidebar menu with mobile toggle.
- Demo fashion products seeded into an empty database.
- Product cards include View details, Add to cart and Order now.
- Product details page includes gallery, variants, Add to cart and Order now.
- Customer Reviews system with rating, text and optional screenshot/photo upload.
- Reviews display inside phone-style cards with automatic horizontal scrolling; hover pauses the scroll.
- Review management is available from the Admin Panel.
- Product/category/landing/service/review image upload can be done directly from Admin Panel.
- Existing good store/order/payment/admin features are preserved.

## Run

`npm install`
`npm start`


## Render deployment
1. Keep these project files at the GitHub repository root: `package.json`, `src/`, `public/`, `scripts/`, `render.yaml`. Do not put them inside an extra `v3work/` folder unless Render Root Directory is set to that folder.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Required environment variables: `NODE_ENV=production`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters).
5. `SITE_URL` is optional. If omitted, robots/sitemap use the live request host automatically.
6. The server verifies Turso with `SELECT 1` before initializing the database. Missing/invalid Turso credentials cause a clear startup failure instead of silently using a local database.

## Included functionality
- Database-driven editable landing page with ordered/visible sections
- Premium responsive storefront
- Demo products seeded only when the products table is empty
- Product details, variants, gallery, Add to Cart and Order Now
- Cart and checkout with server-side price/stock validation
- COD and manual bKash/Nagad/Rocket payment fields
- Order tracking and admin order management
- Admin sidebar, dashboard, CRUD, image uploads and security/password change
- Phone-style customer review cards with automatic horizontal scrolling
- Admin review screenshot/photo upload
- Category/service/FAQ/testimonial/social/landing management
- Contact/leads management
- Turso-backed media storage with `/api/media/:id` URLs


## Optional AI Shopping Assistant
Set `GEMINI_API_KEY` on the server to enable Gemini-powered answers grounded in store products, FAQs and delivery information. Without the key, the assistant falls back to deterministic store-aware replies.
