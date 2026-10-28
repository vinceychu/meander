# Meander guide

**Meander** — Copyright © 2026 Vincent Chu. Features:

1. **Spaced review**: knowledge decay and Anki-style revisiting
2. **Your own CLI tools and modules** attached to practice sessions
3. **Find Everything**: search sessions, ideas, and your files, from anywhere on the desktop
4. **Multi-device sync** through a synced folder
5. **Anki export** of your whole knowledge graph
6. **Learn a whole folder**: a lesson over it, or import its notes into the graph
7. **Study stats**: streak, study time, retention, review forecast
8. **Sandboxed CLI tools** (tools run with no network and read-only files by default)
9. **Automatic updates** from your own GitHub repo, on Linux and Mac

**About the name:** everything you see says Meander. A few hidden internal labels keep the old name on purpose: the data folder (`~/.config/LearnHarness`, `~/Library/Application Support/LearnHarness`), the `learnharness` command, and the app id. Renaming those would orphan your data and settings. 

---

## Install

### Linux (this PC)

```bash
npm run desktop:dist:linux
```

This writes `dist/Meander-<version>-x86_64.AppImage` and a `.deb`. Install either one:

```bash
sudo apt install ./dist/Meander-*-amd64.deb
```

Or keep the AppImage in `~/Applications` and make it executable. It then shows up in your app launcher, so you can search for "Meander" from the desktop.

### Mac (Apple Silicon or Intel)

A Mac app has to be built on a Mac. Copy or clone this folder over, then:

```bash
npm ci
npm run desktop:dist:mac-unsigned
```

It builds for the Mac you run it on (Apple Silicon or Intel). Open the `.dmg` in `dist/` and drag Meander to Applications. The build is ad-hoc signed, not notarized. If you build it on the same Mac it opens normally. If you copy the `.dmg` from another machine, run `xattr -cr /Applications/Meander.app` once.

### First run (each device)

Add a provider API key and pick models (Anthropic, OpenAI, OpenRouter, …). Keys are stored **per device** in the app's private folder and never sync.

---

## 1. Spaced review (knowledge decay)

**The problem:** a problem solved today can feel hard two weeks later.

**How it works:**

- Each proposition (node) in your knowledge graph gets a *memory stability*: the number of days until its estimated recall drops to 90%. The forgetting curve is `recall(t) = 0.9^(t / stability)`.
- A newly learned node starts at 1 day, so it comes up for review the next day, like a new Anki card.
- Every `conclude` in a practice session counts as a review grade for the propositions that problem targeted:

  | outcome | grade | effect |
  |---|---|---|
  | solved, no hints | easy | stability × ~3+ |
  | solved, light nudge (R0/R1) | good | stability × ~2.5 |
  | solvedWithHints, or heavy hints | hard | small growth, lower ease |
  | movedOn / surrendered / dismissed | again (lapse) | stability × 0.3, lower ease |

- Recalling something you had partly forgotten grows stability more than recalling it while it was fresh. This is the *spacing effect*.

**Where you see it:**

- **Home → "N due for review" pill.** Clicking it switches to Practice mode, picks the 12 most faded propositions, and fills in the prompt.
- **Agents → `review_queue` tool.** The practice agent checks it and folds due prerequisites into whatever you're practicing. The prober (start of a teaching session) uses it to re-check strands you once knew but that may have faded.
- **API:** `GET /api/review`

**Design choice worth learning from:** nothing new is stored. The app's core rule is *"writes point to append-only evidence, and everything else is derived."* The practice results already sit in your session files, so the schedule is recomputed from them on every read. This also keeps the knowledge graph free of ability scores.

**Code:**
- `src/core/review.ts`: the whole algorithm (pure functions, start here)
- `src/agent/tools/review.ts`: the agent tool
- `src/agent/prompts/practice/20-spaced-review.md`, `src/agent/prompts/prober/20-spaced-review.md`: instructions to the agents
- `components/practice-extras.tsx`: the pill
- `tests/spaced-review.test.ts`

**Ideas to improve it yourself:** fit the multipliers to your own history (real FSRS fits per-user parameters); also count teaching-session quiz results; show recall as color on the graph canvas; add a "due" filter to the chain table.

---

## 2. Your own CLI tools and modules

Put one JSON file per tool in the `tools` folder of your data folder (desktop app: **File → Open Tools Folder**). Example `python.json`:

```json
{
  "name": "python",
  "description": "Run a Python 3 program and return its output — use it to check numeric answers.",
  "command": "python3",
  "args": ["-"],
  "stdin": true,
  "inputDescription": "Python source code",
  "timeoutSeconds": 20,
  "default": true
}
```

