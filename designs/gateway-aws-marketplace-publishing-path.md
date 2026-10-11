# Gateway AWS Marketplace Publishing Path

| | |
|---|---|
| **Created** | 2026-06-18 |
| **Updated** | 2026-06-22 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |

## What is the Problem Being Solved?

The MVP is a turnkey Capability Bridge that operators deploy from cloud marketplaces (AWS, GCP, Azure).
The project publishes the artifact; the operator runs it in their own cloud account.
The concrete deliverable this design scopes is a path with concrete steps toward publishing an Endo Gateway artifact for use in the Amazon Marketplace.

A working publishing path needs four kinds of things in one document:

1. A **sequenced plan**, written so a future builder dispatch can read the next step off the page and act, with months-since-start estimates and explicit gating between phases.
2. An **MVP composition**, naming the concrete files and unit responsibilities the single-AMI artifact carries at first listing.
3. A **submission checklist** for AWS Marketplace, covering seller registration, AMI scanner pass, listing review cadence, and the commercial-entity prerequisites the project has not yet acquired.
4. A **cross-design coordination** layer that names which named design gaps are blockers and which are deferrable, plus the decisions the designer takes a stance on so the maintainer can ratify or veto each one in a single pass.

This design is a sequencing-and-gaps document, not a packaging design.
The OS substrate (`.deb` / `.rpm` / PKGBUILD / Dockerfile / Homebrew formula / systemd unit / launchd plist) lives in the existing gateway-packaging work.
The AWS deployment topology (VPC, ALB, Auto Scaling Group, Terraform IaC) lives in the existing [gateway-aws-deployment](gateway-aws-deployment.md) design.
The MCP termination surface lives in [endo-gateway-mcp](endo-gateway-mcp.md).
What this design adds is the **publishing path**: the calendar-aware sequence that composes those substrates into a marketplace listing, the irreversible commitments that listing pins, and the open questions the maintainer must close before the first submission.

## Background

**Strategy.**
The MVP shape is operator-deployed to the operator's own cloud account, with the project as publisher and the operator as the running party.
The self-custodial framing rules out the SaaS product type for O1; it ratifies the AMI / VHD / GCE-image shape on each cloud.
The demonstrative service adapters are Gmail, Slack, generic OAuth-2, and GitHub, with OAuth as the operator-identity bonding mechanism.
The MCP+OAuth bridge is the brief opening before a platform vendor builds capability attenuation into MCP or a competitor claims the category.

