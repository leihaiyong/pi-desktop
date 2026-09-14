# Changelog

All notable changes to Pi Desktop are documented here.

## [0.5.0] — 2026-09-14

### Added

- **Startup picker lists sessions** — the “Choose a workspace” dialog now shows
  each workspace’s recent sessions as an indented, compact tree under the
  workspace header: pick a session to open it, or pick the workspace row to
  start a fresh session there
- **Forked-session tree** — the sidebar and the startup picker now show a
  session’s forked children nested under their parent (via `parentSessionPath`),
  ordered so the most-recently-used branch stays on top
- **Name-first session labels** — a session shows its user name (★ prefix) before
  its first message in both lists, matching the sidebar’s existing behavior
- **Summarize the abandoned branch on navigate** — moving the tree to an earlier
  point prompts to summarize the branch being left behind (custom prompt or
  skip), honoring the `branchSummary` setting

### Fixed

- Session tree: labels now render on the entry they target (not the label record)
  and appear before the role
- Session tree: cancelling the branch-summarize prompt returns to the tree (as in
  pi’s TUI) instead of silently doing nothing
- Branch summarization: Esc now aborts a running summary, and the status line
  shows “(Esc to cancel)” while one is in progress
- Status line: actually hides when the summarizing state ends (a stray `display`
  rule was overriding the `hidden` attribute)

### Quality

- New unit tests for the session-tree forest / flatten / label helpers (255 test
  cases total)

## [0.4.0] — 2026-09-08

### Added

- **Startup workspace picker** — on launch (no `--cwd`/`--session`) a
  “Choose a workspace” dialog now appears instead of silently opening a
  throwaway `process.cwd()`: pick an existing workspace (keyboard or click) or
  create a new one. The default working directory is the most-recently-used
  workspace, never a temp dir
- **Workspace sorting** — the workspace list can be ordered by most-recently-used
  or by name, in both the startup picker (Recent / Name toggle) and the sidebar
  (⇅ / Aa toggle); the current workspace stays pinned at the top
- **Session tree — message-type colors + live filters** — every tree row is
  tinted by entry type (user = accent, assistant = success, tool = muted,
  thinking = italic, compaction/branch = warning, model/title/meta = muted), and
  a filter toolbar (default / no tools / user only / labeled only / all)
  re-renders the tree live
- **Session tree — action toolbar** — icon buttons for navigate / fork / branch
  / label make fork & branch discoverable and clickable, not just keyboard-only

### Fixed

- The startup “choose a workspace” dialog could fail to appear in packaged
  builds (notably the portable) when the renderer loaded after main finished
  starting and missed the one-shot `host:ready` push; the picker is now also
  triggered from the initial snapshot pull, so it opens reliably
- Creating a new workspace from the startup “choose a workspace” dialog now
  closes the dialog automatically (and switches into the new workspace) instead
  of leaving it open; cancelling the folder picker keeps the dialog open
- Deleting a workspace from the sidebar now opens a confirmation dialog
  (matching session delete) instead of a two-step “click again to confirm”;
  the old arm state and its styles were removed
- Session tree: a branchless session now renders as a flat list (no staircase);
  keyboard fork (`Ctrl+Enter`) is no longer shadowed by `Enter`; the tree
  refreshes in place after navigate / fork / clone
