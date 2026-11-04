import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  assertSafeTarget,
  atomicWriteFile,
  configRoot,
  isPidAlive,
  LOCK_FILE,
  readLockFile,
  RECOVERY_LOCK_FILE,
  withSyncLock,
} from "./sync-files.js";
import {
  getSyncPlanTransaction,
  STATE_FILE,
  SENTINEL_DELETED,
} from "./sync-plan.js";

export { LOCK_FILE };

function fileSha256(bufOrStr) {
  if (bufOrStr === null || bufOrStr === undefined) return SENTINEL_DELETED;
  return createHash("sha256").update(bufOrStr).digest("hex");
}

function ensureDir(abs) {
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
}

function fsyncPath(abs) {
  try {
    const fd = fs.openSync(abs, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

function writeJournalAtomic(journalPath, journal) {
  atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

function currentHash(abs) {
  if (!fs.existsSync(abs)) return SENTINEL_DELETED;
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Unsupported target type at '${abs}'`);
  }
  return fileSha256(fs.readFileSync(abs));
}

function currentMode(abs) {
  if (!fs.existsSync(abs)) return null;
  return fs.lstatSync(abs).mode & 0o777;
}

function resolveEntryAbs(root, entry) {
  return assertSafeTarget(root, entry.rel).abs;
}

function allowedHashes(entry) {
  const recovery = entry.recoveryStatus || null;
  if (recovery === "restored") return new Set([entry.origHash]);
  if (recovery === "rollbackIntent") return new Set([entry.origHash, entry.plannedHash]);
  if (entry.status === "pending") return new Set([entry.origHash]);
  if (entry.status === "intent") return new Set([entry.origHash, entry.plannedHash]);
  if (entry.status === "completed") return new Set([entry.plannedHash]);
  throw new Error(`Unsupported journal entry status '${entry.status}'`);
}

function validateJournalStructure(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) {
    throw new Error("Invalid journal: root must be an object");
  }
  if (journal.version !== 2) {
    throw new Error("Legacy journal cannot be verified; manual recovery required");
  }
  if (typeof journal.transactionId !== "string" || !journal.transactionId) {
    throw new Error("Invalid journal: missing transactionId");
  }
  if (!Array.isArray(journal.entries) || !Array.isArray(journal.createdDirectories)) {
    throw new Error("Invalid journal: entries/createdDirectories must be arrays");
  }
  return journal;
}

function validateBackupAndTargets(root, backupDir, journal) {
  validateJournalStructure(journal);

  for (const entry of journal.entries) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid journal entry");
    if (entry.root !== "agent" && entry.root !== "omp") throw new Error("Invalid journal entry root");
    if (typeof entry.rel !== "string" || !entry.rel) throw new Error("Invalid journal entry rel");

    resolveEntryAbs(root, entry);

    if (entry.existedBefore) {
      if (typeof entry.backupFile !== "string" || !entry.backupFile.startsWith("files/")) {
        throw new Error(`Missing backup reference for '${entry.rel}'`);
      }
      const backupAbs = path.resolve(backupDir, entry.backupFile);
      if (!backupAbs.startsWith(path.resolve(backupDir) + path.sep)) {
        throw new Error(`Backup path escapes backup directory for '${entry.rel}'`);
      }
      if (!fs.existsSync(backupAbs)) {
        throw new Error(`Missing backup integrity for '${entry.rel}'`);
      }
      const backupHash = fileSha256(fs.readFileSync(backupAbs));
      if (backupHash !== entry.origHash) {
        throw new Error(`Backup integrity mismatch for '${entry.rel}'`);
      }
    } else if (entry.backupFile) {
      throw new Error(`Unexpected backup for new file '${entry.rel}'`);
    }

    const abs = resolveEntryAbs(root, entry);
    const actual = currentHash(abs);
    if (!allowedHashes(entry).has(actual)) {
      throw new Error(`Target '${entry.rel}' modified after sync; rollback refused`);
    }
  }

  if (journal.stateGuard) {
    const stateAbs = path.join(root, STATE_FILE);
    const stateEntry = journal.entries.find((entry) => entry.rel === STATE_FILE);
    if (!stateEntry) {
      const existed = fs.existsSync(stateAbs);
      const hash = existed ? fileSha256(fs.readFileSync(stateAbs)) : SENTINEL_DELETED;
      const mode = existed ? currentMode(stateAbs) : null;
      if (
        Boolean(journal.stateGuard.existed) !== existed ||
        journal.stateGuard.hash !== hash ||
        journal.stateGuard.mode !== mode
      ) {
        throw new Error("Sync state baseline modified; rollback refused");
      }
    }
  }
}

function restoreEntry(root, backupDir, entry) {
  const abs = resolveEntryAbs(root, entry);
  ensureDir(path.dirname(abs));
  if (entry.existedBefore) {
    const backupAbs = path.join(backupDir, entry.backupFile);
    atomicWriteFile(abs, fs.readFileSync(backupAbs), entry.origMode ?? 0o600);
  } else if (fs.existsSync(abs)) {
    fs.unlinkSync(abs);
  }
}

function cleanupTempsAndEmptyDirs(root, journal) {
  for (const entry of journal.entries) {
    if (!entry.tempRel) continue;
    try {
      const candidate = path.join(path.dirname(resolveEntryAbs(root, entry)), entry.tempRel);
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    } catch {}
  }
  for (const rel of [...journal.createdDirectories].reverse()) {
    try {
      const abs = assertSafeTarget(root, rel).abs;
      if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch {}
  }
}

function recoverJournal(root, backupDir, journal, { renameBackup = true } = {}) {
  validateBackupAndTargets(root, backupDir, journal);
  const journalPath = path.join(backupDir, "journal.json");
  journal.status = "rolling_back";
  writeJournalAtomic(journalPath, journal);

  for (const entry of [...journal.entries].reverse()) {
    entry.recoveryStatus = "rollbackIntent";
    writeJournalAtomic(journalPath, journal);
    restoreEntry(root, backupDir, entry);
    entry.recoveryStatus = "restored";
    writeJournalAtomic(journalPath, journal);
  }

  cleanupTempsAndEmptyDirs(root, journal);
  journal.status = "rolled_back";
  writeJournalAtomic(journalPath, journal);

  let rolledBackFrom = backupDir;
  if (renameBackup) {
    const base = path.basename(backupDir).replace(/^\.import-backup-/, "");
    let rolled = path.join(root, `.rolled-back-${base}`);
    if (fs.existsSync(rolled)) rolled = `${rolled}-${randomUUID()}`;
    fs.renameSync(backupDir, rolled);
    rolledBackFrom = rolled;
  }

  return {
    files: journal.entries.filter((entry) => entry.rel !== STATE_FILE).length,
    rolledBackFrom,
  };
}

function observeStateGuard(readContext, root) {
  const stateAbs = path.join(root, STATE_FILE);
  const bytes = readContext.readFile(stateAbs);
  if (bytes === undefined) {
    return { existed: false, hash: SENTINEL_DELETED, mode: null };
  }
  return {
    existed: true,
    hash: fileSha256(bytes),
    mode: readContext.fileMode(stateAbs),
  };
}

function ensureParents(abs, createdDirectories) {
  const stack = [];
  let probe = path.dirname(abs);
  while (probe && probe !== path.dirname(probe) && !fs.existsSync(probe)) {
    stack.push(probe);
    probe = path.dirname(probe);
  }
  for (const dir of stack.reverse()) {
    fs.mkdirSync(dir);
    createdDirectories.push(dir);
  }
}

export function commitFileTransaction(root, transaction, lock) {
  const agentDir = path.resolve(root);
  const readContext = transaction.readContext;
  const entriesMap = transaction.entries;
  if (!readContext || !entriesMap) {
    throw new Error("Invalid sync transaction: missing rendered entries");
  }
  if (!transaction.needsCommit) {
    return { filesWritten: 0, backupDir: undefined, success: true };
  }

  readContext.verify();
  const stateGuard = transaction.stateGuard || observeStateGuard(readContext, agentDir);

  const backupName = `.import-backup-${Date.now()}-${randomUUID()}`;
  const backupDir = path.join(agentDir, backupName);
  const filesDir = path.join(backupDir, "files");
  ensureDir(filesDir);
  const journalPath = path.join(backupDir, "journal.json");

  const journalEntries = [];
  let backupIndex = 0;
  for (const entry of entriesMap.values()) {
    const abs = entry.abs;
    const existed = fs.existsSync(abs);
    let origHash = SENTINEL_DELETED;
    let origMode = null;
    let backupFile = null;
    if (existed) {
      const bytes = fs.readFileSync(abs);
      origHash = fileSha256(bytes);
      origMode = fs.lstatSync(abs).mode & 0o777;
      backupFile = `files/${backupIndex++}`;
      fs.writeFileSync(path.join(backupDir, backupFile), bytes);
      try {
        fs.chmodSync(path.join(backupDir, backupFile), origMode);
      } catch {}
      fsyncPath(path.join(backupDir, backupFile));
    }
    journalEntries.push({
      root:
        entry.rel.startsWith("plugins/") ||
        entry.rel.startsWith("tools/") ||
        entry.rel.startsWith("hooks/")
          ? "omp"
          : "agent",
      rel: entry.rel,
      backupFile,
      existedBefore: existed,
      origHash,
      origMode,
      plannedHash: entry.operation === "delete" ? SENTINEL_DELETED : fileSha256(entry.content),
      plannedMode: entry.operation === "delete" ? null : entry.mode,
      type: entry.operation,
      status: "pending",
      tempRel: null,
      recoveryStatus: null,
    });
  }

  const stateAbs = path.join(agentDir, STATE_FILE);
  const stateBytes = Buffer.from(`${JSON.stringify(transaction.nextState, null, 2)}\n`, "utf8");
  const stateExisted = fs.existsSync(stateAbs);
  let stateOrigHash = SENTINEL_DELETED;
  let stateOrigMode = null;
  let stateBackupFile = null;
  if (stateExisted) {
    const prev = fs.readFileSync(stateAbs);
    stateOrigHash = fileSha256(prev);
    stateOrigMode = fs.lstatSync(stateAbs).mode & 0o777;
    stateBackupFile = `files/${backupIndex++}`;
    fs.writeFileSync(path.join(backupDir, stateBackupFile), prev);
    fsyncPath(path.join(backupDir, stateBackupFile));
  }
  journalEntries.push({
    root: "agent",
    rel: STATE_FILE,
    backupFile: stateBackupFile,
    existedBefore: stateExisted,
    origHash: stateOrigHash,
    origMode: stateOrigMode,
    plannedHash: fileSha256(stateBytes),
    plannedMode: stateOrigMode ?? 0o600,
    type: "write",
    status: "pending",
    tempRel: null,
    recoveryStatus: null,
  });

  const journal = {
    version: 2,
    transactionId: lock.transactionId,
    timestamp: new Date().toISOString(),
    status: "preparing",
    entries: journalEntries,
    createdDirectories: [],
    stateGuard,
  };
  writeJournalAtomic(journalPath, journal);
  lock.setBackupDir(backupName);
  journal.status = "in_progress";
  writeJournalAtomic(journalPath, journal);

  const createdDirectories = [];
  try {
    for (const entry of journal.entries) {
      const abs = resolveEntryAbs(agentDir, entry);
      if (currentHash(abs) !== entry.origHash) {
        throw new Error(`Concurrent modification detected: '${entry.rel}' changed`);
      }

      entry.status = "intent";
      writeJournalAtomic(journalPath, journal);

      if (entry.type === "write") {
        ensureParents(abs, createdDirectories);
        const content =
          entry.rel === STATE_FILE ? stateBytes : entriesMap.get(entry.rel).content;
        const mode = entry.plannedMode ?? 0o600;
        const tempName = `.${path.basename(abs)}.tmp-${randomUUID()}`;
        const tempAbs = path.join(path.dirname(abs), tempName);
        entry.tempRel = tempName;
        writeJournalAtomic(journalPath, journal);
        fs.writeFileSync(tempAbs, content, { mode });
        fsyncPath(tempAbs);
        fs.renameSync(tempAbs, abs);
        try {
          fs.chmodSync(abs, mode);
        } catch {}
      } else if (entry.type === "delete") {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } else {
        throw new Error(`Unsupported entry type '${entry.type}'`);
      }

      entry.status = "completed";
      entry.tempRel = null;
      writeJournalAtomic(journalPath, journal);
    }

    journal.createdDirectories = createdDirectories.map((abs) =>
      path.relative(agentDir, abs).replace(/\\/g, "/")
    );
    journal.status = "completed";
    writeJournalAtomic(journalPath, journal);

    return {
      success: true,
      filesWritten: journal.entries.filter((entry) => entry.rel !== STATE_FILE).length,
      backupDir,
    };
  } catch (error) {
    try {
      recoverJournal(agentDir, backupDir, journal, { renameBackup: true });
    } catch (recoveryError) {
      lock.preserveForRecovery();
      const err = new Error(
        `Sync failed and automatic recovery failed; manual recovery required: ${error.message}; recovery: ${recoveryError.message}`
      );
      err.cause = recoveryError;
      throw err;
    }
    const err = new Error(`Sync failed: ${error.message}`);
    err.cause = error;
    throw err;
  }
}

export function applySyncPlan(plan, root = configRoot()) {
  if (plan.conflicts && plan.conflicts.length > 0) {
    const err = new Error(
      `Cannot apply sync plan: ${plan.conflicts.length} conflict(s) detected.`
    );
    err.conflicts = plan.conflicts;
    throw err;
  }
  if (plan.blocked && plan.blocked.length > 0) {
    const err = new Error(
      `Cannot apply sync plan: ${plan.blocked.length} action(s) are blocked.`
    );
    err.blocked = plan.blocked;
    throw err;
  }

  const agentDir = path.resolve(root);
  const transaction = getSyncPlanTransaction(plan, agentDir);
  if (!transaction.needsCommit) {
    return { success: true, filesWritten: 0, backupDir: undefined };
  }

  return withSyncLock(agentDir, (lock) => commitFileTransaction(agentDir, transaction, lock));
}

function acquireRecoveryLock(root) {
  const recoveryPath = path.join(root, RECOVERY_LOCK_FILE);
  let fd;
  try {
    fd = fs.openSync(recoveryPath, "wx");
  } catch {
    throw new Error(`Sync recovery lock active at ${recoveryPath}; manual recovery required`);
  }
  fs.writeSync(
    fd,
    `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`
  );
  fs.closeSync(fd);
  return () => {
    try {
      fs.unlinkSync(recoveryPath);
    } catch {}
  };
}

function loadLatestJournal(agentDir) {
  const backups = fs
    .readdirSync(agentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".import-backup-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (backups.length === 0) {
    throw new Error("No import backup available to roll back");
  }
  const latest = backups[0];
  const backupDir = path.join(agentDir, latest);
  const journalPath = path.join(backupDir, "journal.json");
  if (!fs.existsSync(journalPath)) {
    throw new Error("Legacy journal cannot be verified; manual recovery required");
  }
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    throw new Error("Legacy journal cannot be verified; manual recovery required");
  }
  if (journal.version !== 2) {
    throw new Error("Legacy journal cannot be verified; manual recovery required");
  }
  return { latest, backupDir, journal };
}

export function rollbackSync(root = configRoot()) {
  const agentDir = path.resolve(root);
  if (!fs.existsSync(agentDir)) {
    throw new Error(`Root directory does not exist: ${agentDir}`);
  }

  const releaseRecovery = acquireRecoveryLock(agentDir);
  try {
    let lock = null;
    try {
      lock = readLockFile(agentDir);
    } catch (error) {
      throw error;
    }

    if (lock && isPidAlive(lock.content.pid)) {
      throw new Error(
        `Active sync lock is still running (pid ${lock.content.pid}); rollback refused`
      );
    }

    const { latest, backupDir, journal } = loadLatestJournal(agentDir);

    if (lock) {
      if (
        lock.content.transactionId !== journal.transactionId ||
        lock.content.backupDir !== latest
      ) {
        throw new Error("Sync lock does not match journal; manual recovery required");
      }
      const result = recoverJournal(agentDir, backupDir, journal, { renameBackup: true });
      try {
        fs.unlinkSync(lock.path);
      } catch {}
      return result;
    }

    return withSyncLock(
      agentDir,
      () => recoverJournal(agentDir, backupDir, journal, { renameBackup: true }),
      { allowDuringRecovery: true, transactionId: journal.transactionId }
    );
  } finally {
    releaseRecovery();
  }
}
