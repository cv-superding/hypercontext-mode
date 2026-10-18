#!/usr/bin/env node
// Entry point: runs the CLI dispatcher (src/cli.ts).
// Both `bili` and `bili-proxy` bin aliases point here, and `node dist/index.js`
// still works. The package root is also importable (exports["."] resolves to
// this file), and npm host apps import it to reach the CLI surface — opencode's
// plugin loader did exactly that, and the unguarded main() then dispatched a
// CLI against the HOST's argv: a plain TUI import defaulted to "start" and
// fought over port 8787, an `opencode run x` import hit unknown-command and
// process.exit(2)'d the host. Only dispatch when this file is the invoked
// script (same posture as the guard in claude-native-bootstrap.ts).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./cli.js";

function invokedAsScript(): boolean {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    let self: string;
    let invoked: string;
    try {
        // realpath on BOTH sides: bin symlinks (nvm), cwd-relative invocation,
        // and --preserve-symlinks module URLs all converge to the same file.
        self = realpathSync(fileURLToPath(import.meta.url));
        invoked = realpathSync(argv1);
    } catch {
        return false;
    }
    if (process.platform === "win32") return self.toLowerCase() === invoked.toLowerCase();
    return self === invoked;
}

if (invokedAsScript()) {
    main().catch((err) => {
        console.error("bili: failed to start:", err);
        process.exit(1);
    });
}
