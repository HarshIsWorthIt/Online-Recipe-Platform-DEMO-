# Recipely — Local Recipe Sharing Platform

Recipely is a complete local web app with a frontend, backend API, and persistent SQLite database. It has no package installation step and does not send your data anywhere.

## Start it

1. Double-click [start-recipely.bat](start-recipely.bat), or open this folder in a terminal and run `node server.js`. The included local runtime already supports it; if you use this project outside Codex, install Node.js 22 or newer first.
2. Visit **http://127.0.0.1:3000** in your browser.
3. Keep the small server window open while using the app. Press `Ctrl+C` there when you want to stop it.

The first launch creates `data/recipely.db`, which permanently stores local accounts, recipes, reviews, collections, messages, and settings.

## Production launch

Use Node.js 22 or newer. Production mode disables demo seeding and requires a first administrator:

```powershell
$env:NODE_ENV = 'production'
$env:APP_ORIGIN = 'https://recipes.example.com'
$env:ADMIN_EMAIL = 'admin@example.com'
$env:ADMIN_PASSWORD = 'use-a-unique-password-at-least-12-characters'
node server.js
```

Set `COOKIE_SECURE=true` when serving over HTTPS. If TLS is terminated by a trusted reverse proxy, set `TRUST_PROXY=true`; otherwise leave it disabled. The `/healthz` endpoint can be used for process checks. Keep the `data` directory on persistent storage and back it up using a SQLite-aware process.

## Demo accounts

| Role | Email | Password |
|---|---|---|
| Administrator | `admin@recipely.local` | `Admin@123` |
| Recipe contributor | `maya@recipely.local` | `Chef@123` |
| Recipe explorer | `jordan@recipely.local` | `Explore@123` |

You can also create your own account from the registration screen. A contributor or general user can submit recipes; an administrator approves them.

## Included features

- Secure password hashing, login/logout, registration, profiles, and role-based access
- A World Kitchen starter catalog spanning 21 food cultures, with discovery filters for nation, flavour profile, category, and cooking time
- Recipe creation, editing, deletion, approval workflow, search, filters, detail pages, and image URLs
- Ratings/reviews, saved collections, recipe view counts, user messages, and activity history
- Contributor dashboard and a full admin area for users, moderation, settings, and statistics
- An animated, motion-aware visual background and responsive polished interface

## Reset local data (optional)

To return to the starter accounts and recipes, first stop the server, then delete only `data/recipely.db`, `data/recipely.db-shm`, and `data/recipely.db-wal`. Start the app again and it will create a fresh starter database.
