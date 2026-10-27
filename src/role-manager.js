/**
 * Role Assignment & Model Binding Manager
 *
 * Manages modelRoles mappings (default, smol, plan, slow, web) in ~/.omp/agent/config.yml
 * with validation against public and private provider stores.
 */

import fs from "node:fs";
import path from "node:path";
import { getAgentDir, listProviders } from "./provider-store.js";

export const VALID_ROLES = ["default", "smol", "plan", "slow", "web"];

/**
 * Read current modelRoles from config.yml.
 */
export function getRoles(agentDir = getAgentDir()) {
  const configFile = path.join(agentDir, "config.yml");
  if (!fs.existsSync(configFile)) {
    const alt = path.join(agentDir, "config.yaml");
    if (!fs.existsSync(alt)) return {};
    return parseRolesFromYaml(fs.readFileSync(alt, "utf8"));
  }
  return parseRolesFromYaml(fs.readFileSync(configFile, "utf8"));
}

function parseRolesFromYaml(yamlStr) {
  const lines = yamlStr.split("\n");
  const roles = {};
  let inRoles = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed === "modelRoles:") {
      inRoles = true;
      continue;
    }

    if (inRoles) {
      if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
        break; // Out of modelRoles section
      }
      const match = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (match) {
        roles[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
      }
    }
  }

  return roles;
}

/**
 * Surgically update a role in config.yml while preserving all other comments and structure.
 */
export function updateRoleInYaml(yamlStr, role, modelRef) {
  const lines = yamlStr.split("\n");
  let inRoles = false;
  let foundRole = false;
  const newLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "modelRoles:") {
      inRoles = true;
      newLines.push(line);
      continue;
    }

    if (inRoles) {
      if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
        if (!foundRole) {
          newLines.push(`  ${role}: ${modelRef}`);
          foundRole = true;
        }
        inRoles = false;
        newLines.push(line);
        continue;
      }

      const match = line.match(/^(\s*)([a-zA-Z0-9_-]+):(.*)$/);
      if (match) {
        const currentRole = match[2];
        if (currentRole === role) {
          newLines.push(`${match[1]}${role}: ${modelRef}`);
          foundRole = true;
          continue;
        }
      }
    }

    newLines.push(line);
  }

  if (inRoles && !foundRole) {
    newLines.push(`  ${role}: ${modelRef}`);
    foundRole = true;
  }

  if (!foundRole) {
    return `modelRoles:\n  ${role}: ${modelRef}\n` + yamlStr;
  }

  return newLines.join("\n");
}

/**
 * Set a model role in config.yml.
 */
export function setRole(roleName, modelRef, { agentDir = getAgentDir(), validate = true } = {}) {
  const role = (roleName || "").trim().toLowerCase();
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role '${roleName}'. Must be one of: ${VALID_ROLES.join(", ")}`);
  }

  const targetRef = (modelRef || "").trim();
  if (!targetRef) {
    throw new Error("Model reference cannot be empty (e.g. 'provider/model-id')");
  }

  if (validate && targetRef.includes("/")) {
    const [pName, mId] = targetRef.split("/");
    const providers = listProviders({ agentDir });
    const match = providers.find((p) => p.name === pName);
    if (!match) {
      throw new Error(`Provider '${pName}' is not configured in public or private stores.`);
    }
    const hasModel = match.models.some((m) => m.id === mId);
    if (!hasModel && match.models.length > 0) {
      throw new Error(
        `Model '${mId}' not found under provider '${pName}'. Available: ${match.models.map((m) => m.id).join(", ")}`
      );
    }
  }

  const configFile = path.join(agentDir, "config.yml");
  let existingContent = "";
  if (fs.existsSync(configFile)) {
    existingContent = fs.readFileSync(configFile, "utf8");
  }

  const updatedContent = updateRoleInYaml(existingContent, role, targetRef);
  fs.writeFileSync(configFile, updatedContent, "utf8");

  return { role, modelRef: targetRef, updated: true };
}
