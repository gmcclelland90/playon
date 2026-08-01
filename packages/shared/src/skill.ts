import { z } from "zod";

export const ContainerSupportSchema = z.enum(["full", "partial", "none"]);
export type ContainerSupport = z.infer<typeof ContainerSupportSchema>;

export const HealthCheckSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["process_running", "tcp_port"]),
  /** For tcp_port: uses skill port name or explicit port. */
  portName: z.string().optional(),
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  /** Known failure → remediation action the monitor may auto-run. */
  onFail: z.enum(["none", "restart", "escalate"]).default("escalate"),
});

export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const SkillThemeIdSchema = z.enum(["default", "grass", "ember", "steel", "paper"]);
export type SkillThemeId = z.infer<typeof SkillThemeIdSchema>;

export const SkillThemeSchema = z.object({
  id: SkillThemeIdSchema.default("default"),
  /** Optional OKLCH hue for --primary on the player panel (0–360). */
  primaryHue: z.number().min(0).max(360).optional(),
});
export type SkillTheme = z.infer<typeof SkillThemeSchema>;

export const SkillMetadataSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  game: z.string().min(1).optional(),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  theme: SkillThemeSchema.optional(),
  os: z.array(z.enum(["linux", "windows"])).default(["linux", "windows"]),
  arch: z.array(z.string()).default(["amd64"]),
  containerSupport: ContainerSupportSchema.default("none"),
  requiredTools: z.array(z.string()).default([]),
  ports: z
    .array(
      z.object({
        name: z.string(),
        protocol: z.enum(["tcp", "udp"]).default("tcp"),
        default: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  dependencies: z.array(z.string()).default([]),
  healthChecks: z.array(HealthCheckSchema).default([]),
});

export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;
