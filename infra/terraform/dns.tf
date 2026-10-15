# DNS records in the Hetzner zone for the site domain (the zone itself already exists in
# the project; set manage_dns = false if your DNS lives elsewhere and use output.dns_records).
variable "manage_dns" {
  type        = bool
  default     = true
  description = "Create the A/AAAA/CAA records in the project's Hetzner DNS zone for site_domain."
}

data "hcloud_zone" "site" {
  count = var.manage_dns ? 1 : 0
  name  = var.site_domain
}

locals {
  # Record names relative to the zone ("@" is the apex).
  platform_label = trimsuffix(var.platform_domain, ".${var.site_domain}")
  dns_hosts      = var.manage_dns ? toset(["@", "www", local.platform_label]) : toset([])
}

resource "hcloud_zone_rrset" "a" {
  for_each = local.dns_hosts
  zone     = data.hcloud_zone.site[0].name
  name     = each.key
  type     = "A"
  ttl      = 300
  records  = [{ value = hcloud_primary_ip.ipv4.ip_address }]
}

resource "hcloud_zone_rrset" "aaaa" {
  for_each = local.dns_hosts
  zone     = data.hcloud_zone.site[0].name
  name     = each.key
  type     = "AAAA"
  ttl      = 300
  records  = [{ value = hcloud_server.main.ipv6_address }]
}

# Only Let's Encrypt may issue certificates for these names.
resource "hcloud_zone_rrset" "caa" {
  count   = var.manage_dns ? 1 : 0
  zone    = data.hcloud_zone.site[0].name
  name    = "@"
  type    = "CAA"
  ttl     = 3600
  records = [{ value = "0 issue \"letsencrypt.org\"" }]
}
