#!/bin/bash
#
# Glass relay VPS bootstrap (Lightsail user-data, runs once at first boot).
#
# Deliberately generic — no hostnames, keys, or per-install values belong in
# this file (public repo, plan §4). The relay process itself, its hub public
# key, and the systemd unit are deployed manually afterward (see README.md).
set -eux
export DEBIAN_FRONTEND=noninteractive

# Security updates apply themselves; this box should never need routine logins.
apt-get update
apt-get install -y unattended-upgrades
systemctl enable --now unattended-upgrades

# Dedicated unprivileged user for the relay process (see glass-relay.service).
useradd --system --create-home --home-dir /opt/glass-relay \
  --shell /usr/sbin/nologin glass || true

# Config directory for values that live only on this box + in the backup
# bundle (e.g. the hub's PUBLIC identity key the relay pins).
mkdir -p /etc/glass-relay
chown root:glass /etc/glass-relay
chmod 750 /etc/glass-relay
