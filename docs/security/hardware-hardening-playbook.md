# Recall Meridian — Host Hardware Hardening Playbook

**Last reviewed:** 2026-05-13
**Scope:** mitigations the operator can apply to the *host machine* running Recall. Closes the §14 "physical / supply-chain / hardware root-of-trust" gap from the 2026-05-12 brainstorm — a gap the in-tree security modules cannot address by themselves.

This is documentation, not code. The other 14 modules in `lib/security/` defend the *software substrate*. This document covers what the operator must do *outside* the codebase to keep that substrate trustworthy.

## Threat model addressed

| Threat | What gets compromised | This doc |
|---|---|---|
| `npm install` supply chain | Any agent running on host | §1 |
| Cold-boot / DMA / evil-maid | KB at rest, anchor key | §2 |
| Firmware / OS-level rootkit | Everything | §3 |
| Physical theft | KB + secrets | §4 |
| Network-level MITM | API calls, mirror push | §5 |
| Backup integrity | Recovery from corruption | §6 |

## §1 — npm install supply chain (highest leverage)

The OpenClaw spec literally tells you to `npm install -g openclaw@latest`. Every transitive dependency executes with the user's privileges. **This is the single most exploitable surface in the stack.**

**Mandatory:**
- Run `recall security sbom` after every `npm install` and commit the SBOM hash to git. Drift between commits is the alarm.
- Run `recall security dep-audit` before any `npm install -g`. Refuse to install if any dependency fires a `non-registry-source` finding.
- Run `recall security lockfile-verify` in CI. Block deploys on drift.
- Pin all global tools to exact versions (no `^` or `~`) in a separate ops manifest you audit.
- **NEVER use `npm install -g <package>@latest` in production.** Always pin a specific version.

**Strongly recommended:**
- Use a separate npm account for production publishes (the `npm publish` account); keep it on a dedicated YubiKey-protected device.
- Configure `npm` with `audit-level=high` and `fund=false` globally.
- Use a private npm proxy (Verdaccio, Sonatype) that only mirrors registry packages you've explicitly allowed. Block ad-hoc registries entirely.
- Sign your own published packages with sigstore / npm provenance.

**Concrete commands to run now:**
```bash
node bin/meridian.js security sbom --root . --json > sbom-baseline.json
git add sbom-baseline.json
git commit -m "ops: pin SBOM baseline"
node bin/meridian.js security dep-audit --root .
node bin/meridian.js security lockfile-verify --root .
```

## §2 — Cold-boot, DMA, evil-maid (host-level secrets)

Recall's signing keys (`~/.recall/security/anchor-key`, future canary keys, future signing keys) live in plain files on disk by default. An attacker with physical access — or DMA via a compromised peripheral — can read them.

**Mandatory:**
- **Full-disk encryption with a strong passphrase, not just login password.** macOS: FileVault. Linux: LUKS. Windows: BitLocker with TPM + PIN, NOT TPM-alone.
- Disable sleep-to-RAM for any host running Recall in production. Use sleep-to-disk (hibernate) with the encryption key NOT cached in firmware.
- Disable Thunderbolt unless you need it; if you need it, restrict DMA to authorized devices only (macOS: System Settings → Privacy → Allow Accessory Connection).
- **NEVER leave a Recall host unlocked when unattended.** Set screen lock to ≤1 minute idle.

**Strongly recommended:**
- Move the anchor key to a hardware token (YubiKey, Trezor, Secure Enclave on macOS). The current `lib/security/graph-anchor.js` reads from a plain file; a future iteration should pluggable-key to support HSM/Secure Enclave. Track this as an explicit roadmap item — not yet built.
- Use a Mac with Apple Silicon (Secure Enclave + Boot ROM verification) over Intel-era hardware.
- Disable USB autorun and require explicit approval for any USB device mount.

## §3 — Firmware and OS rootkits

The OS itself can be compromised below the level any in-tree code can detect.

**Mandatory:**
- Keep firmware patched. macOS: System Settings → General → Software Update. Linux: vendor BIOS update tool. Re-check monthly.
- Verify Secure Boot is enabled (UEFI). On macOS, verify Startup Security in Recovery Mode is set to "Full Security."
- Run a recent OS — security patches age off rapidly.

