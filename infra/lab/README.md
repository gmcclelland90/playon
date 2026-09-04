# Lab cadence (playon-dev)

Standing loop on the 24/7 Linux lab (timer already enabled on the current playon-dev host):

1. `git pull` + `pnpm loop:verify`
2. On green: `pnpm lab:matrix --continue-on-fail`
3. File/update GitHub Issues from failures (`source:lab` → PlayOn Ops → triage)

Live tick history: [#52 Lab now](https://github.com/gmcclelland90/playon/issues/52).

## Install / reinstall (once per host, or after rebuild)

```bash
cd /home/playon/src/playon-git
git pull --ff-only
sudo cp infra/lab/playon-lab-cadence.service infra/lab/playon-lab-cadence.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now playon-lab-cadence.timer
systemctl list-timers playon-lab-cadence.timer
```

`gh` must be authenticated as a user/token that can open issues on `gmcclelland90/playon` (lab host: `gh auth login` or `GH_TOKEN` in `/etc/playon/playon.env`).

Manual tick:

```bash
sudo systemctl start playon-lab-cadence.service
journalctl -u playon-lab-cadence.service -n 100 --no-pager
```

Disable filing without stopping the bar: `PLAYON_LAB_FILE_ISSUES=0` in the env file.

Live visibility: [#52 Lab now](https://github.com/gmcclelland90/playon/issues/52) (short card) + cadence history comments / Actions `lab-report` HTML artifacts for detail.

## Windows PE / dual-place expectation

Daily cadence and weekend catalog sweeps assume **`playon-win-1` is online** with `join_host` set. If that node is down (or `PLAYON_MATRIX_WIN_NODE_ID=off`), matrix will skip Windows PE / depot skills and file a `coverage:windows-pe` alert when skip count ≥ `PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD` (default 1). See [docs/lab-matrix.md](../../docs/lab-matrix.md).
