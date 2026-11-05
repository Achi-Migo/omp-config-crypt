import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_SCRIPT = path.resolve(REPO, "eval", "change-eval.mjs");

function runEval(args, baselinePath) {
  return spawnSync(process.execPath, [EVAL_SCRIPT, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: process.env,
  });
}

function tempBaseline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-change-eval-test-"));
  const baselinePath = path.join(dir, "baseline.json");
  return {
    dir,
    baselinePath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function parseStdout(stdout) {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, `expected JSON stdout, got: ${stdout}`);
  return JSON.parse(line);
}

test("creates baseline when missing", () => {
  const tmp = tempBaseline();
  try {
    const res = runEval(["--baseline", tmp.baselinePath]);
    assert.equal(res.status, 0, res.stderr);
    const out = parseStdout(res.stdout);
    assert.equal(out.verdict, "baseline-created");
    assert.equal(out.metrics.quality.assertions, 1);
    assert.equal(out.metrics.cost.childProcessCalls, 0);
    assert.ok(fs.existsSync(tmp.baselinePath));
    const saved = JSON.parse(fs.readFileSync(tmp.baselinePath, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.workload, "sync-roundtrip-v1");
  } finally {
    tmp.cleanup();
  }
});

test("matching baseline returns pass", () => {
  const tmp = tempBaseline();
  try {
    const first = runEval(["--baseline", tmp.baselinePath]);
    assert.equal(first.status, 0, first.stderr);
    const second = runEval(["--baseline", tmp.baselinePath]);
    assert.equal(second.status, 0, second.stderr);
    const out = parseStdout(second.stdout);
    assert.ok(out.verdict === "pass" || out.verdict === "improved", out.verdict);
    assert.deepEqual(out.breaches, []);
  } finally {
    tmp.cleanup();
  }
});

test("tight efficiency baseline regresses", () => {
  const tmp = tempBaseline();
  try {
    const first = runEval(["--baseline", tmp.baselinePath]);
    assert.equal(first.status, 0, first.stderr);
    const saved = JSON.parse(fs.readFileSync(tmp.baselinePath, "utf8"));
    const before = JSON.stringify(saved);
    saved.metrics.efficiency.totalMs = 1;
    fs.writeFileSync(tmp.baselinePath, `${JSON.stringify(saved, null, 2)}\n`);

    const second = runEval(["--baseline", tmp.baselinePath]);
    assert.equal(second.status, 1, second.stdout + second.stderr);
    const out = parseStdout(second.stdout);
    assert.equal(out.verdict, "regressed");
    assert.ok(out.breaches.includes("efficiency.totalMs"));
    assert.equal(fs.readFileSync(tmp.baselinePath, "utf8"), `${JSON.stringify(saved, null, 2)}\n`);
    assert.notEqual(fs.readFileSync(tmp.baselinePath, "utf8"), before);
  } finally {
    tmp.cleanup();
  }
});

test("--update-baseline keeps workload id", () => {
  const tmp = tempBaseline();
  try {
    const first = runEval(["--baseline", tmp.baselinePath]);
    assert.equal(first.status, 0, first.stderr);
    const second = runEval(["--baseline", tmp.baselinePath, "--update-baseline"]);
    assert.equal(second.status, 0, second.stderr);
    const out = parseStdout(second.stdout);
    assert.ok(out.verdict === "pass" || out.verdict === "improved", out.verdict);
    const saved = JSON.parse(fs.readFileSync(tmp.baselinePath, "utf8"));
    assert.equal(saved.workload, "sync-roundtrip-v1");
    assert.equal(saved.version, 1);
  } finally {
    tmp.cleanup();
  }
});
