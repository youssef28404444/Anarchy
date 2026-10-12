# ANARCHY Command Center (Local Development)

This package keeps the **single-page frontend** separate from the **Node.js backend + integrated Discord bot**.

## Folder layout

- `frontend/` — static HTML/CSS/JavaScript SPA. Copy its contents to `C:\\xampp\\htdocs\\ANARCHY\\` to serve it with Apache.
- `backend/` — Express API, Discord OAuth, Discord bot, SQLite database, role sync, clock tracking, announcements, tickets, and audit logs. **Keep this folder outside `htdocs`** so `.env` and the database are not publicly served.

## Local setup (Windows / XAMPP)

1. Extract this project somewhere like `C:\\Users\\Admin\\Desktop\\ANARCHY-Command-Center`.
2. Copy the *contents* of `frontend/` to `C:\\xampp\\htdocs\\ANARCHY\\`. Keep `backend/` in the extracted project folder, not inside `htdocs`.
3. Start Apache from XAMPP.
4. Open a terminal in `backend/` and run:

   ```powershell
   npm install
   Copy-Item .env.example .env
   ```

5. Open `backend/.env` and fill in the Discord settings described below.
6. Start the backend and bot:

   ```powershell
   npm run dev
   ```

7. Open `http://localhost/ANARCHY/`.

If OAuth is not configured yet, the site remains usable in **local preview mode**. Data entered in that mode is only saved in that browser. Once Discord OAuth and the bot are configured, sign in and use the backend-backed modules.

## Discord Developer Portal

- Create/use one Discord application and its bot.
- Add this exact OAuth2 redirect URI: `http://localhost:5000/auth/discord/callback`.
- OAuth scope required: `identify`.
- Enable **Server Members Intent** and **Presence Intent** under Bot settings. Presence-based FiveM activity detection will not work without Presence Intent and appropriate Discord privacy settings.
- Invite the bot to the target guild with only the permissions needed for its configured features: View Channels, Send Messages, Embed Links, Read Message History, and Manage Roles if you want website role management. The bot's highest role must be above every role it needs to assign/remove.

## `backend/.env` values

- `DISCORD_TOKEN`: bot token. Keep secret; never commit it or send it in chat.
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`: OAuth application credentials.
- `DISCORD_REDIRECT_URI`: exact callback URL registered in the portal.
- `DISCORD_GUILD_ID`: the server the bot will sync.
- `BOOTSTRAP_DISCORD_USER_ID`: your own Discord user ID for first-run owner access. This bypass is for initial setup only; keep it private and remove it after assigning the owner role if desired.
- `SESSION_SECRET`: long random secret.
- `FRONTEND_ORIGIN=http://localhost` and `FRONTEND_URL=http://localhost/ANARCHY/` for this XAMPP setup.

## First-run sequence

1. Start the backend and make sure `/api/health` reports the API and bot state.
2. Log in with Discord using the top-right button.
3. Open Dashboard → Settings. Configure the Discord role IDs for Owner, Boss, Co-Boss, Leader, Gang, and section managers. Configure the activity name and channel IDs from the same page.
4. Save settings, then click **Sync Discord Members**. The bot stores each guild member's actual role IDs; the website uses those synced roles to calculate access.
5. Use Dashboard → Discord Members to inspect mapped roles, guild members with no configured role, and previously seen users who are no longer in the guild.

## What is connected in this foundation

- Discord OAuth login/session and server-side permission checks.
- Bot runs in the same Node process as the API (not a separate bot process).
- Guild member/role synchronization at startup, on member/role events, and every five minutes.
- Role assignment/removal from the website with audit logs.
- Website-backed CRUD API for Members, Categories, Tasks, Resources, Gun models/stock, plus image upload endpoint.
- Discord Embed announcement builder/send endpoint.
- Ticket create/reply/claim/close/reopen API and website UI.
- Central audit logs and clock shift review/adjustment APIs.
- Clock In/Clock Out Discord buttons and presence-based auto clock-out. Shift duration is calculated from timestamps when the shift closes, including the seconds left over; it is not rounded up to an extra hour.
- Leaderboard based on recorded shifts, with all-time/weekly/monthly selection in Discord.

Some existing frontend screens (especially Media/Clips/Gallery and the roster's local preview details) still need to be fully switched to server-backed file storage before public multi-user launch. This is a working integration foundation, not a claim that every planned feature is production-finished.

## Legacy clock data

The supplied `clock(3).zip` contained empty SQLite tables, so no historical rows were available to migrate. The backend checks `backend/data/clock-legacy.sqlite` for old `kv` records and imports legacy all-time/week/month totals and active shifts if that file contains data. If your real historical DB is elsewhere, back it up first and place a copy at that path **before the first successful import**. Never overwrite the only copy of the old database.

## Before public hosting

- Set `NODE_ENV=production`, use HTTPS, a strong `SESSION_SECRET`, a persistent session store (Redis/DB; Express MemoryStore is development-only), and restrict `FRONTEND_ORIGIN` to the real website origin.
- Put the backend behind HTTPS/reverse proxy and update `window.ANARCHY_API_BASE` in `frontend/index.html` to the hosted API URL.
- Use a durable upload store and configure backups/retention for uploaded evidence and audit logs.
- Review the bot's permissions and role hierarchy; never expose `.env`, SQLite files, or uploads' private paths via Apache.
