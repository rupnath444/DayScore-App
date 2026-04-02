# DayScore-App

## Current Status

The project now includes a modular file structure scaffold to make maintenance, code correction, and targeted testing easier.

The existing production logic is still running from `www/index.html` during migration.

## Project Structure

```text
DayScore-App/
|
|-- capacitor.config.json
|-- package.json
|-- README.md
|
|-- www/
|   |-- index.html
|   |
|   |-- css/
|   |   |-- main.css
|   |   |-- calendar.css
|   |   |-- tasks.css
|   |   |-- notifications.css
|   |   `-- diagnostics.css
|   |
|   |-- js/
|   |   |-- app.js
|   |   |
|   |   |-- auth/
|   |   |   |-- auth.js
|   |   |   `-- session.js
|   |   |
|   |   |-- sync/
|   |   |   |-- syncManager.js
|   |   |   |-- outbox.js
|   |   |   `-- localState.js
|   |   |
|   |   |-- reminders/
|   |   |   |-- reminderManager.js
|   |   |   |-- reminderActions.js
|   |   |   |-- reminderChannel.js
|   |   |   `-- driftMonitor.js
|   |   |
|   |   |-- calendar/
|   |   |   |-- calendarView.js
|   |   |   |-- dayScore.js
|   |   |   `-- milestones.js
|   |   |
|   |   |-- tasks/
|   |   |   |-- taskManager.js
|   |   |   |-- taskLock.js
|   |   |   `-- carryForward.js
|   |   |
|   |   |-- utilities/
|   |   |   |-- pomodoro.js
|   |   |   |-- goalHorizon.js
|   |   |   `-- diary.js
|   |   |
|   |   |-- diagnostics/
|   |   |   |-- debugPanel.js
|   |   |   |-- oemChecker.js
|   |   |   |-- permissionGuide.js
|   |   |   `-- logBuffer.js
|   |   |
|   |   `-- config/
|   |       |-- firebase-config.js
|   |       `-- constants.js
|   |
|   `-- assets/
|       `-- icons/
|
|-- android/
|   `-- app/src/main/google-services.json
|
`-- docs/
	|-- CODE_ANALYSIS_SUMMARY.md
	|-- COMPREHENSIVE_TEST_MATRIX.md
	|-- OFFLINE_SCENARIOS_ANALYSIS.md
	|-- QUICK_TEST_GUIDE.md
	`-- TEST_RESULTS_VERIFICATION.md
```

## Migration Plan

1. Keep app stable with current `www/index.html` runtime.
2. Move notification system to `www/js/reminders/*` first.
3. Move sync/offline logic to `www/js/sync/*`.
4. Move calendar/task rendering to `www/js/calendar/*` and `www/js/tasks/*`.
5. Move remaining utility features and then reduce `index.html` to shell-only.