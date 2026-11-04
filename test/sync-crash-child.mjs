import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { restoreArchive } from "../index.js";

const [root, archivePath, targetRel, mode, pass] = process.argv.slice(2);
const target = path.resolve(root, targetRel);
const realRename = fs.renameSync;

fs.renameSync = function renameSync(src, dest) {
  if (path.resolve(String(dest)) === target) {
    if (mode === "after-replace") {
      realRename(src, dest);
      process.exit(92);
    }
    process.exit(91);
  }
  return realRename(src, dest);
};

restoreArchive(fs.readFileSync(archivePath), pass, root);
process.exit(90);
