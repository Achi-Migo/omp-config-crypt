#!/usr/bin/env node

/**
 * Universal Standalone CLI for OMP Config Crypt & Sync Engine
 * Operates independently of OMP runtime; zero external dependencies.
 */

import readline from "node:readline";
import process from "node:process";
import {
  configRoot,
  exportEncrypted,
  importEncrypted,
  pushGist,
  pullGist,
  pushHttp,
  pullHttp,
  rollback,
  parseSpec,
  rehydratePlugins,
  probeProvider,
  saveProvider,
  removeProvider,
  listProviders,
  getRoles,
  setRole,
  VALID_ROLES,
  runMaintenance,
  getCronStatus,
  installCron,
  removeCron,
} from "../index.js";

function printHelp() {
  console.log(`
Universal OMP Configuration Sync & Crypt Engine (Standalone CLI)

Usage:
  omp-sync <command> [arguments] [options]

Commands:
  export <outFile>         Encrypt and export local OMP configs to a file
  import <srcFile>         Decrypt and restore OMP configs from an archive
  push <gist:id|url>       Encrypt and push configs to GitHub Gist or HTTP URL
  pull <gist:id|url>       Download and restore configs from Gist or HTTP URL
  rollback                 Revert the most recent config restore from its backup
  rehydrate                Rehydrate and repair locked/linked plugins in ~/.omp/plugins
  maint / gc [--force]     Run automatic storage maintenance, WAL checkpoint & GC
  cron [install|status|rm] Manage OS-level scheduled crontab maintenance job
  provider add <name>      Auto-probe and add an LLM provider (public or private)
  provider ls / list       List configured providers, models and active role bindings
  provider rm <name>       Remove a provider from public or private store
  role set <role> <ref>    Bind role (default/smol/plan/slow/web) to provider/model
  role ls / list           List active model role mappings

Options:
  -p, --pass <passphrase>  Decryption/Encryption passphrase (or OMP_CONFIG_PASS)
  -t, --token <token>      Cloud token (or OMP_CFG_CLOUD_TOKEN / GITHUB_TOKEN)
  -r, --root <path>        Agent configuration root (default: ~/.omp/agent)
  -d, --dry-run            Simulate restore without modifying files
  -h, --help               Show this help message
      --no-rehydrate       Skip automatic plugin rehydration on import/pull
      --rehydrate          Enforce plugin rehydration (default: true)
  -u, --url <url>          Endpoint URL for provider (e.g. https://api.openai.com/v1)
  -k, --key <key>          Provider API Key
      --api <type>         API type: openai-completions (default) | anthropic-messages
  -m, --model <id>         Model ID to select/bind
      --role <role>        Auto-bind role upon adding (default, smol, plan, slow, web)
      --private            Save as private (local-only, unsynced, non-overwritten) [default]
      --public             Save as public (synced across machines via models.yml)
  -y, --yes                Non-interactive mode (use defaults without prompting)
  -f, --force              Force operations (e.g. bypass maintenance debounce)
      --profile <name>       Target specific profile scene (e.g. dev, ops)

Environment Variables:
  OMP_CONFIG_PASS          Passphrase for non-interactive automation
  OMP_CFG_CLOUD_TOKEN      Cloud / GitHub API Token
  GITHUB_TOKEN             Alternative GitHub API Token
  OMP_CFG_ROOT             Override path to ~/.omp/agent
  OMP_HOME                 Override path to ~/.omp
`);
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const options = {
    command: null,
    target: null,
    pass: process.env.OMP_CONFIG_PASS || null,
    token: process.env.OMP_CFG_CLOUD_TOKEN || process.env.GITHUB_TOKEN || null,
    root: process.env.OMP_CFG_ROOT || null,
    dryRun: false,
    rehydrate: true,
    help: false,
    url: null,
    key: null,
    api: "openai-completions",
    model: null,
    role: null,
    isPrivate: null,
    nonInteractive: false,
    force: false,
    positional: [],
    profile: null,
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help" || a === "help") {
      options.help = true;
    } else if (a === "-d" || a === "--dry-run") {
      options.dryRun = true;
    } else if (a === "-p" || a === "--pass") {
      options.pass = args[++i];
    } else if (a === "--no-rehydrate") {
      options.rehydrate = false;
    } else if (a === "--rehydrate") {
      options.rehydrate = true;
    } else if (a === "-t" || a === "--token") {
      options.token = args[++i];
    } else if (a === "-r" || a === "--root") {
      options.root = args[++i];
    } else if (a === "-u" || a === "--url") {
      options.url = args[++i];
    } else if (a === "-k" || a === "--key") {
      options.key = args[++i];
    } else if (a === "--api") {
      options.api = args[++i];
    } else if (a === "-m" || a === "--model") {
      options.model = args[++i];
    } else if (a === "--role") {
      options.role = args[++i];
    } else if (a === "--private") {
      options.isPrivate = true;
    } else if (a === "--public") {
      options.isPrivate = false;
    } else if (a === "-y" || a === "--yes" || a === "--non-interactive") {
      options.nonInteractive = true;
    } else if (a === "-f" || a === "--force") {
      options.force = true;
    } else if (a === "--profile") {
      options.profile = args[++i];
    } else if (a.startsWith("--profile=")) {
      options.profile = a.slice(10);
    } else if (a.startsWith("--pass=")) {
      options.pass = a.slice(7);
    } else if (a.startsWith("--token=")) {
      options.token = a.slice(8);
    } else if (a.startsWith("--root=")) {
      options.root = a.slice(7);
    } else if (a.startsWith("--url=")) {
      options.url = a.slice(6);
    } else if (a.startsWith("--key=")) {
      options.key = a.slice(6);
    } else if (a.startsWith("--api=")) {
      options.api = a.slice(6);
    } else if (a.startsWith("--model=")) {
      options.model = a.slice(8);
    } else if (a.startsWith("--role=")) {
      options.role = a.slice(7);
    } else {
      positional.push(a);
    }
  }

  options.command = positional[0] || null;
  options.target = positional[1] || null;
  options.positional = positional;
  return options;
}

