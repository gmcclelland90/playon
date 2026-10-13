import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repo, rel), "utf8");
}

describe("native-survive-restart packaging (#1038)", () => {
  it("keeps Home and node units on KillMode=process and exposes a user runtime dir", () => {
    for (const rel of [
      "infra/control-plane/linux/playon.service",
      "infra/control-plane/linux/playon-node.service",
      "deploy/install.sh",
      "deploy/install-node.sh",
    ]) {
      const body = read(rel);
      expect(body).toMatch(/KillMode=process/);
      expect(body).toMatch(/XDG_RUNTIME_DIR=\/run\/user\/%U/);
    }
  });

  it("ships a needrestart override and install helpers that apply it", () => {
    const override = read("infra/control-plane/linux/needrestart-playon.conf");
    expect(override).toMatch(/\$nrconf\{override_rc\}\{qr\(\^playon\)\} = 0;/);
    expect(override).toMatch(/#1038/);

    const hygiene = read("deploy/lib/playon-host-hygiene.sh");
    expect(hygiene).toMatch(/playon_install_needrestart_override/);
    expect(hygiene).toMatch(/enable-linger/);

    expect(read("deploy/install.sh")).toMatch(/playon_apply_host_hygiene/);
    expect(read("deploy/install-node.sh")).toMatch(/needrestart/);
    expect(read("infra/blank-node/linux/bootstrap.sh")).toMatch(/needrestart/);
  });

  it("documents the playon-server scope unit name", () => {
    const unit = read("infra/control-plane/linux/playon-server@.service");
    expect(unit).toMatch(/playon-server-/);
    expect(unit).toMatch(/Never PartOf=playon\.service/);
    expect(unit).not.toMatch(/^PartOf=playon\.service$/m);
  });
});
