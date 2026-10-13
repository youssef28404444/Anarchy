# ANARCHY Discord Bot — Python

This is a separate Python `discord.py` worker, not the old bundled Node.js bot. It syncs guild members/role IDs to the PHP backend through authenticated private endpoints, refreshes role/channel option data, and provides `!anarchy-ping`.

Setup steps are in `../README-AR.md`.

**Important:** this is the first migration stage, not a feature-complete port of the former bot. The old Node bot also handled clock panels, leaderboard panels, announcements, task/submission notifications and review buttons. Those must be ported and tested before the old bot can be retired. Website endpoints that need those unported actions report that the bot service integration is not yet available rather than pretending success.
