#!/usr/bin/env node
/**
 * Offline change-eval gate: fixed sync roundtrip workload → quality / efficiency / cost.
 * Default: compare against eval/baseline.json; exit 1 on regression.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BASELINE = path.join(ROOT, "eval", "baseline.json");
const WORKLOAD = "sync-roundtrip-v1";
const PASS = "EvalPassword_12345!";
const PROVIDER_YAML =
  "providers:\n  demo:\n    baseUrl: https://example.invalid\n    apiKey: eval-v1\n";
const SKILL_MD = "---\nname: eval-skill\n---\n# Eval\n";
const CP_METHODS = [
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
];

function roundMs(started) {
  return Math.round(performance.now() - started);
}

function makeTempEnv(prefix = "omp-eval-") {
  const tmp = os.tmpdir();
  const rel = path.relative(os.homedir(), tmp);
  const tmpInHome = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (!tmpInHome) fs.mkdirSync(path.join(os.homedir(), ".omp", "tmp"), { recursive: true });
  const base = fs.mkdtempSync(
    path.join(tmpInHome ? tmp : path.join(os.homedir(), ".omp", "tmp"), prefix)
  );

  function initEnv(dir) {
    const agent = path.join(dir, "agent");
    const plugins = path.join(dir, "plugins");
    const tools = path.join(dir, "tools");
    const hooks = path.join(dir, "hooks");
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(plugins, { recursive: true });
    fs.mkdirSync(tools, { recursive: true });
    fs.mkdirSync(hooks, { recursive: true });
    return { dir, agent, plugins, tools, hooks };
  }

  return {
    base,
    a: initEnv(path.join(base, "envA")),
    b: initEnv(path.join(base, "envB")),
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function gitHeadShort() {
  try {
    const require = createRequire(import.meta.url);
    const { execFileSync } = require("node:child_process");
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

async function runWorkload() {
  const {
    buildArchive,
    restoreArchive,
    decryptArchiveBlob,
    planSync,
    setResourceScope,
  } = await import(path.join(ROOT, "index.js"));

  const cp = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const originals = Object.fromEntries(CP_METHODS.map((name) => [name, cp.default[name]]));
  let childProcessCalls = 0;
  for (const name of CP_METHODS) {
    cp.default[name] = () => {
      childProcessCalls += 1;
    };
  }
  syncBuiltinESMExports();

  const env = makeTempEnv();
  try {
    const rootA = env.a.agent;
    const rootB = env.b.agent;

    fs.writeFileSync(path.join(rootA, "models.yml"), PROVIDER_YAML, "utf8");
    const skillDir = path.join(rootA, "skills", "eval-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_MD, "utf8");

    await setResourceScope(rootA, "provider:demo", "public");
    await setResourceScope(rootA, "asset:skills/eval-skill", "public");

    const tArchive = performance.now();
    const { blob } = buildArchive(PASS, rootA);
    const archiveMs = roundMs(tArchive);
    if (!Buffer.isBuffer(blob) || blob.length === 0) {
      throw new Error("buildArchive returned empty blob");
    }

    const tRestore = performance.now();
    const restored = restoreArchive(blob, PASS, rootB);
    const restoreMs = roundMs(tRestore);
    if (!(restored.files >= 2)) {
      throw new Error(`restoreArchive files expected >= 2, got ${restored.files}`);
    }
    if (!Array.isArray(restored.conflicts) || restored.conflicts.length !== 0) {
      throw new Error(`restoreArchive conflicts expected [], got ${restored.conflicts?.length}`);
    }
    if (!Array.isArray(restored.blocked) || restored.blocked.length !== 0) {
      throw new Error(`restoreArchive blocked expected [], got ${restored.blocked?.length}`);
    }
    if (!fs.existsSync(path.join(rootB, "models.yml"))) {
      throw new Error("restoreArchive missing models.yml on B");
    }
    if (!fs.existsSync(path.join(rootB, "skills", "eval-skill", "SKILL.md"))) {
      throw new Error("restoreArchive missing skill file on B");
    }

    const tPlan = performance.now();
    const plan = planSync(decryptArchiveBlob(blob, PASS), rootB);
    const planMs = roundMs(tPlan);
    const mutating = (plan.actions || []).filter(
      (a) => a.action === "write" || a.action === "delete"
    );
    if (mutating.length !== 0) {
      throw new Error(
        `second planSync has write/delete actions: ${mutating.map((a) => a.id).join(",")}`
      );
    }
    if (!Array.isArray(plan.conflicts) || plan.conflicts.length !== 0) {
      throw new Error(`planSync conflicts expected [], got ${plan.conflicts?.length}`);
    }
    if (!Array.isArray(plan.blocked) || plan.blocked.length !== 0) {
      throw new Error(`planSync blocked expected [], got ${plan.blocked?.length}`);
    }

    return {
      quality: { assertions: 1 },
      efficiency: {
        totalMs: archiveMs + restoreMs + planMs,
        archiveMs,
        restoreMs,
        planMs,
      },
      cost: { childProcessCalls },
    };
  } finally {
    for (const name of CP_METHODS) {
      cp.default[name] = originals[name];
    }
    syncBuiltinESMExports();
    env.cleanup();
  }
}

function parseArgs(argv) {
  let updateBaseline = false;
  let baselinePath = DEFAULT_BASELINE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update-baseline") {
      updateBaseline = true;
      continue;
    }
    if (arg === "--baseline") {
      const next = argv[i + 1];
      if (next == null || next.startsWith("-")) {
        console.error("unknown argument: --baseline");
        process.exit(2);
      }
      baselinePath = path.resolve(next);
      i += 1;
      continue;
    }
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
  return { updateBaseline, baselinePath };
}

function readBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch {
    console.error(`invalid baseline: ${baselinePath}`);
    process.exit(2);
  }
  if (parsed?.version !== 1 || parsed?.workload !== WORKLOAD) {
    console.error(`invalid baseline: ${baselinePath}`);
    process.exit(2);
  }
  return parsed;
}

function writeBaseline(baselinePath, metrics) {
  const doc = {
    version: 1,
    workload: WORKLOAD,
    recordedAt: new Date().toISOString(),
    gitHead: gitHeadShort(),
    metrics,
  };
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return doc;
}

function compare(metrics, baseline) {
  const breaches = [];
  if (metrics.quality.assertions !== 1) breaches.push("quality.assertions");

  const baseTotal = baseline.metrics.efficiency.totalMs;
  const limit = Math.max(baseTotal * 1.25, baseTotal + 100);
  if (metrics.efficiency.totalMs > limit) breaches.push("efficiency.totalMs");

  if (metrics.cost.childProcessCalls > baseline.metrics.cost.childProcessCalls) {
    breaches.push("cost.childProcessCalls");
  }

  if (breaches.length > 0) {
    return { verdict: "regressed", breaches };
  }

  const improved =
    metrics.efficiency.totalMs <= baseTotal * 0.8 &&
    metrics.quality.assertions === 1 &&
    metrics.cost.childProcessCalls <= baseline.metrics.cost.childProcessCalls;
  return { verdict: improved ? "improved" : "pass", breaches: [] };
}

async function main() {
  const { updateBaseline, baselinePath } = parseArgs(process.argv.slice(2));
  let metrics;
  try {
    metrics = await runWorkload();
  } catch (err) {
    console.error(err?.stack || String(err));
    process.exit(1);
  }

  const existing = readBaseline(baselinePath);
  if (existing == null) {
    const created = writeBaseline(baselinePath, metrics);
    console.log(
      JSON.stringify({
        verdict: "baseline-created",
        metrics,
        baseline: created.metrics,
        breaches: [],
      })
    );
    process.exit(0);
  }

  const { verdict, breaches } = compare(metrics, existing);
  const out = {
    verdict,
    metrics,
    baseline: existing.metrics,
    breaches,
  };
  console.log(JSON.stringify(out));

  if (updateBaseline && verdict !== "regressed") {
    writeBaseline(baselinePath, metrics);
  }

  process.exit(verdict === "regressed" ? 1 : 0);
}

main();
