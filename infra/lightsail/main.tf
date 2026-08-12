# Glass relay — a stock Lightsail box running only sshd. The hub dials OUT and
# holds a reverse forward of :443 down to its local TLS listener, so the VPS
# only ever sees ciphertext and runs zero Glass code (plan §2/§4).
#
# NOTHING SECRET lives here. The tunnel SSH public key is passed in as a var
# (from your instance config / backup bundle), never committed. Apply under your
# own AWS SSO session — see README.md.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "region" { default = "us-west-2" }
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
  user_data         = templatefile("${path.module}/cloud-init.yaml", { tunnel_ssh_pubkey = var.tunnel_ssh_pubkey })
}

resource "aws_lightsail_static_ip" "relay" {
  name = "${var.instance_name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "relay" {
  static_ip_name = aws_lightsail_static_ip.relay.name
  instance_name  = aws_lightsail_instance.relay.name
}

resource "aws_lightsail_instance_public_ports" "relay" {
  instance_name = aws_lightsail_instance.relay.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
  }
  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }
}

output "relay_ip" {
  value       = aws_lightsail_static_ip.relay.ip_address
  description = "Point your relay DNS A record here; put the hostname only in the hub's instance config + backup bundle."
}
