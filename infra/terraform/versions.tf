terraform {
  required_version = ">= 1.6"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.69"
    }
  }
  # State holds no secrets beyond the API token's effects, but losing it means
  # re-importing everything. Keep it somewhere durable, e.g. Hetzner Object
  # Storage via the S3 backend:
  # backend "s3" {
  #   bucket                      = "oojam-tfstate"
  #   key                         = "oojam/terraform.tfstate"
  #   region                      = "eu-central"
  #   endpoints                   = { s3 = "https://fsn1.your-objectstorage.com" }
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  # }
}

provider "hcloud" {
  token = var.hcloud_token
}
