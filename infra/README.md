# oojam infrastructure

One Hetzner Cloud server, one data volume, one firewall and two primary IPs (SPEC §3).
Everything that runs on the server lives in [`../deploy`](../deploy/README.md).

```
terraform/            hcloud provider (~> 1.69): server, volume, firewall, IPs, SSH keys
cloud-init/
  user-data.yaml.tftpl  first boot: Docker CE, hardening, volume mount, egress rules, repo clone
```

## What gets created

| Resource | Notes |
|---|---|
| `hcloud_server.main` | `ubuntu-24.04`, `cpx41` (8 vCPU / 16 GB) in `nbg1` by default. Daily Hetzner backups on. **Delete and rebuild protection on.** |
| `hcloud_volume.data` | 100 GB ext4, mounted at `/opt/oojam/data` by cloud-init (Postgres, backups, build workspaces). **Delete protection on.** |
| `hcloud_primary_ip.ipv4` / `.ipv6` | Not auto-deleted, delete-protected: DNS survives a server rebuild. |
| `hcloud_firewall.main` | In: 80/tcp, 443/tcp+udp, ICMP from anywhere; 22/tcp from `admin_cidrs` only. |
| `hcloud_ssh_key.admin[*]` | Your keys; cloud-init installs them for the `oojam` user. |

Why `cpx41`: a daily build peaks at roughly builder 4 GB + `docker build` of the site ~2 GB + smoke test
(scratch Postgres, candidate site, Chromium) ~2 GB, on top of the always-on stack (~4–6 GB). An 8 GB
server has no headroom; 16 GB does, with 4 GB of swap as a last resort. Hetzner renames plans from time
to time: check `hcloud server-type list` and pick the current 8 vCPU / 16 GB shared type.

The server's root disk only holds the OS, Docker images and the checkout; everything that matters is on
the volume, and the volume is backed up by `deploy/`'s nightly `pg_dump` (optionally off-box).

## First run

```sh
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # SSH keys, admin CIDRs
export TF_VAR_hcloud_token=...                  # Hetzner project → Security → API tokens (read/write)
terraform init
terraform plan
terraform apply
terraform output dns_records                    # create these at your DNS provider
terraform output ssh
```

Then follow `deploy/README.md › First-time setup`. Cloud-init takes 3–5 minutes; when it's done,
`/opt/oojam/NEXT-STEPS.txt` exists and `cloud-init status` says `done`.

## What cloud-init does (first boot only)

- creates the `oojam` sudo user with your keys; root login, password and keyboard-interactive auth off;
  `AllowUsers oojam`; fail2ban on sshd;
- installs Docker CE, buildx and the compose plugin from `download.docker.com` (key
  `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`), with `daemon.json`: log rotation, `live-restore`,
  no userland proxy (so Caddy sees real client IPs, IPv6 included);
- mounts the volume at `/opt/oojam/data` via `/etc/fstab` and makes `docker.service`
  `RequiresMountsFor=/opt/oojam/data`: if the volume is missing Docker doesn't start, rather than
  Postgres initialising an empty database on the root disk;
- installs `oojam-firewall.service` (and a Docker `ExecStartPre`), which puts an `OOJAM-EGRESS` chain at
  the top of `DOCKER-USER`: containers cannot open connections to `169.254.0.0/16` (Hetzner's metadata
  service serves user-data) or to SMTP ports 25/465/587. Check with `sudo iptables -S OOJAM-EGRESS`;
- unattended-upgrades for Ubuntu security updates and Docker CE, rebooting at 04:30 UTC when needed
  (after the 03:30 backup, far from the 00:00 cycle);
- 4 GB swap, `vm.swappiness=10`;
- clones `https://github.com/oojam-dev/platform.git` into `/opt/oojam/platform`.

User-data contains no secrets (anything on the box could read it from the metadata service before the
egress rules were up; containers can't at all).

## Changes later

`user_data`, `ssh_keys` and `image` are in `ignore_changes`: cloud-init only runs on first boot, and
the server is protected against replacement. To add an admin key, add it to `~oojam/.ssh/authorized_keys`
on the server (and to `ssh_public_keys` so a future rebuild has it). Firewall changes
(`admin_cidrs`) apply in place.

Resizing: `server_type` can be changed in place (Hetzner reboots the server; disk can't shrink).
The volume can grow (`volume_size_gb`), then `sudo resize2fs /dev/disk/by-id/scsi-0HC_Volume_<id>`.

## Destroying

Delete protection is deliberate. To really tear down: set `delete_protection`/`rebuild_protection` to
`false` on the server, volume and IPs, `apply`, then `destroy`. Take a final backup first.

## Verification done

`terraform fmt` and `terraform validate` pass (provider 1.70.0). The cloud-init template renders through
`templatefile` and parses as YAML. It has not been booted on a real server yet: on first apply, check
`/var/log/cloud-init-output.log`, `findmnt /opt/oojam/data`, `sudo iptables -S DOCKER-USER`,
`sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication'`.

The lock file pins hashes for the platform it was created on; before applying from another platform run
`terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
