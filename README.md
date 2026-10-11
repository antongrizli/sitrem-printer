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

For reproducible packaging (including Windows), use explicit builder arguments:

```sh
npm run build
npx electron-builder --mac --arm64 --publish=never
# On Windows, select --x64 or --arm64:
npx electron-builder --win --x64 --publish=never
```

Installer names include the architecture, such as
`SitremPrinter-0.1.6-arm64.dmg` and `SitremPrinter-0.1.6-x64.exe`.

## GitHub release packages

The **Package desktop apps** GitHub Actions workflow builds separate x64 and
ARM64 packages for macOS and Windows. Run it manually from the Actions tab to
produce downloadable workflow artifacts without creating a release.

To create a GitHub Release, update the version in `package.json` and push an
exactly matching `v<version>` tag, such as `v0.1.0`. A mismatched version tag
fails validation before packaging. Successful tag builds attach all four
installers, blockmaps, and SHA-256 provenance manifests to a release with
generated notes. Each native packaging job launches the unpacked application
and verifies the settings IPC bridge and print-renderer isolation. PRs and
all repository pushes run lightweight validation rather than installer builds.

Use `./scripts/bump-version.sh major`, `minor`, or `patch` to update the npm
version and lockfile without committing or tagging. Commit its changes, then
push the printed `v<version>` tag to start a release build.

Default packages are unsigned and unnotarized pilots; tag releases are marked
as prereleases. Gatekeeper and SmartScreen may warn. Manual production builds
use the protected `release-signing` environment and require `MAC_CSC_LINK`,
`MAC_CSC_KEY_PASSWORD`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` secrets. Configure environment
approval rules before enabling production builds. CI rejects invalid signatures
or missing macOS notarization. Actual downloadable-installer qualification is
still required; automated checks do not certify printer compatibility.

Publication creates a draft, verifies every asset, and publishes only after the
complete inventory is uploaded. Reruns accept identical existing assets and
reject conflicting hashes. If publication fails, run **Recover release
publication** with the existing tag and original package run ID before artifacts
expire. It checks the tag commit, successful packaging jobs, source run, and
asset hashes without rebuilding or retagging. Rerunning an old build uses its
original commit, not subsequent fixes.

Automatic updates are disabled. No placeholder update URL is required. Enabling
updates later needs a separate signed, architecture-aware feed design.

## Configuration and connection

Open **Configuration** from the tray menu to set the portal URL, one-time pairing
code, Connector name, and exact system printer name. The pairing code is never
stored. The machine bearer token is encrypted through Electron `safeStorage`,
which uses macOS Keychain or Windows operating-system credential protection.

Remote portals require HTTPS. Loopback HTTP is allowed for development;
trusted-LAN HTTP requires the explicit insecure-mode checkbox and exposes
credentials in transit. URLs may have a base path but not userinfo, query, or
fragment components. Paired portal identity cannot be changed with Save settings:
use a new pairing code. Failed pairing preserves the previous session.

Start-at-login is opt-in and runs in the signed-in user's session. Configuration
opens on first use, tray activation, and second-instance activation.

The tray status dot is green while connected or printing and red while unpaired,
connecting, offline, revoked, or in error. Right-click the tray icon to see the
current portal status, selected printer, configuration action, and exit action.

## Security and durability

- The renderer receives only a narrow typed IPC API and never receives the token.
- Pairing inputs, persisted settings, and portal jobs are runtime-validated.
- Label scripts, event handlers, forms, frames, remote URLs, and imports are rejected.
- The hidden print window disables JavaScript and blocks non-data resources.
- Production and calibration prints share one bounded FIFO queue.
- Versioned, identity-scoped receipts suppress repeated job submissions. An
  uncertain result becomes `attention`, not an automatic reprint. Spool acceptance
  does not guarantee physical printing or exactly-once delivery.
- Corrupt or newer-schema storage blocks printing; it is never silently reset.
- HTTP and print operations have deadlines; timed-out printing remains uncertain.
- Exact label dimensions are sent to Electron in micrometres with zero margins and 100% scale.

## Recovery and platform qualification

The application migrates legacy settings/credentials into one encrypted session
record and retains journal receipts with last-known-good backups. Preserve the
entire user-data directory before upgrades or recovery. Do not delete the journal
to clear an error: that discards duplicate-suppression evidence. Unknown newer
schemas intentionally block rollback until a compatible recovery is available.
Completed receipts currently remain indefinitely (bounded to 10,000); retention
requires the portal's documented replay window.

Use **Export recovery and diagnostics** for redacted local events and outstanding
job IDs. It excludes credentials, pairing codes, and label content, but includes
printer names and job identifiers: review before sharing. For `attention`, check
the physical output and portal record with an operator; no automatic retry or
destructive local reset is provided.

Windows x64/ARM64 and macOS ARM64 are the primary targets; macOS Intel packaging
is retained. Native launch is not proof of installer or driver compatibility.
See [implementation status](IMPLEMENTATION_STATUS.md) for remaining acceptance
gates and the hardware qualification checklist.

## Label compatibility and recovery update

Current portal labels and older immutable snapshots with safe UTF-8 metadata, inert barcode/layout attributes and grid functions are supported. Unsafe executable or remote markup remains blocked. Portal stock dimensions must use 0.1 mm steps. HTML owns content rotation; Electron keeps the physical stock orientation fixed, including for landscape labels. Qualify both orientations on the target driver.

Validation and definite pre-submission failures retain specific error codes and corrective actions. Uncertain results remain operator-review outcomes. Journal v1 receipts migrate to v2 with a backup so older apps block incompatible rollback instead of dropping recovery flags. Acknowledgement conflicts are reconciled through the Connector-authenticated job-state endpoint; mismatches retain `reconciliationRequired` receipts and do not prevent subsequent claims. Transport failures for one receipt also leave it pending without blocking other recovery. Export diagnostics includes the reconciliation flag, without credentials or label content.

Recover old failed labels through the portal's **Replace label job** action after upgrading. The portal assigns a new job ID, re-renders the current original ticket/template, and preserves the original record. For uncertain results, inspect the physical printer before confirming that no label printed. Never delete saved receipts to bypass duplicate suppression. Deploy the matching portal recovery update before relying on these semantics.

`scripts/run.sh` rebuilds when source files, package manifests, or Electron configuration are newer than compiled output. Use `npm run build` explicitly for upgrades and confirm the running Connector build/version. `test/fixtures/portal-labels.json` is generated by SITREM's `scripts/generate-print-contract.ts`; copy intentional fixture changes after review, and run both repositories' contract tests.

### Bidirectional label formats

The Connector reads the current `/media` revision before publishing a local format, accepts the portal `media` response, and checks for remote updates every heartbeat (30 seconds). Conflicts preserve the local selection and require **Use portal format** or **Keep local format**. The chosen format is a software setting; verify the physical stock separately. The Connector reports its applied revision in the heartbeat. Portals lacking the media endpoint retain legacy local behavior. Existing jobs retain their original immutable size.
