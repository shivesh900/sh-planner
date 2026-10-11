# SH PLANNER

**Planner + notebook + habits in one app.** Offline-first, private (no login, all data on your device), installable as a PWA and as an Android app.

Live: https://shivesh900.github.io/sh-planner/ · Android APK: [downloads/SH-PLANNER.apk](downloads/SH-PLANNER.apk)

## Features
- **Smart day & week planner**: hourly timeline, drag to move (long-press on touch), drag the bottom edge to resize, tap an empty slot to add. Week and month views. Recurring tasks (daily / weekdays / weekly / monthly), priorities, deadlines, estimated duration, categories.
- **Natural-language quick add**: "Study DSA 6-8pm tomorrow", "Gym 7am daily", "OS assignment by fri !high ~2h #college".
- **Smart slots**: suggests free time for unscheduled tasks by priority, deadline and length. One tap to accept.
- **Reminders**: task reminders, deadline alerts (day before, on the day, 1 h before), and a daily planning nudge. The Android app uses real OS alarms (they fire when the app is closed, offline, or after a reboot). The web version alerts while it's open.
- **Notes linked to tasks and days**: attach notes, checklists, images and info to any task or date. A daily note for every date.
- **Rich notebook**: headings, bold/italic/underline/strike, bullet, numbered and check lists, quotes, code, images, tags, folders, pin, instant full-text search. Markdown shortcuts (`# `, `- `, `[] `, `> `).
- **Daily dashboard**: today's progress, now/next, pending and completed tasks, upcoming deadlines, habits.
- **Habit tracker**: streaks, best streak, weekly consistency, 12-week heatmap.
- **Backup & restore**: one JSON file including images. Plus .ics export for Google Calendar.
- Dark and light themes, mobile-first, bottom navigation.

## Tech
Vanilla JS (ES modules), no build step. IndexedDB storage (images as compressed Blobs). Service worker for offline use. Android app via Capacitor with `@capacitor/local-notifications`.

Tests: `npm test` (Node's built-in test runner) covers quick-add parsing, recurrence, the reminder schedule, habit streaks, smart slots, layout, ICS export and the PWA shell.
