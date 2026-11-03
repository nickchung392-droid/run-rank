# Run Rank

A personal running web app for iPhone and desktop. Track runs with foreground GPS, enter completed runs, import timed GPX activities, and turn effort into levels and milestones.

## Use on iPhone

Deploy the contents of `dist/` to an HTTPS static web host, open that URL in Safari, then use Share → Add to Home Screen. If offered, enable Open as Web App. Open the new icon once while online to prepare the offline shell.

GPS recording requires location permission, an outdoor signal, and the app visible with the screen unlocked. It pauses on app switching or screen lock. Browser wake lock is requested where available. This is a web app; it does not provide native background GPS recording or a direct Strava account connection.

## Personal data

Run history lives in localStorage in the current browser. Unfinished GPS recordings are recovered from sessionStorage where available. Different devices and browser installations have separate histories. Clearing website data can remove history. Export JSON backups in Settings; restoring a backup replaces the current history after confirmation. GPS/GPX activity details also support route export to GPX.

## Progression

Each valid saved run earns 50 XP plus floor(distance in km × 100). Each 500 XP adds a level. Game ranks unlock at 0, 500, 1,500, 3,500, 7,000, and 12,000 XP. Milestones award badges, without bonus XP. These are personal effort ranks, not population placements. Deleting a run recalculates progress.

## Local development

No dependency installation or build is needed. Serve `dist/` with a static HTTP server, for example `python3 -m http.server 4173 --directory dist`. Open localhost for development. Phone access and production GPS need HTTPS. Run `node --test tests/*.test.mjs` for the 20 automated progression, validation, distance, and GPS-state tests.

`tests/browser-qa.html` is a temporary browser parser test fixture. To run it, copy it into `dist/`, open it through the static server, then remove it from `dist/` before publication. It verifies timed GPX segments and rejects missing timestamps, malformed XML, and invalid dates.

## Verification

The desktop and 390 × 844 phone layouts were inspected. Manual save, XP award, milestone unlock, reload persistence, and profile/goal updates were exercised in the browser. The browser-native GPX parser passed its synthetic fixture checks. The browser extension blocked file-picker automation; the complete file-picker import and real outdoor iPhone GPS remain device checks. Offline and home-screen behavior depend on the browser and hosting environment and should be checked on the target iPhone before relying on them for a run.

## Files

- `dist/app.mjs`: views, forms, local persistence, backup/import flow.
- `dist/engine.mjs`: validated records, XP, ranks, weekly totals, milestones.
- `dist/tracker.mjs`: foreground GPS recorder and GPX parser.
- `dist/styles.css`: responsive layout.
- `dist/sw.js`, `dist/manifest.webmanifest`: offline shell and home-screen metadata.

## Design

[Run Rank — App Design in Figma](https://www.figma.com/design/6kNf0vCv248Zx13juVVfhs) contains 30 editable iPhone and desktop screens. Figma access is managed separately from this public source repository.

## Hosting

Publish the contents of `dist/` using any static host that supports HTTPS. There is no server, database, API key, or build step. The manifest and service-worker paths are relative, so the app can also be served from a repository subdirectory.

Publishing this repository makes the source available; it does not by itself create a live website. The original hosting service’s project configuration is intentionally excluded from this portable copy.
