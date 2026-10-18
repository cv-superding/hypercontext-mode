// Build gate: fail if any relative-specifier import()/require() call text
// survives into dist. All module code is bundled inline (splitting: false),
// so a relative specifier in dist is always anomalous — either an unresolved
// dynamic import (broken under every host) or a JSDoc `{import('...')}` type
// annotation that leaked out of the bundler. The second class is what kills
// the opencode plugin lane: opencode's plugin loader resolves those
// annotations as real files and dies with ENOENT before the plugin loads
// (Node ignores them, which is why the defect shipped silently). See the
// issue filed from #1234.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const RELATIVE_CALL = /(?:import|require)\(\s*['"]\.{1,2}\/[^'"]*['"][^)]*\)/g;

export function findRelativeImportRefs(text) {
    const hits = [];
    let m;
    RELATIVE_CALL.lastIndex = 0;
    while ((m = RELATIVE_CALL.exec(text)) !== null) {
        hits.push(m[0]);
    }
    return hits;
}

export function checkDistImportAnnotations(distDir) {
    const violations = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) { walk(full); continue; }
            if (!name.endsWith(".js")) continue;
            const refs = findRelativeImportRefs(readFileSync(full, "utf8"));
            if (refs.length > 0) violations.push({ file: full, refs });
        }
    };
    walk(distDir);
    return violations;
}

const invoked = process.argv[1];
// Realpath both sides: Node resolves entry-point symlinks, so argv[1] can differ from import.meta.url
const isMain = !!invoked && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
if (isMain) {
    const distDir = process.argv[2] ?? "dist";
    const violations = checkDistImportAnnotations(distDir);
    if (violations.length > 0) {
        for (const v of violations) {
            console.error(`dist-import-annotations: ${v.file}: ${v.refs.slice(0, 5).join("  ")}${v.refs.length > 5 ? ` … (+${v.refs.length - 5})` : ""}`);
        }
        console.error(`dist-import-annotations: FAIL — ${violations.reduce((n, v) => n + v.refs.length, 0)} relative import()/require() ref(s) across ${violations.length} file(s). These break host loaders that resolve JSDoc import() annotations as files (opencode) and indicate unresolved bundling.`);
        process.exit(1);
    }
    console.log("dist-import-annotations: OK");
}