| field | meaning |
|---|---|
| `name` | lowercase id; the agent sees a tool called `cli_<name>` |
| `description` | tells the agent when to use it |
| `command` | program on PATH, an absolute path, or `./script` relative to the tools folder |
| `args` | fixed arguments; `{{input}}` is replaced by the agent's input |
| `stdin` | `true` = the agent's input is piped to stdin |
| `timeoutSeconds` | 1 to 600; the process is killed after this |
| `cwd` | optional working directory (`~` = home) |
| `default` | pre-selected when you start a practice session |
| `sandbox` | `true` by default; set `false` to run with your full permissions (the chip shows a `!`) |

**A "module" is just a script.** Write `my-checker.mjs` in the tools folder and use `"command": "node", "args": ["./my-checker.mjs"], "stdin": true`.

More examples:

```json
{ "name": "sqlite", "description": "Run SQL against the course database.", "command": "sqlite3", "args": ["~/course/db.sqlite"], "stdin": true }
{ "name": "gcc-run", "description": "Compile and run a C program.", "command": "./run-c.sh", "stdin": true, "timeoutSeconds": 30 }
```

**Using them:** in Practice mode, the tool chips appear above the composer. Toggle the ones you want, then start the session. They're saved on the session record (`tools: [...]`).

**Safety:** no shell is involved (`execFile`), so the agent's input can't chain extra commands. And by default every tool runs **sandboxed**: no network, and the whole disk is read-only except the tools folder and a private `/tmp`.

