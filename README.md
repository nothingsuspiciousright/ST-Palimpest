# Palimpest

**Every story deserves to be remembered.**

A standalone, manual Memory Book manager for SillyTavern. Generate, review, preserve, and continue long-form summaries without mixing the roleplay preset into the summarization request.

**Version:** 1.0.5 · **License:** [AGPL-3.0](LICENSE) · [Русская документация](README.ru.md) · [Changelog](CHANGELOG.md)

## Features

- **Isolated context:** summary instructions, chronological chat history, character card, persona, Author’s Note, activated World Info, and active memory. No RP Prompt Manager invocation.
- **Independent API micro-presets:** named OpenAI-compatible endpoints, keys, exact model IDs, and output budgets. Saved SillyTavern Chat Completion Connection Profiles are also supported without changing the main RP connection.
- **Version history per chat:** manual backups, generated drafts, applied versions, restoration, and TXT/JSON export.
- **Draft-first workflow:** the active Memory Book remains unchanged until a draft is applied.
- **Resume interrupted generation:** keep received text and continue using the original summary prompt, source snapshot, and accumulated draft. Switch providers between continuation requests if necessary.
- **Streaming checkpoints:** save received text during long requests. Stop without discarding the draft.
- **Local token estimates:** current memory, drafts (including streaming), and archived versions display an approximate text token count alongside words and characters. No API request or tokenizer download; actual counts depend on the model. API-reported output usage, when available, is separate.
- **Compact, theme-native interface:** collapsible micro-preset settings, manual generation controls, and memory injection settings.

## Install

Palimpest is a client-side third-party extension and requires SillyTavern. No separate server plugin or build step is required. It targets current SillyTavern APIs, including the Chat Completion backend and Connection Manager. Compatibility with older builds is not guaranteed.

1. Back up important chats and export existing summaries before installing or upgrading.
2. Extract the `Palimpest` folder into `SillyTavern/public/scripts/extensions/third-party/`, or use the appropriate per-user extensions folder in your ST installation (for example `data/default-user/extensions/`). The manifest and source files must be directly inside the extension folder, not an additional nested folder. For a Git installation, use the public repository URL in ST's extension installer once the repository is published.
3. Disable the built-in **Summarize** extension and any other memory manager that would inject the same text. If you previously modified the built-in extension, restore its original files where possible. Do not delete existing chat memory data.
4. Reload SillyTavern and open **Palimpest** in the Extensions panel.
5. Select a saved Chat Completion Connection Profile, or create an API micro-preset. Review the **Summary Prompt** and injection settings before generating.

### Upgrade from earlier builds

Replace only the Palimpest extension files, retaining the existing ST data directory and browser storage. Earlier settings, archives (including incomplete drafts and their source snapshots), and saved browser keys are recognized. New records use Palimpest-specific namespaces; migration of chat metadata becomes durable at the next normal chat save. Old browser keys are moved on access. The legacy identifiers are retained only for migration. If both old and new archives exist, the new archive takes precedence. Downgrading to an older build may not read the new namespaces; keep pre-upgrade backups.

## Configure an API micro-preset

Open the **API presets** drawer and choose **New**. Enter a display name, base URL (for example `https://api.example.com/v1`), API key, exact provider model ID, and maximum output tokens. These examples are placeholders, not working credentials or endpoints. Remote APIs require HTTPS; HTTP is permitted only for loopback endpoints. The proxy must support OpenAI-compatible Chat Completion requests through the ST server.

Use **Test** to send a small connectivity check without chat history. Select the preset in **Summarize with**. To use a native ST profile instead, select a saved, uniquely named Chat Completion Connection Profile (or the current saved one). Text Completion profiles and unsaved connections are not supported. Native requests use the service with preset and instruct injection disabled. The main RP profile is not temporarily switched.

## Generate and resume

