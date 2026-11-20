# Desktop builds and releases

This is a maintainer reference. For installation and normal use, start with [Getting started](getting-started.md).

## Platforms and prerequisites

| Platform | Release runner | Packages | In-app update |
| --- | --- | --- | --- |
| macOS, Apple Silicon | `macos-26` arm64 | Signed/notarized DMG + ZIP | ZIP through Squirrel.Mac |
| Windows, x64 | `windows-2025` | Unsigned per-user NSIS installer | NSIS |
| Linux, x64 | `ubuntu-24.04` | AppImage + `.deb` | AppImage replacement; `.deb` through dpkg/apt, with elevation if needed |

Windows may show SmartScreen/unknown-publisher warnings. AppImage is the primary Linux download; `.deb` updates may require an administrator password. Both use the same download/restart banner. Targets/signing are defined in [`electron-builder.yml`](../electron-builder.yml); CI/release uses **Node 26**.

Icons are per-platform (2026-10-13): macOS compiles the Icon Composer document `build/icon.icon` via actool into `Assets.car` (macOS 26 Liquid Glass) plus a fallback icns that `scripts/after-pack.cjs` replaces with the hand-packed full-res `build/icon.icns` (actool's caps at 256px); Windows embeds `build/icon.ico` and Linux uses `build/icon.png`, both generated from the flat design (`build/icon-flat.svg`) by `node scripts/make-icons.mjs`. Building the mac icon needs **macOS 26+ and Xcode 26+** (`actool`): Xcode 26's asset compiler crashes on macOS 15 because its host frameworks lack required symbols. `desktop:dist` injects `DEVELOPER_DIR` locally; release packaging uses `macos-26` and selects Xcode via setup-xcode. The older-OS fallback icon remains included. Linux's desktop identity is `learnharness.desktop`. Public package-maintainer metadata uses the owner's GitHub no-reply address; support goes through [GitHub Issues](https://github.com/vinceychu/meander/issues).

## Build pipeline

Build **on each target OS**. Next traces native binaries for its build machine; a macOS standalone tree is not a Windows/Linux payload.

1. `npm ci`
2. Run native renderer/browser-service tests in Electron's Node:
   ```sh
   ELECTRON_RUN_AS_NODE=1 NODE_ENV=test npx electron --import tsx --test tests/pdf-native-render.test.ts tests/pdf-ops.test.ts tests/svg-native-render.test.ts tests/browser-service.test.ts
   ```
   This environment-prefix syntax is for a POSIX shell; CI uses Bash on every OS.
3. `npm run build`
4. `node scripts/smoke-provider-runtime.mjs` — check the **fresh trace before curation**, including native provider initialization and fixture payloads, not real sign-in/generation.
5. `node scripts/build-server.mjs` — copy static assets, validate prompt assets, refuse known data/credential leaks, and remove only standalone-root old installers/development Electron.
6. `node scripts/smoke-server.mjs --electron` — check renderer/demo dependencies, providers, gzip backpressure, and isolated standalone HTTP boot under Electron's Node.
7. Package with Electron Builder using the appropriate local/release policy below.

The shell/updater ships in `app.asar`; the server/native renderers ship unpacked as `extraResources`. Pi/PDF/canvas/resvg/Photon dynamic assets are explicitly traced in [`next.config.ts`](../next.config.ts). Keep trace exclusions narrow: broad `dist/**` or `data/**` patterns can remove dependency assets. Curation guards are not a substitute for inspecting a changed payload.

The release workflow also checks providers from the **packaged** payload under host Node and packaged Electron, then exercises the demo helper using the app's Electron (Xvfb on Linux). HTTP boot or catalog output alone does not test these lazy paths.

`smoke-image-runtime.mjs` separately checks synthetic Photon in-process/worker resizing in standalone output. It accepts `--standalone <dir>` and `--runtime <binary>`; it is **not currently invoked by CI/release workflows**.

### Local packages

`npm run desktop:dist` is the local **signed macOS** path using the `LH_NOTARY` keychain profile and Xcode `DEVELOPER_DIR`. It clears `dist` and `.next/standalone`, builds, checks the fresh provider trace, curates, runs the server smoke under **host Node**, and packages. It does not itself run the Electron-Node/post-package gates or the tag-upload workflow.

For Windows/Linux, perform steps 1–6 on that OS, then:

```sh
npx electron-builder --win --x64 --publish never    # Windows
npx electron-builder --linux --x64 --publish never # Linux
```

## CI and release modes

[CI](../.github/workflows/ci.yml) runs typecheck/tests/lint on Ubuntu, plus standalone/native checks on macOS, Windows, and Linux. Its `macos-15` job does not compile the release icon.

[Desktop release](../.github/workflows/release.yml) has two modes:

- **Manual dispatch:** unsigned rehearsal installers retained as workflow artifacts for seven days. No signing secrets, release creation, or publication. macOS notarization is skipped; these are not production installers.
- **Matching `v<package.json version>` tag:** gates, one shared draft-preparation job, three OS packaging/upload jobs, then read-only draft verification. Published/ambiguous existing releases fail preparation; same-ref runs serialize rather than cancelling uploads. macOS must sign/notarize. **The workflow never publishes the draft.**

### Draft verification

[`scripts/verify-release.ts`](../scripts/verify-release.ts) runs after all packaging jobs. It requires one draft matched by `v<version>` or bare `<version>`, refusing zero/two matches or a published match. Bare-version matches warn because later runs could split assets across tags.

The draft must contain **exactly 11 uploaded, nonempty assets**:

`verify` runs only on tag pushes (`needs: package`, so after **all three** packaging legs; manual rehearsals upload nothing and skip it). It checks out the tagged revision without persisting credentials and runs `scripts/verify-release.ts`. GitHub requires push access to list **draft** releases, so this job needs `contents: write` even though every API operation is GET-only. The token is exposed only to the release-list and feed-download steps, not dependency installation or the offline validator. The validator:

- finds the draft using the same tag matching as the draft job and electron-builder's publisher — `tag_name` equals `v<version>` **or** the bare `<version>`; zero matches, two matches, or an already-published match fail the run, and a draft matched only via the unprefixed form is flagged with a warning (a later run could create a second draft under the `v`-tag and split the assets — rename before publishing);
- fails unless the release holds **exactly** these 11 assets — nothing missing, nothing extra (a stale name from an older run is an error), nothing zero-size, nothing still in a non-`uploaded` state:

| Asset | Role |
|---|---|
| `Meander-<v>-arm64.dmg` + `.blockmap` | macOS installer |
| `Meander-<v>-arm64-mac.zip` + `.blockmap` | macOS updater payload (Squirrel.Mac installs from the ZIP) |
| `Meander-<v>-x64-setup.exe` + `.blockmap` | Windows NSIS installer |
| `Meander-<v>-x86_64.AppImage` | Linux AppImage (no sidecar blockmap) |
| `Meander-<v>-amd64.deb` | Linux deb (no sidecar blockmap) |
| `latest-mac.yml` / `latest.yml` / `latest-linux.yml` | updater feeds |

Feed versions, exact referenced asset sets, bare filenames, sizes, and legacy path/hash fields must agree; macOS's ZIP must be first. Missing/stale extra assets, path traversal/URLs, or builder naming drift fail validation. The validator does not download/hash every installer; it checks draft metadata and downloaded feeds.

The verification job needs `contents: write` to list private drafts but performs GET-only operations. Its token is exposed only to release listing/feed download, not dependency installation or offline validation.

### Signing secrets

Repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application `.p12`, including private key |
| `MAC_CSC_KEY_PASSWORD` | `.p12` password |
| `APPLE_ID` | Notarization Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple developer team ID |

The workflow maps the certificate to `CSC_LINK`/`CSC_KEY_PASSWORD`; signing credentials reach packaging only, not the Next build. The built-in `GITHUB_TOKEN` supplies scoped `GH_TOKEN`; no separate release token is needed. Never commit keys, certificates, passwords, or environment-secret files.

## Release runbook

1. Agree scope/version and complete relevant gates and human functional acceptance. Use manual dispatch if rehearsal installers are useful; unsigned rehearsal does not prove macOS signing.
2. Update package/lockfile versions, check the intended source on main, and push the authorized matching tag. Verify signing secrets before production macOS packaging.
3. Wait for **all OS jobs and Verify draft release**. Inspect the single draft's tag, notes, 11 assets, and feeds. Diagnose failures before retrying. Re-upload replaces same-named assets; stale extras still fail. Deleting assets/releases is a mutation, not verification.
4. If editing draft metadata, include canonical **`tag_name: "v<version>"` in every metadata PATCH**, even for title/body changes; omission has reset tags before. Re-read tag, draft status, and assets afterward. A tag correction does not authorize deleting/recreating a release.
5. The owner checks the packaged build as needed and explicitly publishes the complete draft. Confirm public installers/feeds and website links; use a prior installed version for real update-path checks.

Shell, native-module, packaging/updater, or Electron changes warrant focused platform checks: install/open, window controls/dragging/zoom, setup/resume, PDF/SVG, and demo helper. Fixture gates do not prove account functionality or lesson quality. Do not repeat accepted feature testing without a concrete risk.

## Updates and website notification

Packaged apps check at startup and every 24 hours by default, download automatically, and install on quit or Restart. **Settings → General** provides release notes, manual checks, status, and Automatic updates. Disabling automatic checks does not cancel downloads/staged installs; manual checks still download updates. Dev builds disable the updater. Errors go to `userData/logs/main.log`; `LH_UPDATE_FEED` is a test-only generic-feed override.

Sources: [`electron/main.cjs`](../electron/main.cjs), [`preload.cjs`](../electron/preload.cjs), [`update-settings.tsx`](../components/settings/update-settings.tsx).

After stable publication, [`notify-website.yml`](../.github/workflows/notify-website.yml) dispatches the tag to the website using `WEBSITE_DISPATCH_TOKEN`. Drafts/prereleases do not trigger it. HTTP 204 means the website update was queued, not deployed or publicly verified.
