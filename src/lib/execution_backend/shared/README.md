# Shared Backend Code

Code that does not depend on how a tool runs. The Emscripten backend (Mayo, [../emscripten](../emscripten)) and the Java backend ([../java](../java)) both use it, and a future R, Python or WASI backend should too, so every backend reads commands and the folder the same way.

| File | Role |
|---|---|
| `command.ts` | The command syntax: `parseCommand` (`&&` chains) and `parsePipeline` (`\|` stages and the redirections `<`, `>`, `>>`, `2>`, `2>>`), and the types `Stage`, `Redirects` and `Redirect`. Tested by `command.test.mjs`. |
| `folder.ts` | Paths and handles in the selected folder: `folderPath` / `requireFolderPath` (refuse absolute paths and `..`), `getDirectory`, `getParent`, `getFile`, `getEntry`, `openWritable` (`>` or `>>`). Works on the main thread and in workers. |
| `folder-store.ts` | `pickFolder` (the folder picker) and remembering the folder between visits in IndexedDB (`saveFolder`, `loadFolder`, `forgetFolder`, `folderPermission`, `requestFolderPermission`). One remembered folder for the whole app. |

## Adding a Backend

- Parse commands with `parseCommand` / `parsePipeline`, then refuse what the backend cannot run yet (the Java backend refuses pipes) rather than writing another parser.
- Resolve every user path with `folderPath` / `getFile` / `openWritable`, so paths that leave the folder are refused in the same way everywhere.
- Take the folder handle from `pickFolder` / `loadFolder`: the user chooses one folder, and every backend works in it.

## Tests

From the repository root: `node --test src/lib/execution_backend/shared/command.test.mjs`. `folder.ts` needs a browser (it is covered by the Mayo and CheerpJ testers).
