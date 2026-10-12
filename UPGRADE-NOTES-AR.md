# ANARCHY v4 — Upgrade Notes

- Improved social channel cards with platform marks and uploaded creator portraits.
- Added Discord Markdown bold/italic/code rendering and true inline-field preview to Announcement Builder.
- Added authenticated AC Gang clip/photo submission endpoint, administrator review endpoint, audit entries, and Discord Accept/Reject buttons.
- Added separate Discord request channel settings: `clipRequestChannelId` and `galleryRequestChannelId`. Select these from Dashboard Settings after restarting the backend.
- Public member sync now overlays persistent `memberProfiles` records over Discord names/avatars/roles instead of blindly replacing curated profile fields. The profile overlay can be saved through the existing `/api/data/memberProfiles` endpoint.
- Existing `.env` and SQLite data are intentionally not included in this archive; keep your local files.

## Important setup
1. Keep your current `.env` and database.
2. Run `npm install` in `backend` only if dependencies are missing.
3. Restart `npm run dev`, sign in with Discord, then configure `Clip Request Channel` and `Gallery Request Channel` in Settings.
4. Discord bot must have View Channel, Send Messages, Embed Links, Attach Files and Use External Emojis as applicable. Place its role above roles it needs to manage.
5. Video uploads are capped at 100 MB. For public deployment, configure a persistent uploads volume and HTTPS; localhost upload URLs are not reachable by Discord.

## Testing status
JavaScript syntax checks are performed on this archive. A live Discord OAuth/guild/interaction test is not possible in this environment; test approvals using a staging Discord channel before production use.


## Fixes in this build
- Fixed duplicate `records.id` errors when accepting uploads by assigning published content a separate ID from its moderation request.
- Made approval/rejection transactional and scoped updates to the correct request collection.
- Fixed frontend image/video URLs so uploads resolve against the backend (`http://localhost:5000/uploads/...`) instead of the XAMPP frontend path.
- Added platform logo assets in `frontend/imgs/`: `kick-logo.svg`, `tiktok-logo.svg`, and `youtube-logo.svg`.
- Added a medium-sized red cursor glow above page layers without blocking clicks.
- For a remote deployment, set `PUBLIC_BASE_URL` to the backend's publicly reachable URL. Discord receives uploads as attachments, so it can display them even when testing locally.


## v6 task management improvements
- Moved toast notifications to the top center so errors and success messages remain visible without scrolling.
- Added reusable Task Presets (create once, select later) separate from active assigned tasks.
- Active tasks now require selecting a saved preset and an actual synced Discord member with the configured AC Gang role.
- Task entries record the signed-in account as creator, show who created each task, and write local audit entries plus Discord log embeds using the configured log channel.
- Added `/api/tasks/assignable-members`, protected by `tasks:manage`; it only returns in-guild members whose synced role IDs include the configured AC Gang role.
- Added `taskTemplates` as a backend collection. Existing task records are preserved.
- No existing database/cache was automatically wiped; make a backup and explicitly reset data only if you intend to permanently delete your saved members, tasks, media and settings.


## v7 — reliability pass based on the supplied v6 archive
- Fixed a missing `taskTemplates` permission mapping that caused task preset sync to fail.
- Added the missing Task Proof file/drop/paste controls referenced by the frontend script. This also fixes a startup crash caused by event listeners being attached to nonexistent task proof elements.
- Task creation now uploads proof images to the backend when signed in, waits for preset sync, and waits for the server to accept the task before reporting success.
- The backend now validates new task presets and verifies that the assignee is a synced, in-guild member with the configured AC Gang role.
- Task and preset creator attribution is derived from the authenticated session on the backend instead of trusting the browser.
- Public Gallery/Clips pages now load published content on navigation and resolve `/uploads/...` URLs against the backend. Submission previews, resource images, weapon images, and leaderboard portraits use the same URL resolver.
- Toast notifications are fixed to the top center and remain above page layers; the mouse glow is slightly smaller.
- Added JSON responses for upload/server errors instead of leaking an HTML error page.
- Validation performed here: `node --check` passed for backend and frontend JavaScript; static HTML-ID consistency check found no duplicate IDs or missing static IDs. Live Discord interactions and browser E2E were not run in this environment.
