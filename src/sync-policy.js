import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pointerToTokens, validatePortablePath } from "./sync-files.js";

export const POLICY_FILE = "sync-policy.local.json";
export const VALID_SCOPES = new Set(["public", "private"]);
export const VALID_RESOURCE_PREFIXES = new Set([
  "provider",
  "mcp",
  "setting",
  "plugin",
  "asset",
]);

export function isExactSemver(version) {
  return typeof version === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(version);
}

export function resolveSyncNamespace(policy, state) {
  const policyNamespace = policy?.namespace;
  const stateNamespace = state?.namespace;
  if (policyNamespace && stateNamespace && policyNamespace !== stateNamespace) {
    throw new Error("Sync policy and sync state namespaces differ; refusing to mix configuration sets");
  }
  return policyNamespace || stateNamespace || null;
}

/**
 * Validates a resource ID format.
 * provider:<name>
 * mcp:<name>
 * setting:<JSON-pointer>
 * plugin:<npm-name>
 * asset:<archive-relative-root>
 */
export function validateResourceId(id) {
  if (typeof id !== "string" || !id.includes(":")) {
    throw new Error(
      `Invalid resource ID '${id}': must be in format <type>:<name> (provider, mcp, setting, plugin, asset)`
    );
  }
  const colonIdx = id.indexOf(":");
  const prefix = id.slice(0, colonIdx);
  const name = id.slice(colonIdx + 1);

  if (!VALID_RESOURCE_PREFIXES.has(prefix)) {
    throw new Error(
      `Invalid resource ID prefix '${prefix}': must be one of ${Array.from(
        VALID_RESOURCE_PREFIXES
      ).join(", ")}`
    );
  }
  if (!name) {
    throw new Error(`Invalid resource ID '${id}': name cannot be empty`);
  }

  if (prefix === "provider" || prefix === "mcp") {
    if (/[\/\\\s\x00-\x1f\x7f]/.test(name)) {
      throw new Error(
        `Invalid ${prefix} resource ID '${id}': name cannot contain slashes, whitespace, or control characters`
      );
    }
  } else if (prefix === "plugin") {
    const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
    if (name.length > 214 || !npmName.test(name)) {
      throw new Error(
        `Invalid plugin resource ID '${id}': name must be a valid unscoped or @scope/name package`
      );
    }
  } else if (prefix === "setting") {
    if (!name.startsWith("/")) {
      throw new Error(
        `Invalid setting resource ID '${id}': JSON pointer must start with '/'`
      );
    }
    if (name.length > 1 && name.endsWith("/")) {
      throw new Error(
        `Invalid setting resource ID '${id}': JSON pointer cannot end with trailing slash`
      );
    }
    const tokens = pointerToTokens(name);
    if (tokens.some((token) => /^(?:0|[1-9]\d*)$/.test(token))) {
      throw new Error(`Invalid setting resource ID '${id}': arrays are leaf values; array elements cannot be settings`);
    }
  } else if (prefix === "asset") {
    validateAssetPath(name);
  }

  return { prefix, name };
}

/**
 * Validates asset path conventions.
 * Must start with skills/, managed-skills/, extensions/, tools/, hooks/, or be AGENTS.md, STYLE.md, RULES.md.
 * No backslashes, empty segments, dot segments, or traversal.
 */
export function validateAssetPath(relPath) {
  const parts = validatePortablePath(relPath);
  const allowedFiles = new Set(["AGENTS.md", "STYLE.md", "RULES.md"]);
  const directoryAsset = /^(?:skills|managed-skills|extensions|tools|hooks)\/[^/]+$/;
  if (!directoryAsset.test(relPath) && !allowedFiles.has(relPath)) {
    throw new Error(
      `Invalid asset root for '${relPath}': expected one named entry under skills/, managed-skills/, extensions/, tools/, hooks/, or a supported top-level document`
    );
  }
  return parts;
}

/**
 * Checks that setting JSON pointers do not overlap (ancestor/descendant).
 * IDs should be array of setting:<pointer>.
 */
export function checkSettingOverlap(settingIds) {
  const pointers = settingIds.map((id) => {
    const { name } = validateResourceId(id);
    return { id, tokens: pointerToTokens(name) };
  });
  const isAncestor = (a, b) => a.length < b.length && a.every((token, i) => token === b[i]);

  for (let i = 0; i < pointers.length; i++) {
    for (let j = i + 1; j < pointers.length; j++) {
      const a = pointers[i];
      const b = pointers[j];
      if (a.tokens.length === b.tokens.length && a.tokens.every((token, k) => token === b.tokens[k])) {
        throw new Error(`Duplicate setting ID: '${a.id}'`);
      }
      if (isAncestor(a.tokens, b.tokens) || isAncestor(b.tokens, a.tokens)) {
        throw new Error(`Setting pointers overlap: '${a.id}' and '${b.id}'`);
      }
    }
  }
}

/**
 * Reads and strictly validates sync-policy.local.json from root.
 * Returns { version: 1, namespace?: string, resources: Record<string, "public" | "private"> }
 */
