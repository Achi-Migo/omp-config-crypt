import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { exec, execSync, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export function getAgentDir(root) {
  return root || process.env.OMP_CFG_ROOT || path.join(os.homedir(), ".omp", "agent");
}

export function getOmpHome(agentDir) {
  const norm = path.resolve(agentDir);
  return path.basename(norm) === "agent" ? path.dirname(norm) : norm;
}

/**
 * Remove corrupt database files (*.corrupt-*) left over from crashes.
 */
export function cleanCorruptFiles(agentDir) {
  const cleaned = [];
  if (!fs.existsSync(agentDir)) return cleaned;

  const entries = fs.readdirSync(agentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.includes(".corrupt-")) {
      const fullPath = path.join(agentDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        fs.rmSync(fullPath, { recursive: true, force: true });
        cleaned.push({ path: fullPath, bytes: stat.size });
      } catch {}
    }
  }
  return cleaned;
}

/**
 * Prune historical .import-backup-* directories, keeping only the most recent N.
 */
export function pruneOldBackups(agentDir, keepCount = 3) {
  const pruned = [];
  if (!fs.existsSync(agentDir)) return pruned;

  const recoveryLock = path.join(agentDir, ".sync-recovery.local.lock");
  if (fs.existsSync(recoveryLock)) return pruned;

  let activeBackup = null;
  const lockPath = path.join(agentDir, ".sync.local.lock");
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (typeof lock?.backupDir === "string" && lock.backupDir) {
        activeBackup = lock.backupDir;
      }
    } catch {
      // Corrupt lock: do not prune anything that might still be referenced.
      return pruned;
    }
  }

  const entries = fs.readdirSync(agentDir, { withFileTypes: true });
  const backups = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(".import-backup-"))
    .map((e) => e.name)
    .sort()
    .reverse();

  const eligibleBackups = backups.filter((name) => {
    if (activeBackup && name === activeBackup) return false;
    const journalFile = path.join(agentDir, name, "journal.json");
    if (!fs.existsSync(journalFile)) return false;
    try {
      const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
      return journal?.status === "completed";
    } catch {
      return false;
    }
  });

  if (eligibleBackups.length > keepCount) {
    const toRemove = eligibleBackups.slice(keepCount);
    for (const name of toRemove) {
      const fullPath = path.join(agentDir, name);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        pruned.push(fullPath);
      } catch {}
    }
  }
  return pruned;
}

/**
 * Remove obsolete legacy transition files.
 */
export function cleanObsoleteFiles(agentDir) {
  const ompDir = getOmpHome(agentDir);
  const targets = [
    path.join(ompDir, "extensions", "local-models.js"),
    path.join(ompDir, "extensions", "agy.js"),
  ];

  const purged = [];
  for (const p of targets) {
    if (fs.existsSync(p)) {
      try {
        fs.rmSync(p, { force: true });
        purged.push(p);
      } catch {}
    }
  }
  return purged;
}

/**
 * Execute OMP native garbage collection and checkpoint WAL files.
 */
export async function runOmpGc({
  archiveDays = 14,
  retainNewest = 20,
  agentDir = null,
} = {}) {
  const dirFlag = agentDir ? `--agent-dir="${agentDir}"` : "";
  const cmd = `omp gc --apply --blobs --stale --wal --archive --cold-archive-after-days=${archiveDays} --retain-newest-global=${retainNewest} ${dirFlag}`.trim();
  try {
    const { stdout, stderr } = await execAsync(cmd);
    return { success: true, output: (stdout + "\n" + stderr).trim() };
  } catch (err) {
    return { success: false, error: err.message, output: (err.stdout || "") + (err.stderr || "") };
  }
}

/**
 * Full automatic maintenance cycle with debouncing.
 */