**Strongly recommended:**
- For dedicated production hosts (e.g. the planned Mac mini), use macOS in Lockdown Mode if the host doesn't need general computing.
- Subscribe to vendor security mailing lists; rotate hardware before vendor end-of-support dates.
- Periodically run an out-of-band attestation (e.g. boot from external read-only media, run filesystem diff against a known-good snapshot from §6 below).

## §4 — Physical theft

Encrypted disk is necessary but not sufficient — the recovery story matters too.

**Mandatory:**
- Find My Mac / equivalent enabled with remote wipe.
- A secondary off-site encrypted backup (see §6) so a stolen / bricked host doesn't lose history.
- Physical access logs: who has been in the room with the host? For a home setup this is "yourself"; for an office, badge logs.

**Strongly recommended:**
- A Kensington lock / equivalent on stationary production hosts.
- A camera covering the host's physical location.

## §5 — Network MITM

Recall's outbound traffic (npm publish, git push, mirror sync, future API calls) all cross the network.

**Mandatory:**
- Verify TLS certificate pinning where the toolchain supports it. `npm` does this by default; verify your `~/.npmrc` doesn't have `strict-ssl=false`.
- Use SSH keys (not passwords) for git pushes. Verify the gitlab/github host key fingerprints match the published values.
- Refuse to operate on networks you don't control without a trusted VPN.

**Strongly recommended:**
- Outbound firewall rule: explicitly allowlist registries + git hosts; block everything else. Limits what a compromised dependency can phone home to.
- DNS-over-HTTPS / DNS-over-TLS to a trusted resolver (1.1.1.1, 9.9.9.9, your own).
- Tailscale / WireGuard for any cross-machine Recall traffic (e.g. desktop ↔ Mac mini).

## §6 — Backup and recovery integrity

The graph-anchor module gives you tamper-evidence for the KB *as it currently stands*. Backups are how you recover from successful tampering.

**Mandatory:**
- At least 2 independent backups: one local (Time Machine / equivalent), one off-site (encrypted external drive in another building, or encrypted cloud backup).
- Test restore at least quarterly. **A backup you've never restored is not a backup.**
- After every successful restore, run `recall security anchor-verify` immediately. If the anchor doesn't match a known-good prior anchor, you've restored from a compromised state.

**Strongly recommended:**
- Keep an immutable log of anchor hashes + timestamps off-host (paste into a personal email to yourself, post to a private GitHub gist, write to a notarized timestamp service). Lets you prove "the graph as of date X had hash Y" even if both your live host and your backups are simultaneously compromised.
- Periodically replay the anchor ledger from sequence 1 to confirm the chain has been valid all along, not just at the head.

## What this document does NOT cover

- **Multi-region, multi-operator, organization-scale ops.** This playbook assumes a single-operator setup. Team / org versions need RBAC, key rotation policy, separation of duties, etc. Out of scope until Recall has more than one operator in production.
- **Advanced threat actors with zero-days against macOS / Linux kernels.** No host-level guidance survives a nation-state-level attacker; the only mitigation at that level is to assume compromise and design for blast-radius minimization. The in-tree modules (anchors + scan ledgers + audit-ingest + collusion detection) are the blast-radius minimization.
- **Compliance frameworks (SOC2, ISO 27001, etc.)** — the practices here align with those frameworks but are not certified. If a compliance regime applies, treat this as a starting point, not a substitute.

## Maintenance

Re-review this document:
- After any major OS upgrade
- After any host change (new Mac mini, new external drive, new network)
- After any reported supply-chain incident (xz-utils-style) in the npm / Node ecosystem
- At least every 6 months by calendar

Track each review as an entry in the architect-review queue:
```bash
node bin/meridian.js security arch-review-queue \
    --title "Hardware hardening playbook 6-month review" \
    --surfaces "ops,physical-security" \
    --risk medium \
    --sla-days 30
```
Sign with your real name when complete (the queue refuses LLM-shaped names per the §14 correlated-failure mitigation).