export function readSyncPolicy(root) {
  const filePath = path.join(root, POLICY_FILE);
  if (!fs.existsSync(filePath)) {
    return { version: 1, resources: {} };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${POLICY_FILE}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${POLICY_FILE}: ${err.message}. Manual correction required; will not auto-overwrite.`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid ${POLICY_FILE}: root must be a JSON object. Manual correction required.`
    );
  }

  if (parsed.version !== 1) {
    throw new Error(
      `Invalid ${POLICY_FILE}: unsupported version ${parsed.version}; expected 1.`
    );
  }

  if (
    parsed.namespace !== undefined &&
    (typeof parsed.namespace !== "string" || !parsed.namespace.trim())
  ) {
    throw new Error(
      `Invalid ${POLICY_FILE}: namespace must be a non-empty string if provided.`
    );
  }

  if (
    !parsed.resources ||
    typeof parsed.resources !== "object" ||
    Array.isArray(parsed.resources)
  ) {
    throw new Error(
      `Invalid ${POLICY_FILE}: 'resources' field must be an object.`
    );
  }

  const settingIds = [];
  for (const [id, scope] of Object.entries(parsed.resources)) {
    validateResourceId(id);
    if (!VALID_SCOPES.has(scope)) {
      throw new Error(
        `Invalid scope '${scope}' for resource '${id}' in ${POLICY_FILE}; must be 'public' or 'private'.`
      );
    }
    if (id.startsWith("setting:")) {
      settingIds.push(id);
    }
  }

  checkSettingOverlap(settingIds);

  return {
    version: 1,
    namespace: parsed.namespace ? parsed.namespace.trim() : undefined,
    resources: { ...parsed.resources },
  };
}

/**
 * Writes sync-policy.local.json atomically using temp file + rename.
 */
export function writeSyncPolicyAtomic(root, policy) {
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  const target = path.join(root, POLICY_FILE);
  const tmp = path.join(root, `.${POLICY_FILE}.tmp-${randomUUID()}`);
  const data = JSON.stringify(policy, null, 2) + "\n";
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, target);
}

/**
 * Sets scope ("public" | "private") for a resource in sync-policy.local.json.
 * Validates that resource exists in inventory.
 * If setting to public and provider has private: true in models.yml or exists in models.local.json,
 * throws error preventing accidental override.
 */
export async function setResourceScope(root, id, scope, options = {}) {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(
      `Invalid scope '${scope}': must be 'public' or 'private'`
    );
  }
  validateResourceId(id);

  // Lazy import inventoryResources to avoid circular dependency
  const { inventoryResources } = await import("./sync-resources.js");
  const inventory = inventoryResources(root);
  const item = inventory.find((r) => r.id === id);
  if (!item) {
    throw new Error(
      `Resource '${id}' not found in current configuration inventory. Cannot set scope.`
    );
  }

  if (scope === "public" && id.startsWith("provider:")) {
    if (item.isPrivate) {
      throw new Error(
        `Provider '${item.name}' is marked private in models.yml or models.local.json. ` +
          `Use existing provider management command to change it to public before setting sync scope.`
      );
    }
  }

  const { withSyncLock } = await import("./sync-files.js");
  const { readSyncState } = await import("./sync-plan.js");
  return withSyncLock(root, () => {
    const policy = readSyncPolicy(root);
    const lockedNamespace = resolveSyncNamespace(policy, readSyncState(root));

    if (id.startsWith("setting:")) {
      const existingSettings = Object.keys(policy.resources).filter(
        (k) => k.startsWith("setting:") && k !== id
      );
      existingSettings.push(id);
      checkSettingOverlap(existingSettings);
    }

    let warning = null;
    if (scope === "public") {
      if (!policy.namespace) policy.namespace = lockedNamespace || randomUUID();
      warning =
        `Notice: Resource '${id}' credentials and configuration will be encrypted into the public sync bundle.`;
    }

    policy.resources[id] = scope;
    writeSyncPolicyAtomic(root, policy);

    return {
      id,
      scope,
      namespace: policy.namespace,
      warning,
    };
  });
}

/**
 * Resolves the effective scope of a resource given policy, baseline state, and inventory item.
 * Explicit private > provider private flag > explicit public > managed baseline > unclassified private.
 */
export function resolveResourceScope(id, policy, state, inventoryItem) {
  // 1. Explicit private policy takes absolute precedence
  if (policy?.resources?.[id] === "private") {
    return { scope: "private", reason: "explicit-private-policy" };
  }

  // 2. Provider with private flag or local storage is forced private
  if (id.startsWith("provider:") && inventoryItem?.isPrivate) {
    return { scope: "private", reason: "provider-private-flag" };
  }

  // 3. Explicit public policy
  if (policy?.resources?.[id] === "public") {
    return { scope: "public", reason: "explicit-public-policy" };
  }

  // 4. Managed by local baseline state (already synchronized previously)
  const baseline = state?.resources?.[id];
  if (baseline && baseline.hash && baseline.hash !== "__OMP_SENTINEL_DELETED__") {
    return { scope: "public", reason: "managed-by-baseline" };
  }

  // 5. Default local unclassified (retained locally, not exported; on import: adopt if absent or identical, conflict if different)
  return { scope: "unclassified", reason: "unclassified-default-local" };
}
