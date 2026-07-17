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

Create distributable packages after configuring platform signing credentials:

```sh
npm run package:dir # unpacked smoke-test application
npm run package:mac # DMG
npm run package:win # NSIS installer
```

Set `SITREM_UPDATE_URL` to the release feed when packaging releases. Signing,
macOS notarization, and updater activation are separate release tasks.

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
