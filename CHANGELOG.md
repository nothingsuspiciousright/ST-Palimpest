# Changelog

## 1.0.2 — Public release (2026-11-25)

- Added English documentation, Russian documentation, full AGPL-3.0 license, upstream attribution, and a data-safe `.gitignore`.
- Replaced example connection names with provider-neutral placeholders.
- Introduced Palimpest-specific archive, connection selector, and remembered-key namespaces. Existing archives, active versions, draft snapshots, selected micro-presets, and remembered browser keys are migrated without changing their contents.
- Kept existing generation and UI behavior; no new provider requirements.
- Added migration regression tests. Live SillyTavern/provider integration remains unverified by the automated suite.

## 1.0.1

- Collapsible API preset controls, closed by default.
- Matched the stop button dimensions to the summarize button.

## 1.0.0

- Standalone memory manager derived from the built-in Summarize extension.
- Isolated summary context, independent API connections, version history, draft review, streaming checkpoints, and continuation from a saved draft.
