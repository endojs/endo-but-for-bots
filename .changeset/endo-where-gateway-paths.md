---
'@endo/where': minor
---

Add `whereEndoGatewayState`, `whereEndoGatewayEphemeralState`, `whereEndoGatewayRegistrarSock`, and `whereEndoGatewayCache` to compute the host-scoped paths used by the Endo Gateway service.
The Endo Gateway is a per-host system-service Daemon configuration that HTTP-virtual-hosts OCapN to many users by relaying to per-user Daemons, per `designs/endo-gateway.md` (closes endojs/endo-but-for-bots#173).
The new functions mirror the per-user `whereEndoState` / `whereEndoEphemeralState` / `whereEndoSock` / `whereEndoCache` shape, but resolve to host-scope locations (Linux: `/var/lib/endo-gateway`, `/run/endo-gateway`, `/var/cache/endo-gateway`; Darwin: `/Library/Application Support/Endo Gateway`, `/var/run/endo-gateway`, `/Library/Caches/Endo Gateway`; Windows: `%PROGRAMDATA%\Endo Gateway`, named pipe `\\.\pipe\endo-gateway\registrar`).
Each function admits an explicit environment override (`ENDO_GATEWAY_STATE`, `ENDO_GATEWAY_EPHEMERAL_STATE`, `ENDO_GATEWAY_REGISTRAR_SOCK`, `ENDO_GATEWAY_CACHE`).