- Session tree: a long, mostly-linear session with a single fork no longer
  renders as a deep off-screen staircase — indentation is now branch-based
  (matching pi's TUI tree-selector), so only actual forks are indented and a
  straight conversation chain stays flat (was one indent level per ancestor)
- `/scoped-models`: the selector now lists only models with active auth (was
  every known model) and marks the ones in the current scope with a `✓`; a scoped
  model that lost auth stays in the saved scope but is hidden from the list
- `/scoped-models`: the checked (selected) state no longer disappears after
  saving — the renderer's cached scope is now synced with the saved result, so
  reopening the selector shows the correct selection

### Quality

- 6 new unit tests for `sortWorkspaces` / `WORKSPACE_SORTS` (236 → 242 test
  cases)

## [0.3.0] — 2026-09-07

### Added

- **Workspace sidebar** — a collapsible tree in the left sidebar to manage
  workspaces and sessions at a glance:
  - Workspaces grouped by directory, most-recently-used first, with session
    counts; the current workspace is pinned at the top
  - Expand a workspace (▸ strip) to list its sessions — title, message count,
    updated time; click to switch to any session
  - Delete a single session (with a confirmation dialog) or delete an entire
    workspace in one action
  - Collapsed via the sidebar ◀ button or the titlebar ⌂ button
- **Extensions & Skills manager** — browse and manage every discovered
  extension and skill (enabled *and* disabled), not just the loaded set:
  - New `/extensions` and `/skills` commands, plus an “Extensions & Skills”
    entry in the Session menu
  - Enable / disable with one click (writes the matching `!pattern` to the
    right settings scope and reloads); package-installed resources are marked
    non-toggleable
  - Shows package metadata (version, author, homepage, repository) and source
    scope (project / user / package)
- **Working indicator** — a status hint while awaiting the model's first
  response; the spinner now follows the streaming output instead of sitting
  at the prompt

### Fixed

- `/resume` listed sessions from *every* project; it now lists only the
  current workspace's sessions
- Export: the picker now targets a directory, canceling the picker no longer
  counts as a pick, bare `/export` opened no picker at all, and HTML export
  no longer opens the file browser after saving (matches JSONL)
- `/model` selector stayed open after picking and the titlebar kept the stale
  model name; it now closes and refreshes
- Titlebar shows unnamed sessions as `(unnamed)`, matching the session info
  panel
- Image attachment: the file-type check never ran (the async MIME detector
  was never awaited), so non-image files passed through and the renderer
  received a Promise instead of the MIME type
- Settings ▸ `externalEditorCommand` could not be saved (called a setter the
  SDK does not expose); it now persists like every other setting

### Quality

- New functional test suite: 76 tests drive every `pi:invoke` IPC channel
  through the real Electron-main code path with a real SDK runtime (agent
  directory sandboxed to a temp dir), plus tests for both preload bridges —
  total 104 → 236 test cases; the suite surfaced both bugs above

## [0.2.0] — 2026-09-03

### Added

- **Custom provider / model manager** — manage local model services (Ollama,
  vLLM, LM Studio, llama.cpp, proxies) through the UI:
  - New `/providers` command, plus a Settings ▸ Models ▸ “custom providers
    (models.json)” entry
  - Add / edit / delete providers (`baseUrl`, `api`, `apiKey`, `headers`,
    `authHeader`) and their models (`id`, `name`, `contextWindow`,
    `maxTokens`, `reasoning`, input types, `$/M` cost) in the global
    `~/.pi/agent/models.json`
  - Fields follow [pi's models.json format](https://pi.dev/docs/latest/models);
    unknown file fields (`thinkingLevelMap`, `cost.cacheRead`,
    `samplingParams`, …) are preserved untouched
  - Saving refreshes the ModelRuntime, so new models are selectable in
    `/model` immediately — no restart
- Editor `/` autocomplete now includes slash commands registered by extensions
- 17 new unit tests for the `model-config` helpers

### Fixed

- `/model` selector: only lists models that are currently auth-eligible
- Confirm dialogs: a missing `<` on the cancel `<button` meant the cancel
  button never rendered and the dialog promise never resolved
- Provider login dialog showed a raw `[object Object]` auth status; it now
  shows configured / not-configured text
- Cost fields: the UI now edits the `$`-per-1M-token values exactly as stored
  in `models.json` (the file format is per-million, not per-token)

### Docs

- New `AGENTS.md` — development guide for AI coding assistants and new
  contributors

## [0.1.0] — 2026-09-03

Initial public release: cross-platform (Windows / macOS / Linux) Electron host
for the pi coding agent — the full TUI experience (chat, editor + autocomplete,
26 TUI slash commands, sessions with fork/clone/tree, workspaces, model
catalog + auth, themes, extensions & skills) in an Electron window built on
the official pi SDK.
