import path from "node:path";

export function resolveAidrawDir(jiuguanDir, envOverride) {
  if (envOverride && envOverride.trim()) return envOverride.trim();
  return path.join(jiuguanDir, "..", "quick AIdraw");
}
