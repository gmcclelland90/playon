import fs from "node:fs";
import path from "node:path";
import { annotateCatalogInstalled, installSkillFromCatalog } from "../catalog-install.js";
import {
  fetchSkillsCatalog,
  resolveSkillsCatalogUrl,
  searchCatalog,
} from "../skills-catalog.js";
import { listSkills } from "../skills.js";
import {
  getSetting,
  SKILLS_CATALOG_KEY,
  type SkillsCatalogSettings,
} from "../settings.js";
import { globalTool, serverTool, type ToolModule } from "./types.js";

/** Skill library: local install set, drafts, packaging, and the public catalog. */
export const skillsToolModule: ToolModule = ({ plane, skillRoots }) => {
  const { config, db, drafts, skillPackages } = plane;

  async function catalogUrl(): Promise<string> {
    const stored = await getSetting<SkillsCatalogSettings>(db, SKILLS_CATALOG_KEY);
    return resolveSkillsCatalogUrl(process.env.PLAYON_SKILLS_CATALOG_URL, stored?.catalogUrl);
  }

  return [
    globalTool({
      def: {
        name: "skill_list",
        description:
          "List installable skills (includes containerSupport: full|partial|none). Prefer containerSupport=full on Docker hosts.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      surface: { skill: "installer", activityVerb: "skill" },
      handler: async () =>
        listSkills(skillRoots).map((s) => ({
          name: s.metadata.name,
          version: s.metadata.version,
          game: s.metadata.game,
          description: s.metadata.description,
          tags: s.metadata.tags,
          containerSupport: s.metadata.containerSupport,
          dockerImage: s.metadata.dockerImage,
          steamAppId: s.metadata.steamAppId,
          adminDialect: s.metadata.adminDialect,
          queryDialect: s.metadata.queryDialect,
          dependencies: s.metadata.dependencies,
          minRamMb: s.metadata.minRamMb,
          scope: s.path.includes(`${path.sep}servers${path.sep}`) ? "server" : "global",
        })),
    }),

    globalTool({
      def: {
        name: "skill_read",
        description:
          "Read guides/*.md from an installed skill (default INSTALL.md; use MODDING.md for Workshop/mod runbooks). Prefer this before drafting a new skill.",
        parameters: {
          type: "object",
          properties: {
            skillName: { type: "string" },
            guide: {
              type: "string",
              description: "Guide basename without path, e.g. INSTALL.md (default INSTALL.md)",
            },
          },
          required: ["skillName"],
        },
      },
      surface: { skill: "installer", activityVerb: "skill" },
      handler: async (args) => {
        const skillName = String(args.skillName);
        const entry = listSkills(skillRoots).find((s) => s.metadata.name === skillName);
        if (!entry) return { error: `unknown_skill: ${skillName}` };
        const guideName = args.guide ? String(args.guide) : "INSTALL.md";
        const safe = path.basename(guideName);
        const guidePath = path.join(entry.path, "guides", safe);
        if (!fs.existsSync(guidePath)) {
          const guidesDir = path.join(entry.path, "guides");
          const available = fs.existsSync(guidesDir)
            ? fs.readdirSync(guidesDir).filter((f) => f.endsWith(".md"))
            : [];
          return { error: `guide_not_found: ${safe}`, skillName, availableGuides: available };
        }
        return {
          skillName,
          guide: safe,
          path: guidePath,
          content: fs.readFileSync(guidePath, "utf8"),
          metadata: {
            version: entry.metadata.version,
            dependencies: entry.metadata.dependencies,
            dockerImage: entry.metadata.dockerImage,
            steamAppId: entry.metadata.steamAppId,
            adminDialect: entry.metadata.adminDialect,
            containerSupport: entry.metadata.containerSupport,
          },
        };
      },
    }),

    globalTool({
      def: {
        name: "skill_draft_save",
        description:
          "Save a draft skill for later promotion. Optional queryConnectorSource writes query/connector.mjs and sets queryDialect=skill_module.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            game: { type: "string" },
            description: { type: "string" },
            installGuide: { type: "string" },
            containerSupport: { type: "string", enum: ["full", "partial", "none"] },
            warnings: { type: "string" },
            queryConnectorSource: { type: "string" },
            queryGuide: { type: "string" },
          },
          required: ["name", "game", "description", "installGuide"],
        },
      },
      surface: { skill: "installer", activityVerb: "skill" },
      handler: async (args) =>
        drafts.save({
          name: String(args.name),
          game: String(args.game),
          description: String(args.description),
          installGuide: String(args.installGuide),
          containerSupport: args.containerSupport as "full" | "partial" | "none" | undefined,
          warnings: args.warnings ? String(args.warnings) : undefined,
          queryConnectorSource: args.queryConnectorSource
            ? String(args.queryConnectorSource)
            : undefined,
          queryGuide: args.queryGuide ? String(args.queryGuide) : undefined,
        }),
    }),

    globalTool({
      def: {
        name: "skill_draft_list",
        description: "List draft skills",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      surface: { skill: "installer", activityVerb: "skill" },
      handler: async () => drafts.list(),
    }),

    globalTool({
      def: {
        name: "skill_draft_set_query_connector",
        description:
          "Write query/connector.mjs on an existing draft and set queryDialect=skill_module. Then use servers_query_test.",
        parameters: {
          type: "object",
          properties: {
            slug: { type: "string" },
            queryConnectorSource: { type: "string" },
            queryGuide: { type: "string" },
          },
          required: ["slug", "queryConnectorSource"],
        },
      },
      surface: { skill: "installer", activityVerb: "skill" },
      handler: async (args) =>
        drafts.setQueryConnector(
          String(args.slug),
          String(args.queryConnectorSource),
          args.queryGuide ? String(args.queryGuide) : undefined,
        ),
    }),

    globalTool({
      def: {
        name: "skill_promote",
        description: "Promote a draft skill to an installable skill",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
          required: ["slug"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "promote a draft skill so it can be installed",
        activityVerb: "skill",
        xp: { xp: 25, reason: "skill_promote" },
      },
      handler: async (args) => drafts.promote(String(args.slug)),
    }),

    serverTool({
      def: {
        name: "skill_promote_server",
        description: "Promote a per-server skill folder to the global skills library",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            skillSlug: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["serverId", "skillSlug"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "add a server skill to the shared library",
        activityVerb: "skill",
      },
      handler: async (args, { serverId }) =>
        skillPackages.promoteServerSkill(serverId, String(args.skillSlug), {
          overwrite: Boolean(args.overwrite),
        }),
    }),

    globalTool({
      def: {
        name: "skill_export",
        description: "Export an installable skill as a zip under data/exports/",
        parameters: {
          type: "object",
          properties: { skillName: { type: "string" } },
          required: ["skillName"],
        },
      },
      surface: { skill: "installer", activityVerb: "skill" },
      handler: async (args) => {
        const exported = skillPackages.exportZip(String(args.skillName));
        const exportsDir = path.join(config.dataRoot, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });
        const outPath = path.join(exportsDir, exported.filename);
        fs.writeFileSync(outPath, exported.bytes);
        return {
          skillName: exported.metadataName,
          filename: exported.filename,
          path: outPath,
          bytes: exported.bytes.byteLength,
        };
      },
    }),

    globalTool({
      def: {
        name: "skill_import",
        description: "Import a skill zip from a path under the host data root",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            zipPath: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["zipPath"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "import a skill package",
        activityVerb: "skill",
      },
      handler: async (args) => {
        const zipPath = path.resolve(String(args.zipPath));
        const root = path.resolve(config.dataRoot);
        if (zipPath !== root && !zipPath.startsWith(root + path.sep)) {
          throw new Error("zip_path_outside_data_root");
        }
        const bytes = new Uint8Array(fs.readFileSync(zipPath));
        return skillPackages.importZip(bytes, { overwrite: Boolean(args.overwrite) });
      },
    }),

    globalTool({
      def: {
        name: "skill_search",
        description:
          "Search the public PlayOn skill catalog (playon.games) for official .skill.zip packages. Use when skill_list has no local match for the requested game.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Game or skill name / tags (e.g. minecraft, rust). Empty returns the full catalog.",
            },
          },
        },
      },
      surface: { skill: "installer", activityVerb: "skill" },
      handler: async (args) => {
        const url = await catalogUrl();
        const q = args.query !== undefined ? String(args.query) : "";
        try {
          const skills = annotateCatalogInstalled(
            searchCatalog(await fetchSkillsCatalog(url), q),
            config.skillsRoots,
          );
          return {
            catalogUrl: url,
            skills: skills.map((s) => ({
              name: s.name,
              version: s.version,
              game: s.game,
              description: s.description,
              tags: s.tags,
              dependencies: s.dependencies,
              containerSupport: s.containerSupport,
              minRamMb: s.minRamMb,
              downloadUrl: s.downloadUrl,
              sha256: s.sha256,
              official: s.official,
              installed: s.installed,
            })),
          };
        } catch (err) {
          return {
            catalogUrl: url,
            skills: [],
            error: err instanceof Error ? err.message : "catalog_unavailable",
          };
        }
      },
    }),

    globalTool({
      def: {
        name: "skill_install_url",
        description:
          "Download and install a skill from the public catalog. Prefer name from skill_search; downloadUrl must match a catalog entry. Verifies sha256 when the catalog provides one.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Catalog skill name, e.g. games.minecraft-paper" },
            downloadUrl: { type: "string", description: "Exact downloadUrl from skill_search" },
            overwrite: { type: "boolean" },
          },
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "install a skill from the public catalog",
        activityVerb: "skill",
        xp: { xp: 15, reason: "skill_catalog_install" },
      },
      handler: async (args) => {
        const name = args.name !== undefined ? String(args.name).trim() : "";
        const downloadUrl = args.downloadUrl !== undefined ? String(args.downloadUrl).trim() : "";
        return installSkillFromCatalog({
          config,
          skillPackages,
          catalogUrl: await catalogUrl(),
          name: name || undefined,
          downloadUrl: downloadUrl || undefined,
          overwrite: Boolean(args.overwrite),
        });
      },
    }),
  ];
};
