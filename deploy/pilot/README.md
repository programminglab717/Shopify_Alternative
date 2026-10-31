# The pilot on one machine

Hatti for its first 5 to 10 shops, on one Linux machine with Docker ([ADR-989](../../docs/architecture/13-decision-log.md)).
Everything runs from this repository's own images: Postgres, Valkey, the core's API and worker,
the storefront, and [Caddy](https://caddyserver.com) in front, which takes a free certificate
from Let's Encrypt for each host. All of it is free and open source. The cloud cell
([10 · Infrastructure](../../docs/architecture/10-infrastructure-and-devops.md)) replaces it
once the hosting is chosen (OWN-03).

## What you need

* **A machine:** 4 vCPUs, 8 GB of memory, 80 GB of disk, Ubuntu 24.04, with Docker Engine and
  its Compose plugin. Ports 80 and 443 open to the internet; nothing else need be.
* **A domain** (OWN-01), with these DNS records pointing at the machine's address:
  `A @`, `A admin`, `A api`, `A *` (every shop's subdomain), and `CNAME shops → @` for shops'
  own domains.
* **An S3 bucket** for the files shops upload (OWN-27). Cloudflare R2's free tier is enough.
* As they come: email (OWN-26), WhatsApp (OWN-23) or SMS (OWN-10), and the couriers (OWN-22).
  The pilot runs without them, but staff sign in by codes that need one of WhatsApp, SMS or
  email to arrive.

## Start it

```sh
git clone <this repository> /srv/hatti && cd /srv/hatti/deploy/pilot
./init.sh example.pk ops@example.pk      # writes hatti.env, passwords and keys generated
nano hatti.env                           # S3_*, then each partner's settings as they come
docker compose up -d --build             # builds, sets up and migrates the database, starts
docker compose ps                        # api, worker, storefront and edge running, healthy
```

Then open `https://admin.example.pk`. Back up `hatti.env` somewhere safe and off the machine: its
`ENCRYPTION_KEYS` seal what shops keep secret (authenticator seeds, partners' tokens), and they
cannot be opened without it. Set the bucket's CORS rule for the admin once:

```sh
docker compose run --rm api node dist/storage-cors.js apply
```

## Day to day

| To | Run |
| --- | --- |
| See what is running | `docker compose ps` |
| Read a service's log | `docker compose logs -f --tail=200 api` (or `worker`, `storefront`, `edge`) |
| Deploy a new version | `git pull && docker compose up -d --build` (setup migrates first) |
| Back up the database | `./backup.sh` (and from cron, every six hours, as it says) |
| Restore a backup | `./restore.sh backups/hatti-….dump` (asks first) |
| Restart one service | `docker compose restart worker` |

A deploy rebuilds the images, runs `setup`, which applies new migrations, and then replaces each
service: each is away for the few seconds its container restarts. Deploy outside the shops' busy
hours, and back up first.

## Backups

`backup.sh` dumps the database to `backups/`, keeping 14 days. **Copy that folder off the
machine** each day (for example with [rclone](https://rclone.org), open source, to the S3 bucket
under another prefix): a backup kept only on the machine is lost with it. Files are in S3 already;
Valkey keeps the queues on its own volume, and the outbox sends their jobs again if they are
lost. Try a restore on another machine before the first shop goes live, and once a month after.

## When something goes wrong

* **A service keeps restarting:** `docker compose logs --tail=100 <service>`. A setting the core
  refuses is named in its first lines.
* **No certificate for a shop's host:** the storefront answers Caddy's question only for the
  platform's domain, shops' subdomains and their verified domains. Check the shop's handle, or
  that its domain is verified in the admin; `docker compose logs edge` says what Let's Encrypt
  answered. Let's Encrypt allows 50 certificates a week for one domain.
* **The disk fills:** `docker system df`, then `docker image prune` for old builds; backups older
  than 14 days are removed by `backup.sh` itself.
* **The machine is lost:** a new machine, the same DNS records moved to it, `hatti.env` from its
  safe copy, `docker compose up -d --build`, then `./restore.sh` with the latest backup.

## What it is not

One machine is one point of failure, and its backups are hours apart at worst. It suits a pilot
of a few shops that know they are trying something new. Before more shops, or any that cannot
lose a few hours of orders, move to the cloud cell, with managed Postgres and its point-in-time
recovery (OWN-03).
