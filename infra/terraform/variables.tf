variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud API token (read/write) for the oojam project. Prefer TF_VAR_hcloud_token over tfvars."
}

variable "name" {
  type        = string
  default     = "oojam"
  description = "Name prefix for every resource."
}

variable "location" {
  type        = string
  default     = "nbg1"
  description = "Hetzner location (nbg1, fsn1, hel1, ...). The volume and primary IPs live here too."
}

variable "server_type" {
  type        = string
  default     = "cpx41"
  description = <<-EOT
    8 vCPU / 16 GB / 240 GB. A build peaks at roughly: builder container 4 GB
    + `docker build` of the site (npm ci, typecheck, vite build) ~2 GB + smoke
    test (scratch Postgres + candidate site + Chromium) ~2 GB, on top of the
    always-on stack (~4-6 GB: Postgres, platform-web, worker, gateway, the live
    site, Caddy, squid). 8 GB (cpx31) leaves no headroom; 16 GB does, with
    swap as a last resort. Check `hcloud server-type list` for current names.
  EOT
}

variable "image" {
  type    = string
  default = "ubuntu-24.04"
}

variable "ssh_public_keys" {
  type        = map(string)
  description = "Admin SSH public keys, name => \"ssh-ed25519 AAAA... comment\". Installed for the `oojam` sudo user (root login is disabled)."
  validation {
    condition     = length(var.ssh_public_keys) > 0
    error_message = "At least one SSH public key is required."
  }
}

variable "admin_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to reach SSH (22/tcp), e.g. [\"203.0.113.7/32\", \"2001:db8::/48\"]."
  validation {
    condition     = length(var.admin_cidrs) > 0 && alltrue([for c in var.admin_cidrs : can(cidrhost(c, 0))])
    error_message = "admin_cidrs must be a non-empty list of valid CIDRs."
  }
}

variable "volume_size_gb" {
  type        = number
  default     = 100
  description = "Data volume, mounted at /opt/oojam/data: Postgres, backups, build workspaces."
}

variable "platform_repo" {
  type        = string
  default     = "https://github.com/oojam-dev/platform.git"
  description = "Cloned into /opt/oojam/platform on first boot (public HTTPS URL; no credentials in user-data)."
}

variable "site_domain" {
  type    = string
  default = "oojam.dev"
}

variable "platform_domain" {
  type    = string
  default = "build.oojam.dev"
}

variable "server_backups" {
  type        = bool
  default     = true
  description = "Hetzner's daily server backups (root disk only; +20% of the server price). The data volume is covered by deploy/'s pg_dump backups."
}
