import path from "node:path";

export class PathJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathJailError";
  }
}

/** Resolve a user-supplied path and ensure it stays under `root`. */
export function resolveInJail(root: string, userPath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, userPath);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathJailError(`path escapes jail: ${userPath}`);
  }
  return target;
}

export function assertReadableSkillsPath(skillsRoot: string, userPath: string): string {
  return resolveInJail(skillsRoot, userPath);
}
