# oojam: one VM, one data volume, a firewall, two primary IPs (SPEC §3).

resource "hcloud_ssh_key" "admin" {
  for_each   = var.ssh_public_keys
  name       = "${var.name}-${each.key}"
  public_key = each.value
}

# 80/443 (tcp, and udp for HTTP/3) from anywhere; SSH from admin_cidrs only;
# ICMP for path MTU discovery and diagnostics. Everything else inbound is
# dropped. Outbound is unrestricted at this level; container egress is limited
# on the host (DOCKER-USER rules, cloud-init) and by Docker's internal networks.
resource "hcloud_firewall" "main" {
  name = var.name

  rule {
    description = "HTTP (ACME, redirect to HTTPS)"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "HTTP/3"
    direction   = "in"
    protocol    = "udp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "SSH from admins"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.admin_cidrs
  }
  rule {
    description = "ICMP"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

# Primary IPs outlive the server (auto_delete = false), so DNS stays valid if
# the server ever has to be recreated.
resource "hcloud_primary_ip" "ipv4" {
  name              = "${var.name}-ipv4"
  type              = "ipv4"
  location          = var.location
  auto_delete       = false
  delete_protection = true
}

resource "hcloud_primary_ip" "ipv6" {
  name              = "${var.name}-ipv6"
  type              = "ipv6"
  location          = var.location
  auto_delete       = false
  delete_protection = true
}

# Data volume: Postgres, backups, build workspaces (/opt/oojam/data).
# Formatted ext4 by Hetzner; mounted by cloud-init at /opt/oojam/data (not
# Hetzner's automount, which would mount it at /mnt/HC_Volume_<id>).
resource "hcloud_volume" "data" {
  name              = "${var.name}-data"
  size              = var.volume_size_gb
  location          = var.location
  format            = "ext4"
  delete_protection = true
}

resource "hcloud_server" "main" {
  name               = var.name
  server_type        = var.server_type
  image              = var.image
  location           = var.location
  ssh_keys           = [for k in hcloud_ssh_key.admin : k.id]
  firewall_ids       = [hcloud_firewall.main.id]
  backups            = var.server_backups
  delete_protection  = true
  rebuild_protection = true

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.ipv4.id
    ipv6_enabled = true
    ipv6         = hcloud_primary_ip.ipv6.id
  }

  # No secrets: keys are public, the repo URL is public. Secrets go into
  # deploy/.env by hand after first boot (deploy/README.md).
  user_data = templatefile("${path.module}/../cloud-init/user-data.yaml.tftpl", {
    ssh_public_keys = values(var.ssh_public_keys)
    volume_id       = hcloud_volume.data.id
    platform_repo   = var.platform_repo
    site_domain     = var.site_domain
    platform_domain = var.platform_domain
  })

  labels = {
    app = var.name
  }

  lifecycle {
    # cloud-init runs on first boot only; changing it (or the key list, or a
    # newer image) must not try to replace a delete-protected server.
    ignore_changes = [user_data, ssh_keys, image]
  }
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.main.id
  automount = false
}
