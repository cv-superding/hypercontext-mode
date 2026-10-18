import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceDir } from "@hypercontext/runtime";

test("workspace dir: explicit flag wins over everything", () => {
  const previous = process.env.CONTEXT_MODE_PROJECT_DIR;
  process.env.CONTEXT_MODE_PROJECT_DIR = "/declared/workspace";
  try {
    assert.equal(resolveWorkspaceDir("/explicit/workspace"), "/explicit/workspace");
  } finally {
    restore("CONTEXT_MODE_PROJECT_DIR", previous);
  }
});

test("workspace dir: declared env beats the launch cwd", () => {
  const previous = process.env.CONTEXT_MODE_PROJECT_DIR;
  process.env.CONTEXT_MODE_PROJECT_DIR = "/declared/workspace";
  try {
    // Desktop hosts launch the MCP child from the app directory; without honouring
    // this variable every workspace file is rejected by workspace containment.
    assert.equal(resolveWorkspaceDir(), "/declared/workspace");
    assert.equal(resolveWorkspaceDir("   "), "/declared/workspace");
  } finally {
    restore("CONTEXT_MODE_PROJECT_DIR", previous);
  }
});

test("workspace dir: falls back to cwd when nothing is declared", () => {
  const previous = process.env.CONTEXT_MODE_PROJECT_DIR;
  delete process.env.CONTEXT_MODE_PROJECT_DIR;
  try {
    assert.equal(resolveWorkspaceDir(), process.cwd());
    assert.equal(resolveWorkspaceDir(""), process.cwd());
  } finally {
    restore("CONTEXT_MODE_PROJECT_DIR", previous);
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