1. Set **Summary Prompt** to the desired Memory Book structure and instructions. No summary prompt or skeleton is bundled. On a fresh installation without imported settings, the field is empty; paste your own instructions before generating. Existing locally saved prompts and imported Summarize prompts are preserved. The clear-prompt control only clears the current setting; existing Memory Books and frozen draft snapshots are unaffected.
2. Click **Summarize now**. The source and prompt are snapshotted before generation. The current memory is kept active.
3. If the generation stops early, click **Continue from cutoff**. This uses the same source snapshot and skeleton, with the complete existing draft and a suffix-only instruction. It also works after an apparently normal finish if content is missing. Review or edit the result; the model may repeat or omit material, and only exact overlap is removed automatically.
4. **Stop & keep draft** cancels the request and keeps received text. Streaming checkpoints are saved roughly every 12 seconds as data arrives. Text never received or not yet saved before an unexpected tab closure cannot be recovered.
5. Review the full draft and click **Apply** when satisfied. Use **Save draft edits** to persist manual draft edits. Discarding a draft closes the current job but keeps archived revisions.

**Continue current Memory Book** resumes an already applied or manually imported book as a separate draft. If the exact applied revision has a saved source snapshot, the original skeleton and sources are reused. Otherwise confirm rebuilding from the current chat and Summary Prompt. Finish or discard any existing pending draft first. The active book remains unchanged until Apply.

Avoid switching chats while generating. A switch cancels the request; only already saved checkpoints are guaranteed to remain. If the chat changes before applying a draft, Palimpest requests confirmation. Non-streaming providers cannot offer incremental recovery. Long histories and continuation drafts still count toward the provider's context limit; there is no automatic truncation or chunking. Native ST streaming may not expose usage or a finish reason, so `unknown` is normal for that path.

## Context and memory injection

The independent request includes the Summary Prompt as instructions and source material as data:

| Included | Excluded |
| --- | --- |
| Selected, non-system text messages, in order | RP Prompt Manager instructions and unrelated extension injections |
| Character description, personality, scenario, examples and character note | Alternate swipes, deleted messages, attachments |
| Persona and Author’s Note | Archived summary versions |
| Activated World Info and active Memory Book | Unactivated World Info records |

World Info uses ST's dry-run activation scanner and configured activation budget. It does not export every lorebook. Instructions already physically present in a card, chat message, persona, Author’s Note, or World Info remain part of the source data. The on-screen context report shows section sizes in characters, not token counts.

Injection position, template, role, depth, and optional World Info scanning are configurable. The `{{summary}}` and `{{palimpest}}` macros expose active memory. If manually inserting a macro, set automatic injection to **None** to avoid duplication. Only active memory is injected into RP; version archives and job snapshots are not injected as separate context.

## Backups and privacy

**History** lists saved versions. **Backup now** snapshots the active book; restoring a revision creates a new active revision rather than erasing the previous version. Export a selected version to TXT or the version archive to JSON. JSON exports omit both unfinished and last-applied source snapshots, and JSON re-import is not implemented in this release. Keep regular full chat backups in addition to these exports.

Archives, pending generation snapshots and the latest applied source snapshot are stored in chat metadata. The last-applied snapshot is retained only for the matching active revision and replaced or cleared when the active book changes. They increase chat file size and are lost if the chat is deleted without a backup. They can contain private narrative data. Do not publish chat exports or memory archives when reporting issues.

Micro-preset keys are session-only by default. **Remember key in this browser** stores a key in browser `localStorage` **without encryption**. Keys are not placed in the Memory Book archive by the extension. However, user-authored text can itself contain sensitive information. The configured ST server and selected API provider receive the relevant request and may retain logs; use trusted infrastructure and do not expose actual keys, endpoint URLs, or chat contents in bug reports. No dedicated analytics or telemetry is implemented by Palimpest.

## Development and status

Source files are unbundled JavaScript, HTML and CSS. Run the isolated Node.js tests (Node 22 recommended):

```sh
node tests/core.cjs
```

The suite covers context construction, legacy migration, draft continuation, exact overlap, checkpoint recovery, mock API routing and streaming interruption. It does not exercise the live ST interface, real server or provider APIs. This public release is not a guarantee of compatibility with every ST version or proxy; test with a copy of a chat first.

## License and attribution

Palimpest is distributed under the GNU Affero General Public License v3.0. It is a modified, independent community extension derived from [SillyTavern](https://github.com/SillyTavern/SillyTavern)'s built-in Summarize (`public/scripts/extensions/memory/`), originally credited to Cohee and the SillyTavern contributors. See [NOTICE](NOTICE) and [LICENSE](LICENSE). This project is not affiliated with or endorsed by SillyTavern. The software is provided without warranty.
