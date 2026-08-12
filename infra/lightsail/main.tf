# Glass relay — a stock Lightsail box running only sshd. The hub dials OUT and
# holds a reverse forward of :443 down to its local TLS listener, so the VPS
# only ever sees ciphertext and runs zero Glass code (plan §2/§4).
#
# NOTHING SECRET lives here. The tunnel SSH public key is passed in as a var
# (from your instance config / backup bundle), never committed. Apply under your
# own AWS SSO session — see README.md.

terraform {
  required_version = ">= 1.5"
  # Partial backend — the account-specific bucket/table/region live in a
  # gitignored backend.hcl (see backend.hcl.example), passed at init time:
  #   terraform init -backend-config=backend.hcl
  backend "s3" {}
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "region" { default = "us-east-2" }
variable "instance_name" { default = "glass-relay" }
variable "bundle_id" { default = "nano_3_0" } # smallest Lightsail plan
variable "blueprint_id" { default = "amazon_linux_2023" }

# The hub's dedicated tunnel SSH public key (ed25519). Supplied at apply time
# via -var or a gitignored *.tfvars — NEVER committed to this public repo.
variable "tunnel_ssh_pubkey" {
  type        = string
  description = "ssh-ed25519 public key the hub uses to open the reverse tunnel"
}

provider "aws" {
  region = var.region
}

resource "aws_lightsail_instance" "relay" {
  name              = var.instance_name
  availability_zone = "${var.region}a"
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  # Shell (not cloud-config): Lightsail prepends its own #!/bin/sh init script,
  # so user_data runs as shell. See user-data.sh.tftpl for the full rationale.
  user_data = templatefile("${path.module}/user-data.sh.tftpl", { tunnel_ssh_pubkey = var.tunnel_ssh_pubkey })
}

resource "aws_lightsail_static_ip" "relay" {
  name = "${var.instance_name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "relay" {
  static_ip_name = aws_lightsail_static_ip.relay.name
  instance_name  = aws_lightsail_instance.relay.name

  # The attachment's args are static strings, so replacing the instance would
  # otherwise leave the static IP detached (the new instance would keep a dynamic
  # IP). Tie the attachment's lifecycle to the instance's id so it re-attaches
  # whenever the instance is recreated.
  lifecycle {
    replace_triggered_by = [aws_lightsail_instance.relay.id]
  }
}

resource "aws_lightsail_instance_public_ports" "relay" {
  instance_name = aws_lightsail_instance.relay.name

  # Declare the CIDRs explicitly. AWS auto-populates these defaults, so omitting
  # them makes Terraform plan a perpetual replacement (config ≠ refreshed state).
  port_info {
    protocol   = "tcp"
    from_port  = 22
    to_port    = 22
    cidrs      = ["0.0.0.0/0"]
    ipv6_cidrs = ["::/0"]
  }
  port_info {
    protocol   = "tcp"
    from_port  = 443
    to_port    = 443
    cidrs      = ["0.0.0.0/0"]
    ipv6_cidrs = ["::/0"]
  }
}

output "relay_ip" {
  value       = aws_lightsail_static_ip.relay.ip_address
  description = "Point your relay DNS A record here; put the hostname only in the hub's instance config + backup bundle."
}
