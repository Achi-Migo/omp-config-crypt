import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { ompHome } from "../index.js";

const LINKS_FILE = ".plugin-links.json";

/**
 * Scan plugins directory node_modules for symlinks and return a map of name -> targetPath.
 */
export function getPluginLinks(pluginsDir) {
  const nodeModules = path.join(pluginsDir, "node_modules");
  const links = {};
  if (!fs.existsSync(nodeModules)) return links;

  function scan(dir, prefix = "") {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        try {
          const target = fs.realpathSync(full);
          const pkgName = prefix ? `${prefix}/${ent.name}` : ent.name;
          links[pkgName] = target;
        } catch {
          try {
            const rawTarget = fs.readlinkSync(full);
            const pkgName = prefix ? `${prefix}/${ent.name}` : ent.name;
            links[pkgName] = path.resolve(dir, rawTarget);
          } catch {}
        }
      } else if (ent.isDirectory() && ent.name.startsWith("@")) {
        scan(full, ent.name);
      }
    }
  }

  scan(nodeModules);
  return links;
}

/**
 * Persist known plugin links into .plugin-links.json.
 */
export function savePluginLinks(pluginsDir, links) {
  if (!links || Object.keys(links).length === 0) return;
  const filePath = path.join(pluginsDir, LINKS_FILE);
  try {
    let existing = {};
    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {}
    }
    const merged = { ...existing, ...links };
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  } catch {}
}

/**
 * Detect missing or broken plugins in plugins directory.
 */
export function detectMissingPlugins(pluginsDir) {
  const missing = {
    npmDependencies: [],
    linkedPlugins: [],
  };

  const lockPath = path.join(pluginsDir, "omp-plugins.lock.json");
  const pkgPath = path.join(pluginsDir, "package.json");
  const nodeModules = path.join(pluginsDir, "node_modules");

  // 1. Check npm dependencies
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = pkg.dependencies || {};
      for (const dep of Object.keys(deps)) {
        const depPath = path.join(nodeModules, ...dep.split("/"));
        if (!fs.existsSync(depPath)) {
          missing.npmDependencies.push(dep);
        }
      }
    } catch {}
  }

  // 2. Check locked plugins (including links)
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const plugins = lock.plugins || {};
      for (const name of Object.keys(plugins)) {
        const pluginPath = path.join(nodeModules, ...name.split("/"));
        let exists = false;
        try {
          exists = fs.existsSync(pluginPath);
        } catch {}
        if (!exists) {
          if (!missing.npmDependencies.includes(name)) {
            missing.linkedPlugins.push(name);
          }
        }
      }
    } catch {}
  }

  return missing;
}

/**
 * Perform autonomous rehydration: npm install + link repair.
 */
export function rehydratePlugins(root, options = {}) {
  const pluginsDir = path.join(ompHome(root), "plugins");
  const dryRun = Boolean(options.dryRun);
  const results = {
    rehydrated: 0,
    npmInstalled: [],
    linksRepaired: [],
    errors: [],
  };

  if (!fs.existsSync(pluginsDir)) {
    return results;
  }

  const missing = detectMissingPlugins(pluginsDir);
  const pkgPath = path.join(pluginsDir, "package.json");
  const lockLinksPath = path.join(pluginsDir, LINKS_FILE);

  // 1. Run npm install if npm dependencies are missing or package.json exists without node_modules
  const nodeModules = path.join(pluginsDir, "node_modules");
  const needsNpmInstall =
    fs.existsSync(pkgPath) &&
    (missing.npmDependencies.length > 0 || !fs.existsSync(nodeModules));

  if (needsNpmInstall) {
    if (dryRun) {
      results.npmInstalled.push(...missing.npmDependencies);
    } else {
      try {
        execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
          cwd: pluginsDir,
          stdio: "pipe",
          timeout: 60000,
        });
        results.npmInstalled.push(...missing.npmDependencies);
      } catch (err) {
        results.errors.push(`npm install failed: ${err.message}`);
      }
    }
  }

  // 2. Load stored link targets
  let storedLinks = {};
  if (fs.existsSync(lockLinksPath)) {
    try {
      storedLinks = JSON.parse(fs.readFileSync(lockLinksPath, "utf8"));
    } catch {}
  }

  // Known candidate fallback directories for common local plugins
  const candidateDirs = {
    "@omp/plugin-rsi": ["/opt/project/omp-rsi", path.join(os.homedir(), "omp-rsi")],
    "omp-config-crypt": ["/root/omp-config-crypt", path.join(os.homedir(), "omp-config-crypt")],
  };

  // 3. Resolve and repair linked plugins
  const pluginsToLink = Array.from(
    new Set([...missing.linkedPlugins, ...Object.keys(storedLinks)])
  );

  for (const name of pluginsToLink) {
    const linkPath = path.join(nodeModules, ...name.split("/"));
    let isHealthy = false;
    try {
      if (fs.existsSync(linkPath)) {
        isHealthy = true;
      }
    } catch {}

    if (isHealthy) continue;

    // Find candidate target path
    let targetDir = storedLinks[name];
    if (!targetDir || !fs.existsSync(targetDir)) {
      const candidates = candidateDirs[name] || [];
      targetDir = candidates.find((c) => fs.existsSync(c)) || null;
    }

    if (!targetDir || !fs.existsSync(targetDir)) {
      if (!dryRun) {
        try {
          execFileSync("npm", ["install", `${name}@latest`, "--omit=dev", "--no-audit", "--no-fund"], {
            cwd: pluginsDir,
            stdio: "pipe",
            timeout: 60000,
          });
          results.npmInstalled.push(name);
          continue;
        } catch {}
      }
      results.errors.push(`Target directory for plugin ${name} not found`);
      continue;
    }

    if (dryRun) {
      results.linksRepaired.push({ name, target: targetDir });
    } else {
      try {
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        try {
          fs.rmSync(linkPath, { force: true, recursive: true });
        } catch {}
        fs.symlinkSync(targetDir, linkPath, "dir");
        results.linksRepaired.push({ name, target: targetDir });
      } catch (err) {
        results.errors.push(`Failed to link ${name} -> ${targetDir}: ${err.message}`);
      }
    }
  }

  results.rehydrated = results.npmInstalled.length + results.linksRepaired.length;
  return results;
}
