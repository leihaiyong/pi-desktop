# Changelog

All notable changes to Pi Desktop are documented here.

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
