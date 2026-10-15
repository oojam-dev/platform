output "ipv4" {
  value = hcloud_primary_ip.ipv4.ip_address
}

output "ipv6" {
  description = "The server's address in its /64 (Hetzner assigns <prefix>::1)."
  value       = hcloud_server.main.ipv6_address
}

output "ssh" {
  value = "ssh oojam@${hcloud_primary_ip.ipv4.ip_address}"
}

output "volume_device" {
  value = "/dev/disk/by-id/scsi-0HC_Volume_${hcloud_volume.data.id}"
}

output "dns_records" {
  description = "Create these at the DNS provider (TTL 300 until things settle)."
  value = [
    for r in [
      { name = var.site_domain, type = "A", value = hcloud_primary_ip.ipv4.ip_address },
      { name = var.site_domain, type = "AAAA", value = hcloud_server.main.ipv6_address },
      { name = "www.${var.site_domain}", type = "A", value = hcloud_primary_ip.ipv4.ip_address },
      { name = "www.${var.site_domain}", type = "AAAA", value = hcloud_server.main.ipv6_address },
      { name = var.platform_domain, type = "A", value = hcloud_primary_ip.ipv4.ip_address },
      { name = var.platform_domain, type = "AAAA", value = hcloud_server.main.ipv6_address },
      { name = var.site_domain, type = "CAA", value = "0 issue \"letsencrypt.org\"" },
    ] : "${r.name}. ${r.type} ${r.value}"
  ]
}