- Linux uses **bubblewrap** (`sudo apt install bubblewrap` if it's missing). macOS uses the built-in `sandbox-exec`.
- If no sandbox is available (e.g. Windows, or bubblewrap not installed), a sandboxed tool **refuses to run** and says why, rather than silently running unconfined.
- A tool that needs the network or to write your files can opt out with `"sandbox": false`. It then runs with your full permissions, so only do that for tools you trust.

The tools folder syncs across devices, so a tool's `command` must exist on every device that uses it.

**Code:** `src/core/cli-tools.ts` (manifest format + `sandboxedCommand`, the sandbox plan per OS), `src/agent/tools/cli.ts` (runner), `src/server/cli-tools.ts` (loader), `tests/cli-tools.test.ts` (includes a real test that a sandboxed tool can't write your home folder or reach the network).

---

## 3. Find Everything

- **Ctrl+P** (⌘P on Mac) inside the app, or **File → Find Everything**
- **Ctrl+Shift+Space** (⌘⇧Space on Mac) from **anywhere on your desktop**. This raises the app and opens the palette.
  - Some Linux Wayland desktops block global hotkeys. If it does nothing, add a custom keyboard shortcut in your desktop settings that runs `learnharness --find` (or the AppImage path with `--find`).

It searches:

- **Sessions**: titles and full transcripts → Enter opens the session
- **Knowledge graph**: proposition names, statements, and aliases → Enter shows it in the graph; the dumbbell button starts practice on it
- **Files**: names under `~/Desktop`, `~/Documents`, `~/Downloads` → Enter starts a new lesson about that file (the agent reads it with its file tools)

To search other folders, set `LH_FIND_ROOTS` (`:`-separated on Linux/Mac). The agent's own `read` / `ls` / `find` / `grep` tools already reach anything in your home folder during a session ("teach me from ~/Documents/notes.pdf").

**Code:** `src/server/find.ts`, `components/find-everything.tsx`, `electron/main.cjs` (`registerGlobalFind`).

---

## 4. Sync across your devices

All your learning (sessions, graph, practice, settings, tools) lives in **one data folder**. To sync:

1. Install a folder-sync service on every device: **Syncthing** (free, private, peer-to-peer; recommended), Dropbox, iCloud Drive, OneDrive, or Google Drive.
2. On your **main** device: **File → Choose Data Folder…** → pick (or create) e.g. `~/Sync/Meander` → **Copy and Switch**. The app restarts using it, and your old folder stays as a backup.
3. Wait for it to sync, then on **each other device**: **File → Choose Data Folder…** → pick the same synced folder → **Use It**.

**Use one device at a time.** Plain file sync has no locking, so two devices editing the same session at once creates sync conflicts. To help with that, each device writes a heartbeat file to `.devices/<hostname>.json` in the data folder. If another device's heartbeat is fresh when you launch, you get a warning: *"Meander looks open on macbook."*

API keys (`auth.json`) are deliberately **not** synced; enter them once per device. **File → Use Default Data Folder** switches a device back to local-only.

**Code:** `electron/data-location.cjs`, `tests/data-location.test.ts`. Every write goes through one seam, the `LH_DATA_DIR` env var in `config.ts`; the menu just chooses that folder.

---

## 9. Automatic updates

Your installed apps update from your GitHub repo, https://github.com/vinceychu/meander.

- Each app checks for a new release on launch and once a day, downloads it in the background, and shows a **Restart to update** banner. If you don't restart, it installs the next time you quit. You can turn automatic checks off in **Settings → General**.
- **Linux:** the AppImage replaces itself (the standard updater).
- **Mac:** Apple's built-in updater only accepts apps signed with a paid Apple Developer ID. So Meander has its own small updater (`electron/mac-self-update.cjs`) that downloads the new version, checks its fingerprint (sha512), swaps it into Applications, re-signs it, and relaunches. The old version is kept until the swap succeeds.

**Publishing a new version** (what I do after a fix):

1. Bump `version` in `package.json` (e.g. `0.3.9` → `0.3.10`) and commit.
2. Push, then tag it and push the tag:

   ```bash
   git push origin main && git tag v0.3.10 && git push origin v0.3.10
   ```

3. GitHub Actions (`.github/workflows/release.yml`) builds the Linux and Intel-Mac apps on GitHub's machines, uploads them, and publishes the release. That takes about 15 minutes. Then every installed copy picks it up.

**Renaming the app or changing its icon is just another update.** Change `PRODUCT_NAME` in `electron/main.cjs` and `productName` in `electron-builder.yml`, or edit `build/icon-meander.svg` and run `node scripts/make-icons.mjs`, then publish. On the Mac the update swaps in the renamed app and its new icon. On Linux the app rewrites its own app-menu entry and icon on the first start after the update (`electron/linux-desktop-entry.cjs`). A few internal labels must never change, or installed copies would lose their data or stop finding updates. `tests/update-chain.test.ts` fails if any of them do.

Apps check for updates on launch and every 4 hours.


---

## 5. Anki export

**Stats page → Export to Anki**, or **File → Export to Anki…** in the desktop app. You get a `.txt` file; in Anki, **File → Import** it (Anki 2.1.55 or newer).

- One Basic card per idea: front = the idea's name, back = its statement. Math like `$x^2$` becomes Anki's MathJax.
- Cards go in a deck called **Meander**, tagged `meander`. Ideas currently due in Meander are also tagged `lh_due`.
- Each card has a stable id, so **re-importing a newer export updates your cards** (keeping their Anki history) instead of duplicating them.

**Code:** `src/core/anki.ts`, `app/api/review/anki/route.ts`.

---

## 6. Learn a whole folder

- In **Find Everything** (Ctrl+P / Ctrl+Shift+Space), search for a folder.
  - **Enter** starts a lesson over the folder: the agent looks at what's there and suggests an order.
  - The **import button** on the right extracts every text note in it (`.md`, `.txt`, `.org`, `.rst`, `.tex`; subfolders included; up to 200 files, 1MB each) into your knowledge graph. It asks first, because each file is read by your models and uses tokens. Progress shows in the activity dock.
- **File → Learn a Folder…** picks a folder with the system dialog and offers the same two choices.

**Code:** `src/server/import-folder.ts`, `app/api/graph/import-folder/route.ts`, `components/find-everything.tsx`.

---

## 7. Study stats

The **Stats** link at the bottom of the sidebar (or **File → Study Stats**):

- **Streak**: days in a row you sent at least one message.
- **Study time**: the gaps between messages, each capped at 5 minutes, so a session left open overnight doesn't count as hours.
- **Retention**: the share of practice reviews you didn't forget (Anki calls this "true retention"), overall and per week.
- **Ideas learned** per week, and **reviews coming due** over the next 14 days.

Like spaced review, nothing is stored: it's all computed from your sessions and graph on each visit.

**Code:** `src/core/study-stats.ts` (all the math), `components/stats-view.tsx`, `tests/study-stats.test.ts`.

---

## How the app is built (a reading map)

Read in this order:

1. `docs/vision.md`: what the product is trying to be
2. `docs/architecture.md`: the layering and the "one writer per store" rule
3. `src/core/`: pure domain logic, no I/O; start with `contracts/`
4. `src/agent/`: the AI agents (prober → teacher; practice). Prompts are plain markdown in `src/agent/prompts/`; tools are in `src/agent/tools/`
5. `src/server/chat-handler.ts`: one chat turn end-to-end, where agents and tools get wired together
6. `src/store/`: the only code that touches disk (JSON / JSONL files in the data folder)
7. `app/api/*`: thin HTTP routes; `components/`: the React UI
8. `electron/main.cjs`: the desktop shell. It starts the Next.js server as a child process and opens a window on it

The stack: Next.js 16 + React 19 (UI and API), the `pi` agent SDK (LLM loop, any provider), Electron (desktop), and plain files for storage.

Commands:

```bash
npm run dev            # web version at http://localhost:3000
npm run desktop:dev    # desktop shell against the dev server
npm test               # 2,300+ deterministic tests (no network, no LLM)
npm run typecheck && npm run lint
```

`npm run lint` enforces the import layering: e.g. `src/agent` may not import `src/server`. That's why the review snapshot lives in `src/core/review.ts` (shared) rather than in the server.
