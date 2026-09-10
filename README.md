# R TEX BD — Premium Three-Piece Commerce

Production-ready Node/Express + Turso website.

## Render environment variables
Only these are required:
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `ADMIN_PASSWORD` (minimum 12 characters)

Admin login ID is fixed to `admin`. The password comes only from `ADMIN_PASSWORD`.

## Run
`npm install` then `npm start`

Open `/` for the storefront and `/admin` for the admin panel.