**Critical path.**
The O1 critical path, derived against the dependency graph, surfaces twelve design gaps that block O1.
Three of those gaps are decisive for marketplace publishing: **G-tls-firstboot** (the gateway refuses TLS by design, so a marketplace appliance must bundle a reverse proxy and obtain a certificate autonomously at first boot), **G-firstboot** (AWS forbids hardcoded secrets, so the operator's initial bearer must be generated at first boot and delivered out-of-band), and **G-resource-classes** (AWS MeterUsage dimension names are locked after publication, so the metering taxonomy must be authored and panel-reviewed before the first listing).

**Gateway substrate.**
The gateway CLI wrapper, per-platform state locations, the systemd unit (`endo-gateway.service`), the launchd plist, and the system-service documentation are in place.
Five OS packaging recipes (Debian, RPM, Arch PKGBUILD, Dockerfile, Homebrew formula) and the packaging documentation are in place.
The HTTP listener is wired so `endo gateway start` binds a real server.
Together these compose into "an operator can install and run the gateway as a system service on any Linux distribution"; the AMI is the next layer above.

**AWS-stack design.**
Three Proposed designs cover the deployment layer one level above what the OS packages provide: [gateway-packaging-ci](gateway-packaging-ci.md) (build + sign + host the OS packages from CI), [gateway-aws-deployment](gateway-aws-deployment.md) (the VPC + ALB + ASG topology for a multi-AZ HA deployment), and `gateway-aws-attuned` (AWS-native options for S3 CAS, Nitro Enclaves, DynamoDB state).

**Marketplace product shapes.**
AWS Marketplace offers four product shapes (Single AMI, AMI+CFT, Container, SaaS).
Against the Capability Bridge's architecture, single-AMI fits O1 launch, AMI+CFT fits a graduation step, container is a natural second listing, and SaaS is reserved for O2 (the Hub).
Azure and GCP offer functionally analogous shapes.
AWS marketplace fees are 20% server fee on AMI/AMI+CFT revenue and 3% on SaaS revenue, with a +0.5% CPPO uplift on Channel Partner Private Offers and a +1% South Korea regional uplift (effective 2025-04-01); Azure and GCP have their own metering and SaaS identity-bonding APIs covered later in this design.

## Architectural Shape

```mermaid
flowchart TB
    subgraph SUBSTRATE["Gateway substrate (existing work)"]
      gatewayPkg["@endo/gateway<br/>(phases 2-11)"]
      cli["endo gateway CLI"]
      systemd["systemd / launchd units"]
      osPkgs[".deb / .rpm / PKGBUILD<br/>Dockerfile / brew formula"]
      listener["HTTP listener wire-up"]
    end

    subgraph GAPS["Marketplace-gating design gaps (this design scopes; siblings author)"]
      gFirstboot["G-firstboot<br/>(out-of-band bearer)"]
      gTls["G-tls-firstboot<br/>(bundled Caddy + ACME)"]
      gClasses["G-resource-classes<br/>(MeterUsage dimensions)"]
    end

    subgraph PUBLISH["Publishing path (this design)"]
      packerBuild["Packer AMI build<br/>(from .deb on Amazon Linux 2023)"]
      scanner["AWS Marketplace scanner<br/>(self-service Build tab)"]
      seller["Seller registration<br/>(commercial entity)"]
      meterUsage["MeterUsage integration<br/>(@endo/payment-aws-mp adapter)"]
      listing["AWS Marketplace listing<br/>(2-4 weeks review)"]
    end

    subgraph DEPLOY["Deployment layer (existing design)"]
      awsDeploy["gateway-aws-deployment<br/>(ALB + ASG + Terraform)"]
    end

    subgraph FOLLOWUPS["Deferred follow-ups (O1.b / O1.c / O2)"]
      azure["Azure VHD listing"]
      gcp["GCP GCE image listing"]
      tuf["G-upgrade<br/>(TUF signed updates)"]
      saas["SaaS listing<br/>(Hub, O2)"]
    end

    SUBSTRATE --> packerBuild
    GAPS --> packerBuild
    packerBuild --> scanner
    scanner --> listing
    seller --> listing
    meterUsage --> listing
    listing -.graduation.-> awsDeploy
    listing -.O1.b.-> azure
    listing -.O1.b.-> gcp
    listing -.O1.c.-> tuf
    listing -.O2.-> saas
```

The AMI is the first artifact; everything else either feeds it (the substrate and the three blocker gaps) or graduates from it (the deployment layer, the second-cloud listings, the signed-update channel, the SaaS listing for the Hub).

The publishing path is a calendar-bound sequence.
Two of the AWS Marketplace constraints are not effort estimates and cannot be parallelized away: the AMI scanner + listing review takes 2-4 calendar weeks per submission, and planned releases need 45 days lead.
Custom Metering dimension names, once chosen, are locked at publication and cannot be renamed or removed.
The sequencing prioritizes resolving the lock-bearing decisions early.

## Sequenced Plan

Months are calendar months from the dispatch of this design (2026-06-18).
Steps within a phase parallelize where the dependency graph allows; the phase-level ordering is binding.

### Phase O1.a: months 0-3, single AWS AMI listing

**Goal:** a buyer subscribes through AWS Marketplace, an AMI launches in their AWS account, and they receive a Capability Bridge that terminates MCP for at least one service adapter.

**Built (named work items and design slugs):**

- gateway-package: phases 2-11 merged to `master`.
- M6 P1: extract `@endo/agent-tools` from `packages/lal/agent.js`; bearer-token table + `publishAgent` on `Registration`; `/mcp` adapter + SSE; Chat-side "Add agent" button and "MCP" tab affordances.
  Per [endo-gateway-mcp](endo-gateway-mcp.md).
- New design files (each its own designer dispatch):
  - `designs/gateway-first-boot-ceremony.md` (G-firstboot).
  - `designs/gateway-bundled-tls.md` (G-tls-firstboot).
  - `designs/gateway-resource-classes.md` (G-resource-classes).
- New builder PRs implementing the three gap designs.
- `packages/payment-aws-mp/`: a `PaymentProcessor` adapter that calls `MeterUsage` once per hour per dimension per customer, conforming to the `verifyPaymentProof(tokens, proof)` contract that gateway-package Phase 8's ResourceLedger injects.
  Custom Metering is the AWS billing channel for the AMI; the Stripe adapter remains the self-host billing channel.
- `packaging/aws-ami/`: a Packer build that starts from Amazon Linux 2023 ARM64 (`c7g.large` per [gateway-aws-deployment](gateway-aws-deployment.md)), installs the `.deb` produced by the packaging recipes, enables the systemd service, bundles Caddy with the ACME first-boot script per G-tls-firstboot, writes the first-boot bearer-delivery script per G-firstboot, applies AMI hardening (no password auth, no pre-seeded SSH keys, no embedded credentials), and emits an AMI in `us-east-1`.
- One service adapter (recommend GitHub; see *Decision 3* below).

**Reviewed:**

- AWS Marketplace scanner pass (self-service Test Add Version, typically under one hour per run).
- Internal panel review of `gateway-resource-classes` (solicitor's design panel; the dimension names are about to be locked, so the review must happen before submission).
- Builder-side review on each gap PR.

**Locked (irreversible decisions at submission):**

- **MeterUsage dimension names**, 15-character alphanumeric + underscore each, up to 24 dimensions, cannot be renamed or removed after publication.
  Recommended starting set, drawn from the four natural resource classes the gateway already accounts for: `computrons` (compute), `cogitrons` (inference), `bytes_stored` (storage), `bytes_network` (network).
  All four fit the 15-character cap (max length 12).
  `gateway-resource-classes` is the design that ratifies or revises these names; this design recommends them as a starting point.
- **Custom Metering as the AWS billing model**.
  Once published, the product cannot be converted to Paid Hourly, Paid Monthly, or BYOL.
  See *Decision 2* below for the trade-off.
- **Vendor-controlled DNS provisioning**, if Pattern 1 (vendor-delegated CNAME) is the bundled-TLS pattern.
  The publisher commits to running a DNS provisioning service for every issued node for the lifetime of every deployed node (Let's Encrypt's 90-day renewal needs the API reachable).
  See *Decision 5* below.

**Deferred (named follow-ups, each named in the *Open Questions* or O1.b/c/O2 sections below):**

- TUF signed-update channel (G-upgrade).
  AMI versions are valid for 2 years; until G-upgrade ships, plan to re-submit a new AMI version every 12 months at most.
- State export / restore / migration (G-state-custody).
  Brand-promise weight; ships in the second AMI version.
- AMI+CFT graduation.
  Single-AMI for first listing; AMI+CFT carries [gateway-aws-deployment](gateway-aws-deployment.md) into the marketplace shape and graduates the listing later.
- Azure VHD listing (O1.b).
- GCP GCE image listing (O1.b).
- SaaS listing for the Hub (O2).

### Phase O1.b: months 3-5, parallel Azure VHD + GCP GCE listings

**Goal:** the same buyer can choose AWS, Azure, or GCP at subscription time and receive functionally equivalent Bridges.

**Built:**

- `packages/payment-azure-mp/`: a `PaymentProcessor` adapter for the Azure Marketplace metering service (REST API; dimensions defined before publishing; available only on flat-rate billing model).
- `packages/payment-gcp-mp/`: a `PaymentProcessor` adapter for GCP Service Control (gRPC; Google manages billing on the publisher's behalf via Cloud Commerce Partner Procurement API).
- `packaging/azure-vhd/`: a Packer or `azure-image-builder` build emitting a VHD with the first 1 MB reserved for Azure metadata, managed-disk format, that installs the same `.deb` and wires the Azure metering adapter.
- `packaging/gcp-gce/`: a Packer build emitting a GCE image with the Compute Engine license attachment, that installs the same `.deb` and wires the GCP Service Control adapter.
- New design files:
  - `designs/gateway-state-custody.md` (G-state-custody).
    Critical for the multi-cloud "credible exit" claim: an operator who moves between clouds must be able to take their state with them.
  - `designs/gateway-operator-observability.md` (G-observability).
    Operator-facing metrics that are structurally incapable of being member surveillance.

**Reviewed:**

- Azure Certification Test Tool (the gating step on Azure VM offers).
- GCP Marketplace partner-program review (Procurement API and Service Control integration verified by GCP team).
- Internal panel review of `gateway-state-custody` and `gateway-operator-observability`.

**Locked:**

- Azure metering dimensions (separately from AWS; Azure permits more permissive naming, so the AWS-acceptable set is automatically Azure-acceptable).
- GCP Service Control metric names (also more permissive than AWS).

**Submitted in parallel** within their respective review cadences (Azure 1-3 weeks per practitioner reports; GCP 2-4 weeks per practitioner reports).

### Phase O1.c: months 5-8, TUF signed-update channel

**Goal:** marketplace continuous-compliance no longer threatens the listings; deployed nodes can pull signed updates without operator intervention.

**Built:**

- `designs/gateway-upgrade-channel.md` (G-upgrade).
  TUF-shaped Root / Targets / Snapshot / Timestamp role hierarchy; offline keys for Root / Snapshot / Targets; online Timestamp key on vendor build infrastructure.
- `packages/gateway-tuf-client/`: the on-node update applicator.
  Reuses [ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md) for the session-survives-update property.
- `services/tuf-repository/`: the vendor-side signed-metadata repository.

**Reviewed:** offline-key custody procedure (a separate operational document; this design notes the obligation, the operational document is its own deliverable).

**Locked:** the TUF root keys.
Rotation is a TUF-defined ceremony; not "irreversible" in the marketplace sense, but operationally heavy enough to merit treating as a one-shot commitment.

**Deferred:** O2 work (the Hub), and the SaaS listing per Phase O2 below.

### Phase O2: months 8+, Capability Hub

**Goal:** the Hub is listed as a SaaS product on each cloud, alongside the per-cloud Bridge image listings.
The Hub is a federated, multi-tenant variant of the Gateway; the Bridge listings continue serving self-custodial operators in parallel.

**Built:** the Hub milestone (M7) in full, including `endo-gateway` Open Question 2 (the virtual-users mode), G-hub-invitation, G-multitenancy, G-hub-economics, G-abuse-moderation, G-operator-liability.

**Reviewed:** per-cloud SaaS Fulfillment API integrations.

**Locked:** the SaaS subscription / metering dimensions per cloud (analogous to the AWS Custom Metering lock at O1.a, repeated for each cloud's SaaS shape).

**Deferred:** federation across hubs is the next-after-this work; out of scope here.

## MVP Single-AMI Artifact Composition

The first AMI is built by Packer from Amazon Linux 2023 ARM64 (the `c7g.large` baseline named in [gateway-aws-deployment](gateway-aws-deployment.md) § EC2 Auto Scaling Group).
The Packer template lives at `packaging/aws-ami/template.pkr.hcl` in the monorepo, alongside the existing five packaging recipes.

### Files the AMI must include

The AMI's filesystem composition, expressed as the layered changes Packer applies on top of the base image:

| Source | Path on AMI | Purpose |
|--------|-------------|---------|
| `.deb` from `packaging/debian/` | installed via `apt install` | `@endo/gateway` binary, `endo gateway` CLI |
| systemd unit from `packages/gateway/systemd/endo-gateway.service` | `/lib/systemd/system/endo-gateway.service` | service supervision, `User=endo`, hardened directives |
| Caddy binary (vendored or apt-installed) | `/usr/bin/caddy` | TLS termination per G-tls-firstboot |
| Caddyfile template | `/etc/caddy/Caddyfile.template` | `<node-id>.nodes.endo.example.com` virtual host, ACME DNS-01 challenge |
| Caddy systemd unit | `/lib/systemd/system/caddy.service` | service supervision for the bundled proxy |
| `endo-firstboot.sh` | `/usr/sbin/endo-firstboot.sh` | first-boot ceremony per G-firstboot (bearer generation + delivery) |
| `endo-firstboot.service` | `/lib/systemd/system/endo-firstboot.service` | one-shot systemd unit, `Type=oneshot`, `After=network-online.target`, `Before=endo-gateway.service` |
| `endo-meterusage.sh` | `/usr/sbin/endo-meterusage.sh` | hourly cron job calling the `@endo/payment-aws-mp` adapter |
| `endo-meterusage.timer` | `/lib/systemd/system/endo-meterusage.timer` | systemd timer firing the meter-usage shell once per hour |

The systemd unit ordering: `endo-firstboot.service` runs once at first boot, generates the operator's root bearer, writes it to AWS instance user-data response (or serial console; see G-firstboot for the delivery channel decision) and to `/var/lib/endo-gateway/first-boot-bearer.txt` with mode `0400` owned by `endo:endo`, performs the Caddy DNS-01 ACME provisioning, then enables and starts `endo-gateway.service`.

### Cloud-init / user-data hooks

The AMI does not assume any specific cloud-init userdata; cloud-init's `cloud-config` is optional.
The Packer template installs:

- `/etc/cloud/cloud.cfg.d/99-endo.cfg`: a cloud-init override that ensures `endo-firstboot.service` runs after `cloud-init.target` reaches its final stage.
  This guarantees `endo-firstboot.sh` runs after the instance has its public IP and instance metadata is reachable.
- `/var/lib/cloud/scripts/per-instance/00-endo-mark-pristine.sh`: a one-shot script that writes a sentinel file `/var/lib/endo-gateway/.first-boot-pending` to mark the AMI as freshly-launched; `endo-firstboot.sh` checks for the sentinel and refuses to re-run if it is absent.
  This handles AMI cloning (AWS clones the AMI per-region and attaches a product code; we want first-boot to run once per *instance*, not per *clone*).

The AMI does not consume any operator-supplied user-data at first boot; the bearer is generated, not supplied.
A future enhancement may let an operator pre-stage configuration via user-data (e.g., a domain name to skip vendor-delegated DNS); that is out of scope for the first listing.

### Systemd units shipped

The four units shipped on the AMI:

1. `endo-gateway.service`: the gateway daemon, `User=endo`, hardened directives per the shipped systemd unit.
2. `caddy.service`: the bundled TLS terminator, listens on `:443`, proxies plaintext HTTP to `127.0.0.1:3469` (the gateway's `c7g.large` bind port per [gateway-aws-deployment](gateway-aws-deployment.md)).
3. `endo-firstboot.service`: the one-shot first-boot unit (described above).
4. `endo-meterusage.timer` + `endo-meterusage.service`: the hourly meter-usage emission to AWS.

### TLS-firstboot sub-design sketch (G-tls-firstboot territory)

This design defers the full G-tls-firstboot design to a sibling dispatch; here we sketch the shape so the maintainer can evaluate the Pattern 1 commitment.

The recommended pattern is **vendor-delegated subdomain with pre-provisioned CNAME**:

1. The publisher operates a DNS zone `nodes.endo.example.com` and an HTTPS API at `https://dns.endo.example.com/v1/provision` that accepts a node-id and creates a CNAME `<node-id>.nodes.endo.example.com` plus the ACME DNS-01 challenge TXT records.
2. The AMI is built with a per-node short-lived provisioning token baked in at boot time (`endo-firstboot.sh` generates a fresh node-id, signs a JWS with the gateway's Ed25519 keypair, and presents it to the provisioning API).
3. Caddy at first boot performs ACME DNS-01 against Let's Encrypt; the challenge TXT records are written by the provisioning API on the publisher's authority.
4. Caddy renews the certificate every 60 days (Let's Encrypt's recommended renewal window); the provisioning API stays reachable for the lifetime of every deployed node.
5. The operator's marketplace listing page surfaces the `<node-id>.nodes.endo.example.com` URL post-launch.

**The non-custodian-spirit contradiction**: vendor-delegated DNS requires the publisher to run a DNS provisioning service for every issued node for that node's lifetime, which contradicts the project's "we are not the custodian" posture.
This design's stance is to **accept the contradiction** (see *Decision 5* below) because the alternative TOFU / bring-your-own-domain patterns degrade the "click deploy and get a running node" UX to a point that undermines the MVP positioning.
G-tls-firstboot's design dispatch should surface a bring-your-own-domain mode as an opt-in alternative for operators who want to avoid the vendor's DNS commitment; the maintainer's call is whether the opt-in alternative is required for first listing or a v1.1 fast-follow.

## AWS Marketplace Submission Checklist

A working sequence the publisher follows once the AMI is built and the gap PRs are merged:

1. **AWS Marketplace seller registration.**
   Free; requires tax forms (W-9 for US-incorporated entities, W-8BEN for non-US), banking details, and a commercial entity (an LLC, C-corp, or equivalent).
   This is *not* the maintainer's personal identity; it is the publisher's commercial entity.
   See *Decision 4* below for the entity-vs-personal-identity question.
2. **APN (AWS Partner Network) enrollment** (prerequisite for some private offer features and CPPO).
   Free for the Public tier; required if any commercial pricing variant is used.
3. **AMI hardening verification.**
   The Packer template's hardening steps all pass:
   - HVM virtualization, x86-64 or ARM64, EBS-backed, unencrypted EBS snapshots, source AMI in `us-east-1`, no per-region variants in the source.
   - No hardcoded secrets, no pre-seeded SSH keys, no system / service passwords (even hashed), no private keys, no credentials.
   - `sshd_config` sets `PasswordAuthentication no`.
   - No AWS-credential requests in the image; minimally-privileged IAM role assigned to the instance via the marketplace launch template.
   - AMI passes the marketplace scanner with no vulnerabilities; no end-of-life OS or software; AMI is not older than two years from creation date.
4. **Self-service AMI scanner pass.**
   In the Marketplace Management Portal, "Test Add Version" with the Packer-built AMI; the scanner runs in under an hour.
5. **MeterUsage dimensions defined.**
   Four dimensions: `computrons`, `cogitrons`, `bytes_stored`, `bytes_network`.
   Pricing per dimension is set at this step; future price changes require 90-day notice.
6. **Submission via Build tab.**
   Initial publication is 7-10 business days when no errors are surfaced.
   Calendar tax is 2-4 weeks for the first listing.
7. **Limited state.**
   Visible only to the publisher and an optional allow-listed test set.
   This design recommends a 7-day limited-state validation pass before requesting public publication.
8. **Public publication.**
   "Request Update Visibility"; AWS Seller Operations reviews and clones the AMI per-region.

**Fees applicable to the AMI shape:**

- 20% AWS server fee on AMI revenue (highest of the three product-type fee rates; SaaS is 3%, Data Exchange is 3%).
- 0.5% CPPO uplift on Channel Partner Private Offers; not applicable to public listings.
- South Korea regional uplift +1% effective 2025-04-01; applicable when buyers are South Korea AWS accounts.
- Net 60 payment terms (AWS pays the seller 60 days after each transaction; slower than Azure and GCP, which pay Net 30-45).

**Customer onboarding flow** (the buyer experience this design's plan produces):

1. Buyer searches AWS Marketplace, finds "Endo Capability Bridge" listing.
2. Buyer subscribes; AWS associates the buyer's account with the publisher's product code.
3. Buyer clicks "Launch via CloudFormation" or "Launch with EC2 Console"; an EC2 instance launches from the cloned-to-buyer-region AMI.
4. Instance boots; `endo-firstboot.service` runs once.
5. First-boot ceremony generates the operator's root bearer, writes it to the AWS instance console output (per G-firstboot's delivery channel decision), and provisions the Caddy TLS certificate via the vendor-delegated DNS API.
6. Buyer retrieves the bearer from the AWS console output, navigates to `https://<node-id>.nodes.endo.example.com`, authenticates with the bearer in the Chat UI, performs the OAuth bond (deferred to v1.1), creates a Lal agent, retrieves the MCP configuration block per [endo-gateway-mcp](endo-gateway-mcp.md) § Affordance 2, and pastes the block into their MCP client.
7. The MCP client (Claude Desktop, Cursor, etc.) connects to the Bridge over HTTPS; the agent runs against the GitHub OAuth adapter and demonstrates the capability-attenuation value proposition.

## Cross-design coordination

The four named design gaps already on the books:

| Gap | Blocker for AWS submission? | This design's stance |
|-----|------------------------------|----------------------|
| `gateway-oauth-bonding` | **No.** | Ship MVP on bearer-token auth; OAuth bonding is a v1.1 follow-up. The Chat-side affordance from [endo-gateway-mcp](endo-gateway-mcp.md) gives the operator the bearer; OAuth bonding makes the future-bearer-retrieval-after-loss flow tractable but is not a launch requirement. |
| `gateway-key-recovery` | **No.** | Recovery depends on OAuth bonding being implemented; both ship in v1.1. For O1.a, key loss means the operator launches a fresh instance and re-bonds; this is acceptable for an MVP because state custody (G-state-custody) is itself a v1.1 deliverable. |
| `gateway-stripe-adapter` | **No (different billing channel).** | The AWS AMI bills via MeterUsage, not Stripe. Stripe is the self-host billing channel and is independent of the marketplace listing. The Stripe adapter can ship on any schedule that suits the self-host customer base. |
| `gateway-resource-classes` | **Yes (irreversible decision).** | The MeterUsage dimension names are locked at publication. `gateway-resource-classes` must be authored, panel-reviewed, and merged to `llm` before the AWS submission. This design recommends the four-class starting set (`computrons`, `cogitrons`, `bytes_stored`, `bytes_network`); the gap design ratifies or revises. |

The three additional gaps from the O1 critical path that are also marketplace blockers, added to the table above:

| Gap | Blocker for AWS submission? | This design's stance |
|-----|------------------------------|----------------------|
| `gateway-first-boot-ceremony` (G-firstboot) | **Yes.** | AWS forbids hardcoded secrets; the operator's initial bearer must be generated at first boot and delivered out-of-band. The design must specify the delivery channel (instance console output / serial console / one-time token via instance tags). |
| `gateway-bundled-tls` (G-tls-firstboot) | **Yes.** | The gateway refuses TLS by design; a marketplace AMI must terminate TLS inside the image. Pattern 1 (vendor-delegated CNAME) is recommended; see *Decision 5* below. |
| `gateway-marketplace-listing` (G-marketplace) | **Yes (this design subsumes it).** | This design *is* the marketplace-listing design for AWS. G-marketplace was originally a placeholder for "what does an AWS submission require"; this design fills that placeholder for AWS specifically. Azure and GCP marketplace-listing designs are O1.b siblings. |

## Decision Points

The five decisions this design takes a stance on; the maintainer ratifies or vetoes each in a single pass.

### Decision 1: Single-AMI at launch, AMI+CFT as graduation

**Stance:** the first listing is a Single-AMI product (one EC2 instance per buyer subscription, no surrounding AWS resources).
[gateway-aws-deployment](gateway-aws-deployment.md)'s ALB + ASG + Terraform topology pulls into the listing as an AMI+CFT graduation in O1.b or later, not at launch.

**Reasoning:** the single-AMI shape is the simplest review pipeline, has the lowest buyer-side prerequisites, and maps directly onto the targeted buyer experience: click "deploy" and receive a running Endo agent sandbox in their own cloud account.
The AMI+CFT shape becomes attractive once the Bridge wants ALB / IAM / S3 / DynamoDB provisioned alongside, which is post-MVP scope.

### Decision 2: Custom Metering at launch, not Paid Hourly

**Stance:** ratify Custom Metering with the four resource-class dimensions named above.
The publisher commits to the dimension-name lock at first publication.

**Reasoning:** Paid Hourly is simpler and reversible but does not allow per-cogitron or per-byte-network billing, and the project's inference-aware billing posture treats those dimensions as first-class.
Shipping on Paid Hourly first and adding Custom Metering as a follow-up listing means publishing the product twice through the 2-4 week review pipeline; shipping Custom Metering from day one with conservative dimensions means one review pipeline and a billing model that matches the strategic posture.
The 15-character alphanumeric dimension-name limit is the binding constraint; all four recommended dimensions fit (max 12 characters).
`gateway-resource-classes` is the design that finalizes the names.

**Considered and rejected:** Paid Hourly + Custom Metering as v1.1.
Reason: doubles the listing-review calendar tax and ships a billing model out of step with the project's billing posture on day one.

### Decision 3: GitHub as the first service adapter

**Stance:** the first MVP service adapter is GitHub OAuth, bundled in the AMI.

**Reasoning:** GitHub is an attractive demo because, despite having fine-grained tokens, it still lacks sufficiently narrow roles for an agent acting on a single repository.
That gap pre-positions the marketing narrative: the Capability Bridge gives an agent narrower-than-GitHub-tokens authority over a specific GitHub repository.
Gmail and Slack are more familiar to a general audience but require Google / Slack OAuth client registration that adds a calendar-tax to the MVP submission.
GitHub OAuth client registration is one form and one approval; Gmail and Slack ship as v1.1 second-and-third adapters.

**Considered and rejected:** Gmail as first adapter.
Reason: Google OAuth client registration is slower (verification + audit for sensitive scopes); the marketing alignment is also weaker because Gmail's permission scopes are already narrowable.

### Decision 4: Commercial entity for the marketplace seller identity

**Stance:** the publisher must register a commercial entity (LLC or equivalent) as the AWS Marketplace seller; the maintainer's personal identity is *not* the seller.
This design surfaces the question as a hard blocker on submission; the maintainer's call is which entity and on what timeline.

**Reasoning:** the project's existing credentials model routes upstream-project authority through the maintainer's personal identity, which is appropriate for code review and upstream PR authorship.
Marketplace seller registration is a tax-and-banking commitment with liability implications (the seller is the legal party in the AWS-buyer transaction).
Conflating the personal and commercial identities for marketplace purposes exposes the maintainer to liabilities the project does not yet have a posture on (and which G-operator-liability is the survey-only design that should inform the eventual posture).

**Considered and rejected:** personal-identity seller registration.
Reason: combines personal liability with commercial transactions in a way that is hard to unwind once the listing has revenue.

### Decision 5: Accept the non-custodian-spirit contradiction for vendor-delegated DNS

**Stance:** the publisher commits to running a DNS provisioning service for every issued node for that node's lifetime, accepting that this contradicts the project's "we are not the custodian" framing in spirit.
G-tls-firstboot's design dispatch should surface a bring-your-own-domain mode as an opt-in alternative for operators who want to avoid the vendor's DNS commitment.

**Reasoning:** the alternative patterns (TOFU self-signed, operator-brings-domain DNS-01) degrade the "click deploy and get a running node" UX:

- TOFU self-signed requires the operator to accept a self-signed certificate at first connection, which most browsers warn aggressively against and most MCP clients refuse outright (the bearer is in a HTTP header; a self-signed certificate is rejected by `fetch` in strict mode).
- Operator-brings-domain DNS-01 requires the operator to own a domain and configure DNS provider credentials at first boot, which is a 30-minute commitment incompatible with the MVP positioning.

The custodian-spirit contradiction is narrow: the publisher does not custody the *user's data or capabilities* (the gateway's state, formula store, CAS, bearer, OAuth bondings are all in the operator's AWS account).
The publisher custodies *DNS certificate issuance* for the node's vendor-delegated subdomain, which is a narrower commitment than the project's "self-custodial" framing precludes.

A future enhancement is *operator-portable nodes*: the operator brings their own domain post-launch and the node transitions from `<node-id>.nodes.endo.example.com` to `<operator-domain>`.
This is out of scope for the first listing and is a v1.1+ design.

**Considered and rejected:** bring-your-own-domain as the only first-listing TLS pattern.
Reason: degrades the MVP positioning to operators who already own a domain and know how to configure DNS-01 ACME, which is a small fraction of the target audience.

## Open Questions for the maintainer

The open questions carry forward, with this design's recommended answers attached.
The maintainer's call on each is recorded under the question, or "defer to G-X" when the answer flows from a sibling design dispatch.

1. **SaaS vs AMI as the MVP shape.** This design recommends AMI; the self-custodial MVP positioning and the O1 critical path both rule out SaaS for O1.
2. **Single-AMI vs AMI+CFT at launch.** See *Decision 1* above; recommends single-AMI, with AMI+CFT as O1.b graduation.
3. **MeterUsage dimensions: lock now or defer Custom Metering?** See *Decision 2* above; recommends Custom Metering with four conservative dimensions.
4. **Vendor-delegated DNS for TLS first-boot: operational commitment.** See *Decision 5* above; recommends accept-the-contradiction with a future bring-your-own-domain opt-in.
5. **Marketplace listing as the "vendor" identity.** See *Decision 4* above; recommends commercial entity, distinct from the maintainer's personal identity.
6. **Service-adapter choice for MVP demo clarity.** See *Decision 3* above; recommends GitHub for first adapter.
7. **First-boot bearer delivery channel.** AWS instance console output is the most operator-accessible channel (the buyer can read it from the AWS Console without SSH access).
   Serial console requires SSH key configuration that contradicts AMI hardening.
   One-time token via instance tags requires the buyer to read tags from the EC2 console.
   This design recommends *AWS instance console output* as the default channel; G-firstboot's design dispatch ratifies or revises and specifies the exact write mechanism (`logger -p user.info "...token..." > /dev/console` vs. `echo "..." > /dev/ttyS0`).
8. **Limited-state validation duration.** The 7-day limited-state validation pass named in the submission checklist above is a recommendation, not an AWS-imposed minimum.
   A shorter validation (24-48 hours) is acceptable if the publisher is confident; a longer validation reduces the risk of post-publication issues.
   Maintainer's call.
9. **Continuous-compliance threshold.** AMIs older than 2 years are disallowed in new subscriptions.
   Until G-upgrade ships, the publisher must re-submit the AMI through the 2-4 week review pipeline before the AMI hits 2 years.
   A 12-month cadence (recommended in the *Phase O1.a* deferred-items list) gives a 12-month safety margin.
   Maintainer's call on cadence.
10. **APN enrollment timing.** APN enrollment is a prerequisite for some private offer features and for CPPO; the first public AMI listing does not require it.
    Recommend enrolling in APN during O1.a regardless (free, opens future commercial options), but flagging in case the commercial-entity registration timeline pushes APN enrollment to O1.b.
11. **AMI architecture: ARM64 only or x86-64 + ARM64?** [gateway-aws-deployment](gateway-aws-deployment.md) names `c7g.large` (ARM Graviton) as the first cut.
    Marketplace listings can support multiple architectures.
    Shipping ARM64 only constrains the buyer audience (some buyers are AWS-x86-only environments).
    Shipping both architectures doubles the Packer build and AMI scanner pass per submission.
    Recommend ARM64-only for O1.a, x86-64 as a v1.1 follow-up; maintainer's call.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [endo-gateway-mcp](endo-gateway-mcp.md) | The MCP termination surface that is the first user-facing value proposition of the AMI. First priority on the O1 critical path. |
| [gateway-aws-deployment](gateway-aws-deployment.md) | The deployment topology that graduates the single-AMI listing into AMI+CFT in O1.b or later. Not yet merged to `llm`; this design treats it as Proposed-on-branch and recommends merging to `llm` as a precondition for the graduation step. |
| [gateway-packaging-ci](gateway-packaging-ci.md) | The CI workflow that builds the `.deb` the AMI installs. Not yet merged to `llm`; same merge-to-`llm` open decision. |
| [gateway-bearer-token-auth](gateway-bearer-token-auth.md) | The bearer-token model the MVP ships on; OAuth bonding is a v1.1 follow-up. |
| `gateway-first-boot-ceremony` (G-firstboot, to be authored) | The first-boot bearer-delivery design; a blocker for AWS submission. |
| `gateway-bundled-tls` (G-tls-firstboot, to be authored) | The bundled-Caddy + ACME first-boot design; a blocker for AWS submission. |
| `gateway-resource-classes` (G-resource-classes, to be authored) | The MeterUsage dimension-name design; a blocker for AWS submission. |
| `gateway-state-custody` (G-state-custody, to be authored) | The state export / restore / migration design; a v1.1 (O1.b) blocker for the "credible exit" claim. |
| `gateway-upgrade-channel` (G-upgrade, to be authored) | The TUF-shaped signed-update design; a continuous-compliance requirement, deliverable in O1.c. |
| `gateway-operator-observability` (G-observability, to be authored) | The metrics-without-surveillance design; a v1.1 (O1.b) production-readiness deliverable. |

## Affected Designs

| Design | Relationship |
|--------|-------------|
| [endo-gateway](endo-gateway.md) | The system-service Gateway design this publishing path wraps. No structural change required. |
| [endo-gateway-mcp](endo-gateway-mcp.md) | Updates the MCP endpoint to bind on `127.0.0.1:3469` behind the bundled Caddy proxy on `:443`; no design text change required (the design already names the reverse-proxy assumption). |
| [gateway-bearer-token-auth](gateway-bearer-token-auth.md) | The MVP ships on this auth model; OAuth bonding is a v1.1 layer on top. No structural change. |
| [daemon-docker-selfhost](daemon-docker-selfhost.md) | The container product type is the natural second listing (post-AMI); the self-host shape this design produces also supports the container listing in O1.b or later. |
| [familiar-release](familiar-release.md) | The desktop release flow is orthogonal to the marketplace listing; mentioning for completeness because it is one of the absent-from-`llm` designs the publishing path does not depend on. |

## Prompt

> Please dispatch a designer to research and propose a path with concrete steps toward publishing an artifact for use in the Amazon Marketplace, based on the Endo Gateway.
