import fs from "node:fs";
import path from "node:path";
import { PathJailError, resolveInJail } from "@playon/runtime";
import type { AppConfig } from "../config.js";
import {
  classifySkillSource,
  loadSkillMetadata,
  type SkillEntry,
  type SkillSource,
} from "./skills.js";

const DEFAULT_READ_MAX_BYTES = 512_000;

const WRITABLE_SOURCES = new Set<SkillSource>(["installed", "draft", "server"]);

export type SkillFsEntry = { name: string; type: "file" | "dir" };

export class SkillFsService {
  constructor(private readonly config: AppConfig) {}

  private resolveEntry(skillName: string): SkillEntry {
    const entry = loadSkillMetadata(this.config.skillsRoots, skillName);
    if (!entry) throw new Error(`unknown_skill: ${skillName}`);
    return entry;
  }

  source(skillName: string): SkillSource {
    const entry = this.resolveEntry(skillName);
    return classifySkillSource(entry, this.config.dataRoot);
  }

  isWritable(skillName: string): boolean {
    return WRITABLE_SOURCES.has(this.source(skillName));
  }

  list(skillName: string, relPath = "."): SkillFsEntry[] {
    const entry = this.resolveEntry(skillName);
    const target = resolveInJail(entry.path, relPath);
    if (!fs.existsSync(target)) throw new Error(`not_found: ${relPath}`);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) throw new Error(`not_a_directory: ${relPath}`);

    return fs.readdirSync(target).map((name) => {
      const child = path.join(target, name);
      return {
        name,
        type: fs.statSync(child).isDirectory() ? ("dir" as const) : ("file" as const),
      };
    });
  }

  read(
    skillName: string,
    relPath: string,
    opts?: { offset?: number; maxBytes?: number },
  ): {
    path: string;
    content: string;
    bytesRead: number;
    truncated: boolean;
    size: number;
    writable: boolean;
    source: SkillSource;
  } {
    const entry = this.resolveEntry(skillName);
    const source = classifySkillSource(entry, this.config.dataRoot);
    const writable = WRITABLE_SOURCES.has(source);
    const target = resolveInJail(entry.path, relPath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`not_found: ${relPath}`);
    }
    const size = fs.statSync(target).size;
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const maxBytes = Math.min(
      DEFAULT_READ_MAX_BYTES,
      Math.max(1, Math.floor(opts?.maxBytes ?? DEFAULT_READ_MAX_BYTES)),
    );
    if (offset > size) {
      return {
        path: relPath,
        content: "",
        bytesRead: 0,
        truncated: false,
        size,
        writable,
        source,
      };
    }
    const fd = fs.openSync(target, "r");
    try {
      const length = Math.min(maxBytes, size - offset);
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      const content = buf.subarray(0, bytesRead).toString("utf8");
      const truncated = offset + bytesRead < size;
      return {
        path: relPath,
        content,
        bytesRead,
        truncated,
        size,
        writable,
        source,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  write(skillName: string, relPath: string, content: string): { path: string; bytes: number } {
    const entry = this.resolveEntry(skillName);
    const source = classifySkillSource(entry, this.config.dataRoot);
    if (!WRITABLE_SOURCES.has(source)) {
      throw new Error(`writable_skill_required: ${source}`);
    }
    const target = resolveInJail(entry.path, relPath);
    // Disallow writing outside an existing file's parent unless parent exists under jail.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return { path: relPath, bytes: Buffer.byteLength(content, "utf8") };
  }
}

export function skillFsHttpStatus(err: unknown): 400 | 403 | 404 {
  if (err instanceof PathJailError) return 400;
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("unknown_skill")) return 404;
  if (message.startsWith("not_found")) return 404;
  if (message.startsWith("not_a_directory")) return 400;
  if (message.startsWith("writable_skill_required")) return 403;
  if (message.includes("path escapes jail")) return 400;
  return 400;
}
