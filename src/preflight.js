/**
 * Pull lifecycle preflight: environment and configuration checks with self-healing.
 * Machine-fixable problems (corrupt sync metadata, outdated self version) are repaired
 * in place; unfixable ones report the exact next command. Every check accepts injected
 * dependencies (fetchImpl / upgradeFn) so the test suite stays fully offline.
 */
import fs from "node:fs";
import path from "node:path";
import { readSyncPolicy } from "./sync-policy.js";
import { readSyncState, healSyncMetadata } from "./sync-plan.js";
import { resolveNpmCommand } from "./rehydrator.js";
import { runUpgrade } from "./maintenance.js";

const GIST_API = "https://api.github.com/gists/";
const PROBE_TIMEOUT_MS = 30_000;

function selfPackage() {
  return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
}

function nodeEngineFloor() {
  const match = /^>=\s*(\d+)/.exec(String(selfPackage().engines?.node || ""));
  return match ? Number(match[1]) : null;
}

/**
 * Availability check without spawning a process: npm must exist on PATH because
 * plugin dependency installs and self-upgrades both shell out through it.
 */
function npmOnPath(npmCmd) {
  const dirs = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, npmCmd.file), fs.constants.X_OK);
      return true;
    } catch { /* keep scanning */ }
  }
  return false;
}

function metadataCorrupt(root) {
  try {
    readSyncPolicy(root);
  } catch {
    return true;
  }
  try {
    readSyncState(root);
  } catch {
    return true;
  }
  return false;
}

/**
 * Probes gist readability with the same headers the pull transport uses.
 * HEAD is not supported by the gists endpoint, so this is a GET; it does not
 * read or parse the body.
 */
export async function probeGistAccess(id, token, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${GIST_API}${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        message: `token unauthorized (${res.status}): ensure OMP_CFG_CLOUD_TOKEN has 'gist' scope and belongs to the gist owner`,
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        status: res.status,
        message: "gist not found (404): wrong id, or this token cannot see the gist",
      };
    }
    if (res.ok) return { ok: true, status: res.status, message: "gist accessible" };
    return { ok: false, status: res.status, message: `GitHub API ${res.status} while probing the gist` };
  } catch (err) {
    return { ok: false, status: null, message: `api.github.com unreachable: ${err.message}` };
  }
}

/**
 * Probes a plain HTTP(S) target serving the archive.
 */
export async function probeHttpAccess(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const ok = res.status >= 200 && res.status < 400;
    return {
      ok,
      status: res.status,
      message: ok ? `target reachable (HTTP ${res.status})` : `HTTP ${res.status} from target`,
    };
  } catch (err) {
    return { ok: false, status: null, message: `target unreachable: ${err.message}` };
  }
}

/**
 * Runs the ordered preflight checklist for a pull (or a standalone doctor run).
 * Returns `{ ok, checks }` where ok is true unless any check reports "fail";
 * "fixed" marks issues repaired in place, "warn" marks non-blocking findings.
 */
export async function runPreflight({
  root,
  target = null,
  token = null,
  dryRun = false,
  fetchImpl = null,
  upgradeFn = runUpgrade,
} = {}) {
  const checks = [];
  const doFetch = fetchImpl || fetch;

  // metadata: sync policy/state must be readable; heal in place unless dry-run.
  try {
    if (metadataCorrupt(root)) {
      if (dryRun) {
        checks.push({ id: "metadata", status: "warn", detail: "corrupt; would heal on apply" });
      } else {
        const healed = healSyncMetadata(root).healed;
        if (healed.length > 0) {
          checks.push({ id: "metadata", status: "fixed", detail: healed.join("; ") });
        } else {
          checks.push({ id: "metadata", status: "pass", detail: "policy and state readable" });
        }
      }
    } else {
      checks.push({ id: "metadata", status: "pass", detail: "policy and state readable" });
    }
  } catch (err) {
    checks.push({ id: "metadata", status: "fail", detail: `sync metadata not repairable: ${err.message}` });
  }

  // node-engine: informational gate against package.json engines (warn only).
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const floor = nodeEngineFloor();
  if (floor !== null && nodeMajor < floor) {
    checks.push({
      id: "node-engine",
      status: "warn",
      detail: `node ${process.versions.node} is below engines.node >=${floor}; upgrade when possible`,
    });
  } else {
    checks.push({ id: "node-engine", status: "pass", detail: `node ${process.versions.node}` });
  }

  // npm-cli: without npm neither plugin installs nor self-upgrade can run.
  const npmCmd = resolveNpmCommand();
  const npmOk = npmOnPath(npmCmd);
  if (npmOk) {
    checks.push({ id: "npm-cli", status: "pass", detail: npmCmd.file });
  } else {
    checks.push({
      id: "npm-cli",
      status: "fail",
      detail: `${npmCmd.file} not found on PATH; plugin install and self-upgrade unavailable`,
    });
  }

  // registry + self-version: compare against npm latest; upgrade in place when possible.
  let upgradePlan = null;
  try {
    upgradePlan = await upgradeFn({ check: true });
  } catch (err) {
    checks.push({ id: "registry", status: "warn", detail: `registry check failed: ${err.message}` });
  }
  if (upgradePlan && upgradePlan.latest != null) {
    checks.push({ id: "registry", status: "pass", detail: `local ${upgradePlan.local} / latest ${upgradePlan.latest}` });
    if (upgradePlan.action === "upgrade" && npmOk) {
      try {
        const done = await upgradeFn({});
        if (done.action === "upgraded") {
          checks.push({
            id: "self-version",
            status: "fixed",
            detail: `upgraded ${upgradePlan.local} -> ${upgradePlan.latest}; restart omp to activate`,
          });
        } else {
          checks.push({
            id: "self-version",
            status: "warn",
            detail: `upgrade not completed (${done.action}${done.reason ? `: ${done.reason}` : ""}); continue with ${upgradePlan.local}`,
          });
        }
      } catch (err) {
        checks.push({
          id: "self-version",
          status: "warn",
          detail: `automatic upgrade failed: ${err.message}; continue with ${upgradePlan.local}`,
        });
      }
    } else if (upgradePlan.action === "upgrade") {
      checks.push({
        id: "self-version",
        status: "warn",
        detail: `upgrade available (${upgradePlan.local} -> ${upgradePlan.latest}) but npm is unavailable`,
      });
    } else if (upgradePlan.action === "manual") {
      checks.push({ id: "self-version", status: "warn", detail: upgradePlan.reason || "manual upgrade required" });
    } else {
      checks.push({ id: "self-version", status: "pass", detail: `local ${upgradePlan.local} is up to date` });
    }
  } else if (upgradePlan) {
    checks.push({ id: "registry", status: "warn", detail: "registry unreachable" });
    checks.push({ id: "self-version", status: "warn", detail: "cannot compare versions while the registry is unreachable" });
  }

  // remote-access: probe the pull target before spending the real download.
  if (target?.kind === "gist") {
    const probe = await probeGistAccess(target.id, token, doFetch);
    checks.push(probe.ok
      ? { id: "remote-access", status: "pass", detail: probe.message }
      : { id: "remote-access", status: "fail", detail: probe.message });
  } else if (target?.kind === "http") {
    const probe = await probeHttpAccess(target.url, doFetch);
    checks.push(probe.ok
      ? { id: "remote-access", status: "pass", detail: probe.message }
      : { id: "remote-access", status: "fail", detail: probe.message });
  }

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}
