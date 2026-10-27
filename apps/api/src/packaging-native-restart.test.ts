import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repo, rel), "utf8");
}

describe("native-survive-restart packaging (#1038 / #1045)", () => {
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
    expect(override).toMatch(/#1045/);

    const hygiene = read("deploy/lib/playon-host-hygiene.sh");
    expect(hygiene).toMatch(/playon_install_needrestart_override/);
    expect(hygiene).toMatch(/playon_install_user_slice/);
    expect(hygiene).toMatch(/enable-linger/);

    expect(read("deploy/install.sh")).toMatch(/playon_apply_host_hygiene/);
    expect(read("deploy/install-node.sh")).toMatch(/needrestart/);
    expect(read("infra/blank-node/linux/bootstrap.sh")).toMatch(/needrestart/);
  });

  it("documents the playon-server unit and a user slice outside playon.service", () => {
    const unit = read("infra/control-plane/linux/playon-server@.service");
    expect(unit).toMatch(/playon-server-/);
    expect(unit).toMatch(/systemd-run --user/);
    expect(unit).toMatch(/KillMode=control-group/);
    expect(unit).toMatch(/playon_native_unit_stop/);
    expect(unit).toMatch(/Never PartOf=playon\.service/);
    expect(unit).not.toMatch(/^PartOf=playon\.service$/m);

    const slice = read("infra/control-plane/linux/playon.slice");
    expect(slice).toMatch(/\[Slice\]/);
    expect(slice).toMatch(/Never PartOf=playon\.service/);
    expect(slice).not.toMatch(/^PartOf=playon\.service$/m);

    for (const rel of [
      "infra/control-plane/linux/playon.service",
      "infra/control-plane/linux/playon-node.service",
      "deploy/install.sh",
      "deploy/install-node.sh",
    ]) {
      expect(read(rel)).toMatch(/logger -t playon -- playon_unit_stop/);
    }
  });
});