export async function runMaintenance({
  agentDir = getAgentDir(),
  dryRun = false,
  force = false,
  intervalHours = 24,
  archiveDays = 14,
  keepBackups = 3,
  skipGc = false,
} = {}) {
  const stampFile = path.join(agentDir, ".last-maintenance.json");
  const now = Date.now();
  const minIntervalMs = intervalHours * 3600 * 1000;

  if (!force && fs.existsSync(stampFile)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
      if (stamp.timestamp && now - stamp.timestamp < minIntervalMs) {
        return {
          skipped: true,
          reason: "debounced",
          lastRun: stamp.lastRun,
          nextRunInMinutes: Math.round((minIntervalMs - (now - stamp.timestamp)) / 60000),
        };
      }
    } catch {}
  }

  const result = {
    skipped: false,
    timestamp: now,
    lastRun: new Date(now).toISOString(),
    corruptCleaned: [],
    backupsPruned: [],
    obsoletePurged: [],
    gc: null,
  };

  if (dryRun) {
    result.dryRun = true;
    return result;
  }

  // 1. Clean corrupt crash dumps
  result.corruptCleaned = cleanCorruptFiles(agentDir);

  // 2. Prune old import backup snapshots
  result.backupsPruned = pruneOldBackups(agentDir, keepBackups);

  // 3. Purge obsolete files
  result.obsoletePurged = cleanObsoleteFiles(agentDir);

  // 4. Run native GC
  if (!skipGc) {
    result.gc = await runOmpGc({ archiveDays, agentDir });
  }

  // 5. Update stamp
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(stampFile, JSON.stringify(result, null, 2), "utf8");
  } catch {}

  return result;
}

/**
 * Start non-blocking background auto-maintenance.
 * Runs in background after delayMs without blocking startup.
 */
export function scheduleAutoMaintenance(agentDir = getAgentDir(), delayMs = 4000) {
  setTimeout(() => {
    runMaintenance({ agentDir }).catch(() => {});
  }, delayMs).unref?.();
}

const CRON_TAG = "# omp-auto-maint";

/**
 * Check if automated maintenance is scheduled in system crontab.
 */
export function getCronStatus() {
  try {
    const out = execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.includes(CRON_TAG));
    return { installed: Boolean(line), line: line || null, supported: true };
  } catch {
    return { installed: false, line: null, supported: false };
  }
}

/**
 * A valid cron schedule is exactly 5 whitespace-separated fields of digits, *, -, /, comma.
 */
export function validateCronSchedule(s) {
  return /^[\d*,\-/]+(?: [\d*,\-/]+){4}$/.test(String(s ?? ""));
}

/**
 * Install scheduled maintenance into system crontab.
 */
export function installCron(schedule = "0 3 * * *", command = null) {
  if (!validateCronSchedule(schedule)) {
    throw new Error("invalid cron schedule: expected 5 fields of digits, *, -, /, comma");
  }
  try {
    let current = "";
    try {
      current = execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
    } catch {}

    const lines = current.split("\n").filter((l) => !l.includes(CRON_TAG) && l.trim().length > 0);
    const cmd = command || "npx -y omp-config-crypt maint --force > /dev/null 2>&1";
    lines.push(`${schedule} ${cmd} ${CRON_TAG}`);

    const tmp = path.join(os.tmpdir(), `omp-crontab-${randomUUID()}`);
    fs.writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
    try {
      execFileSync("crontab", [tmp], { stdio: "pipe" });
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
    return { success: true, schedule, command: cmd };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Remove scheduled maintenance from system crontab.
 */
export function removeCron() {
  try {
    let current = "";
    try {
      current = execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
    } catch {}

    const lines = current.split("\n").filter((l) => !l.includes(CRON_TAG) && l.trim().length > 0);
    if (lines.length > 0) {
      const tmp = path.join(os.tmpdir(), `omp-crontab-${randomUUID()}`);
      fs.writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
      try {
        execFileSync("crontab", [tmp], { stdio: "pipe" });
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
    } else {
      execSync("crontab -r 2>/dev/null || true");
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