async function promptText(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function resolvePass(pass) {
  if (pass) return pass;
  if (!process.stdin.isTTY) {
    throw new Error("Passphrase required: specify --pass <passphrase> or set OMP_CONFIG_PASS");
  }
  return promptText("Enter passphrase: ");
}

async function resolveToken(token, required) {
  if (token) return token;
  if (!required) return null;
  if (!process.stdin.isTTY) {
    throw new Error("Token required: specify --token <token> or set OMP_CFG_CLOUD_TOKEN / GITHUB_TOKEN");
  }
  return promptText("Enter GitHub/Cloud token: ");
}

async function main() {
  const options = parseCliArgs(process.argv);
  if (options.help || !options.command) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  const root =
    options.root ||
    (options.profile
      ? path.join(os.homedir(), ".omp", "profiles", options.profile, "agent")
      : configRoot());
  try {
    switch (options.command) {
      case "export": {
        if (!options.target) {
          throw new Error("Usage: omp-sync export <outFile> [options]");
        }
        const pass = await resolvePass(options.pass);
        const res = exportEncrypted(options.target, pass, root);
        console.log(`[export] Successfully exported ${res.files} files (${res.bytes} bytes) -> ${res.outFile}`);
        break;
      }

      case "import": {
        if (!options.target) {
          throw new Error("Usage: omp-sync import <srcFile> [options]");
        }
        const pass = await resolvePass(options.pass);
        const res = importEncrypted(options.target, pass, root, {
          dryRun: options.dryRun,
          rehydrate: options.rehydrate,
        });
        if (options.dryRun) {
          console.log(`[import-dry-run] Would restore ${res.files} files (0 written to disk).`);
          for (const act of res.actions) {
            console.log(`  - ${act.path} -> ${act.dest}${act.remapped ? " [path remapped]" : ""}`);
          }
        } else {
          console.log(`[import] Successfully restored ${res.files} files to ${root}.`);
          if (res.backupDir) {
            console.log(`[backup] Pre-existing files backed up to: ${res.backupDir}`);
          }
          if (res.rehydration) {
            console.log(
              `[rehydrate] Plugins processed: ${res.rehydration.rehydrated} rehydrated (installed: ${res.rehydration.npmInstalled.length}, links: ${res.rehydration.linksRepaired.length}).`
            );
          }
          if (res.purged && res.purged.length > 0) {
            console.log(`[cleanup] Automatically purged ${res.purged.length} obsolete file(s) (e.g. legacy agy.js).`);
          }
        }
        break;
      }

      case "push": {
        if (!options.target) {
          throw new Error("Usage: omp-sync push <gist:id|new|https://url> [options]");
        }
        const target = parseSpec(options.target);
        const pass = await resolvePass(options.pass);
        const token = await resolveToken(options.token, target.kind === "gist");
        const res =
          target.kind === "gist"
            ? await pushGist(target.id, pass, root, token)
            : await pushHttp(target.url, pass, root, token);

        console.log(`[push] Successfully pushed ${res.files} files (${res.bytes} bytes).`);
        if (res.url) {
          console.log(`[url] Gist URL: ${res.url}`);
        }
        if (res.id) {
          console.log(`[id] Gist ID: ${res.id}`);
        }
        break;
      }

      case "pull": {
        if (!options.target) {
          throw new Error("Usage: omp-sync pull <gist:id|https://url> [options]");
        }
        const target = parseSpec(options.target);
        const pass = await resolvePass(options.pass);
        const token = await resolveToken(options.token, target.kind === "gist");
        const res =
          target.kind === "gist"
            ? await pullGist(target.id, pass, root, token, { dryRun: options.dryRun, rehydrate: options.rehydrate })
            : await pullHttp(target.url, pass, root, token, { dryRun: options.dryRun, rehydrate: options.rehydrate });

        if (options.dryRun) {
          console.log(`[pull-dry-run] Would restore ${res.files} files (0 written to disk).`);
          for (const act of res.actions) {
            console.log(`  - ${act.path} -> ${act.dest}${act.remapped ? " [path remapped]" : ""}`);
          }
        } else {
          console.log(`[pull] Successfully restored ${res.files} files to ${root}.`);
          if (res.backupDir) {
            console.log(`[backup] Pre-existing files backed up to: ${res.backupDir}`);
          }
          if (res.rehydration) {
            console.log(
              `[rehydrate] Plugins processed: ${res.rehydration.rehydrated} rehydrated (installed: ${res.rehydration.npmInstalled.length}, links: ${res.rehydration.linksRepaired.length}).`
            );
          }
          if (res.purged && res.purged.length > 0) {
            console.log(`[cleanup] Automatically purged ${res.purged.length} obsolete file(s) (e.g. legacy agy.js).`);
          }
        }
        break;
      }

      case "rollback": {
        const res = rollback(root);
        console.log(`[rollback] Successfully rolled back ${res.files} files from snapshot ${res.rolledBackFrom}`);
        break;
      }

      case "rehydrate": {
        const res = rehydratePlugins(root, { dryRun: options.dryRun });
        console.log(
          `[rehydrate] Completed. Total rehydrated: ${res.rehydrated} (installed: ${res.npmInstalled.length}, links: ${res.linksRepaired.length}).`
        );
        if (res.errors.length > 0) {
          for (const err of res.errors) {
            console.warn(`  [warning] ${err}`);
          }
        }
        break;
      }
      case "maint":
      case "gc": {
        const force = Boolean(options.force || options.positional?.includes("--force"));
        console.log(`[maint] Running storage maintenance and garbage collection on ${root}...`);
        const res = await runMaintenance({
          agentDir: root,
          force,
          dryRun: options.dryRun,
        });

        if (res.skipped) {
          console.log(
            `[maint] Storage maintenance skipped (already executed recently). Next run in ~${res.nextRunInMinutes}m. Use --force to override.`
          );
          break;
        }

        console.log(`[maint] ✓ Corrupt crash files cleaned: ${res.corruptCleaned?.length || 0}`);
        console.log(`[maint] ✓ Obsolete legacy files purged: ${res.obsoletePurged?.length || 0}`);
        console.log(`[maint] ✓ Old backup snapshots pruned: ${res.backupsPruned?.length || 0}`);
        if (res.gc) {
          if (res.gc.success) {
            console.log(`[maint] ✓ Native GC & WAL checkpoint:\n  ${res.gc.output.split("\n").join("\n  ")}`);
          } else {
            console.warn(`[maint] ⚠ Native GC warning: ${res.gc.error}`);
          }
        }
        break;
      }
      case "cron": {
        const sub = (options.target || "status").toLowerCase();
        if (sub === "status") {
          const st = getCronStatus();
          if (!st.supported) {
            console.log("[cron] System crontab is not supported or not available in this environment.");
          } else if (st.installed) {
            console.log(`[cron] ✓ Active scheduled maintenance job:\n  ${st.line}`);
          } else {
            console.log("[cron] No automated maintenance job installed in crontab. Run 'omp-sync cron install' to enable.");
          }
        } else if (sub === "install" || sub === "enable") {
          const schedule = options.positional[2] || "0 3 * * *";
          const res = installCron(schedule);
          if (res.success) {
            console.log(`[cron] ✓ Successfully installed maintenance job (${res.schedule}) in system crontab.`);
          } else {
            console.error(`[cron] ✗ Failed to install crontab job: ${res.error}`);
          }
        } else if (sub === "remove" || sub === "rm" || sub === "uninstall" || sub === "disable") {
          const res = removeCron();
          if (res.success) {
            console.log("[cron] ✓ Successfully removed maintenance job from system crontab.");
          } else {
            console.error(`[cron] ✗ Failed to remove crontab job: ${res.error}`);
          }
        } else {
          throw new Error(`Unknown cron subcommand: ${sub}. Allowed: status, install [schedule], remove.`);
        }
        break;
      }

      case "provider": {
        const sub = (options.target || "list").toLowerCase();
        if (sub === "list" || sub === "ls") {
          const providers = listProviders({ agentDir: root });
          if (providers.length === 0) {
            console.log("No providers configured in public or private stores.");
            break;
          }
          const roles = getRoles(root);
          console.log("Configured Providers:");
          for (const p of providers) {
            const tier = p.isPrivate
              ? "\x1b[33m[PRIVATE (local-only, unsynced)]\x1b[0m"
              : "\x1b[32m[PUBLIC (synced)]\x1b[0m";
            const boundRoles = Object.entries(roles)
              .filter(([_, ref]) => ref.startsWith(`${p.name}/`))
              .map(([r, ref]) => `${r} -> ${ref.split("/")[1]}`);
            const roleStr = boundRoles.length > 0 ? ` (Active: ${boundRoles.join(", ")})` : "";
            console.log(`  • ${p.name} ${tier}: ${p.baseUrl} (${p.api}, ${p.models.length} models)${roleStr}`);
            for (const m of p.models.slice(0, 5)) {
              const flags = [
                m.reasoning ? "reasoning" : null,
                m.input?.includes("image") ? "vision" : null,
                `${m.contextWindow / 1000}k ctx`,
              ]
                .filter(Boolean)
                .join(", ");
              console.log(`      - ${m.id} [${flags}]`);
            }
            if (p.models.length > 5) {
              console.log(`      ... and ${p.models.length - 5} more models`);
            }
          }
          break;
        }

        if (sub === "remove" || sub === "rm") {
          const name = options.positional[2];
          if (!name) {
            throw new Error("Usage: omp-sync provider remove <name>");
          }
          const removed = removeProvider({ name, agentDir: root });
          if (removed) {
            console.log(`[provider] ✓ Removed provider '${name}'`);
          } else {
            console.log(`[provider] Provider '${name}' not found.`);
          }
          break;
        }

        if (sub === "add") {
          let name = options.positional[2];
          if (!name) {
            if (process.stdin.isTTY && !options.nonInteractive) {
              name = await promptText("Enter a unique provider name (e.g. my-private-llm): ");
            }
            if (!name) {
              throw new Error("Usage: omp-sync provider add <name> [options]");
            }
          }

          let url = options.url;
          if (!url) {
            if (process.stdin.isTTY && !options.nonInteractive) {
              url = await promptText("Enter endpoint baseUrl (e.g. https://api.openai.com/v1): ");
            } else {
              throw new Error("Missing --url parameter for provider");
            }
          }

          let key = options.key;
          if (key === null) {
            if (process.stdin.isTTY && !options.nonInteractive) {
              key = await promptText("Enter API Key (press Enter if none): ");
            } else {
              key = "";
            }
          }

          let isPrivate = options.isPrivate;
          if (isPrivate === null) {
            if (process.stdin.isTTY && !options.nonInteractive) {
              const ans = await promptText("Is this provider private (local-only, unsynced)? [Y/n]: ");
              isPrivate = !/^n/i.test(ans.trim());
            } else {
              isPrivate = true; // Default to private for safety
            }
          }

          console.log(`[probe] Probing endpoint ${url}...`);
          const probed = await probeProvider({
            baseUrl: url,
            apiKey: key,
            api: options.api,
            testModelId: options.model,
            providerName: name,
          });

          if (!probed.ok) {
            console.error(`[probe] ✗ Probe failed: ${probed.error}`);
            if (!options.model) {
              throw new Error("Probe failed and no fallback --model specified. Aborted.");
            }
          } else {
            console.log(`[probe] ✓ Endpoint verified: ${probed.normalizedBaseUrl} (${probed.api})`);
            console.log(`[probe] ✓ Discovered ${probed.models.length} model(s)`);
          }

          let chosenModel = options.model;
          if (!chosenModel && probed.ok && probed.models.length > 0 && process.stdin.isTTY && !options.nonInteractive) {
            console.log("\nDiscovered models:");
            const displayList = probed.models.slice(0, 8);
            displayList.forEach((m, idx) => {
              const flags = [
                m.reasoning ? "reasoning" : null,
                m.input?.includes("image") ? "vision" : null,
                `${m.contextWindow / 1000}k ctx`,
              ]
                .filter(Boolean)
                .join(", ");
              console.log(`  [${idx + 1}] ${m.id} (${flags})`);
            });
            const sel = await promptText(`Select primary model [1-${displayList.length}, default 1]: `);
            const selIdx = parseInt(sel, 10);
            if (!isNaN(selIdx) && selIdx >= 1 && selIdx <= displayList.length) {
              chosenModel = displayList[selIdx - 1].id;
            } else {
              chosenModel = displayList[0].id;
            }
          }

          let roleToBind = options.role;
          if (!roleToBind && process.stdin.isTTY && !options.nonInteractive) {
            console.log("\nBind this model to an OMP role? (optional)");
            console.log("  [1] default (primary chat & orchestration)");
            console.log("  [2] smol (fast/subagent & tool execution)");
            console.log("  [3] plan (high-context architectural planning)");
            console.log("  [4] slow (deep reasoning / hard debug)");
            console.log("  [0] Skip (no binding)");
            const roleAns = await promptText("Select role [0-4, default 0]: ");
            const roleMap = { "1": "default", "2": "smol", "3": "plan", "4": "slow" };
            if (roleMap[roleAns.trim()]) {
              roleToBind = roleMap[roleAns.trim()];
            }
          }

          const models = probed.ok && probed.models.length > 0
            ? probed.models
            : [{ id: options.model || "custom-model", name: `${name} custom model`, contextWindow: 128000, maxTokens: 32000 }];

          saveProvider({
            name,
            providerConfig: {
              baseUrl: probed.ok ? probed.normalizedBaseUrl : url,
              api: probed.ok ? probed.api : options.api,
              apiKey: key,
              models,
            },
            isPrivate,
            agentDir: root,
          });

          console.log(
            `[provider] ✓ Provider '${name}' saved to ${
              isPrivate ? "PRIVATE store (models.local.json)" : "PUBLIC store (models.yml)"
            }`
          );

          if (roleToBind) {
            const modelToBind = chosenModel || models[0]?.id;
            setRole(roleToBind, `${name}/${modelToBind}`, { agentDir: root, validate: false });
            console.log(`[role] ✓ Role '${roleToBind}' bound to ${name}/${modelToBind}`);
          }
          break;
        }

        throw new Error(`Unknown provider subcommand: ${sub}. Allowed: add, list, remove.`);
      }

      case "role": {
        const sub = (options.target || "list").toLowerCase();
        if (sub === "list" || sub === "ls") {
          const roles = getRoles(root);
          console.log("Current Model Roles:");
          for (const r of VALID_ROLES) {
            console.log(`  ${r.padEnd(8)}: ${roles[r] || "(not set)"}`);
          }
          break;
        }

        if (sub === "set") {
          const roleName = options.positional[2];
          const modelRef = options.positional[3];
          if (!roleName || !modelRef) {
            throw new Error("Usage: omp-sync role set <default|smol|plan|slow|web> <provider/model>");
          }
          setRole(roleName, modelRef, { agentDir: root });
          console.log(`[role] ✓ Role '${roleName}' set to '${modelRef}'`);
          break;
        }

        // Shortcut: omp-sync role <roleName> <modelRef>
        if (VALID_ROLES.includes(sub)) {
          const modelRef = options.positional[2];
          if (!modelRef) {
            const roles = getRoles(root);
            console.log(`${sub}: ${roles[sub] || "(not set)"}`);
          } else {
            setRole(sub, modelRef, { agentDir: root });
            console.log(`[role] ✓ Role '${sub}' set to '${modelRef}'`);
          }
          break;
        }

        throw new Error(`Unknown role subcommand: ${sub}. Allowed: list, set.`);
      }

      default:
        console.error(`Unknown command: ${options.command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`[error] ${err.message || err}`);
    process.exit(1);
  }
}

main();
