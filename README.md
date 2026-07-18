# SitremPrinter

SitremPrinter is a TypeScript Electron tray application that receives label jobs
from a SITREM portal and sends validated, self-contained HTML/SVG labels to a
selected system printer. Its configuration window is built with React and all
privileged operations remain in the sandboxed Electron main/preload boundary.

## Requirements

- Node.js 22.17 or later
- npm
- A system printer driver installed on the computer

## Install, develop, build, and run

```sh
npm ci
./scripts/dev.sh    # Electron + React development with HMR
./scripts/test.sh   # Vitest suite
./scripts/build.sh  # strict typecheck, tests, production compilation
./scripts/run.sh    # run the compiled tray application
```

`run.sh` builds automatically only when compiled output is missing. SitremPrinter
uses Electron's single-instance lock, so running the script again exits without
creating another tray item or polling loop.

Create distributable packages locally:

```sh
npm run package:dir # unpacked smoke-test application
npm run package:mac # DMG
npm run package:win # NSIS installer
```

Pass `--x64` or `--arm64` after `--` to select an architecture, for example
`npm run package:mac -- --arm64`. Installer names include the architecture, such
as `SitremPrinter-0.1.0-arm64.dmg` and `SitremPrinter-0.1.0-x64.exe`.

## GitHub release packages

The **Package desktop apps** GitHub Actions workflow builds separate x64 and
ARM64 packages for macOS and Windows. Run it manually from the Actions tab to
produce downloadable workflow artifacts without creating a release.

To create a GitHub Release, update the version in `package.json` and push an
exactly matching `v<version>` tag, such as `v0.1.0`. A mismatched version tag
fails validation before packaging. Successful tag builds attach all four
installers and their blockmaps to a release with generated notes.

Use `./scripts/bump-version.sh major`, `minor`, or `patch` to update the npm
version and lockfile without committing or tagging. Commit its changes, then
push the printed `v<version>` tag to start a release build.

CI packages are unsigned and the macOS package is not notarized. macOS
Gatekeeper and Windows SmartScreen may therefore warn when they are opened.
Code signing, notarization, updater feed metadata, and updater activation are
separate release tasks. CI uses the non-routable `https://updates.invalid/`
placeholder required by the current packaging configuration. Set
`SITREM_UPDATE_URL` when packaging for a real external generic update feed.

## Configuration and connection

Open **Configuration** from the tray menu to set the portal URL, one-time pairing
code, Connector name, and exact system printer name. The pairing code is never
stored. The machine bearer token is encrypted through Electron `safeStorage`,
which uses macOS Keychain or Windows operating-system credential protection.

Both HTTP and HTTPS portal URLs are supported. Use HTTP only on a trusted local
network; use HTTPS whenever Connector traffic crosses an untrusted network.

The tray status dot is green while connected or printing and red while unpaired,
connecting, offline, revoked, or in error. Right-click the tray icon to see the
current portal status, selected printer, configuration action, and exit action.

## Security and durability

- The renderer receives only a narrow typed IPC API and never receives the token.
- Pairing inputs, persisted settings, and portal jobs are runtime-validated.
- Label scripts, event handlers, forms, frames, remote URLs, and imports are rejected.
- The hidden print window has an isolated in-memory session that blocks HTTP/HTTPS resources.
- A local journal prevents automatic duplicate printing after a restart or uncertain result.
- Exact label dimensions are sent to Electron in micrometres with zero margins and 100% scale.
