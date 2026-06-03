# HTTPS terminating proxy compatibility

The Endo Gateway terminates plain HTTP only.
It does not implement TLS.
For public-facing deployments, an external reverse proxy (nginx, Caddy, Cloudflare, Traefik, AWS ALB, ...) terminates TLS in front of the gateway and reaches it over plain HTTP.

This document describes the deployment shape, the configuration the gateway expects from the operator, and example proxy fragments for the common front-end choices.
The full design rationale lives in
[`designs/gateway-package.md`](../../../designs/gateway-package.md) §
Feature 9.

## Why no TLS in the gateway

Two surfaces with two different security postures meet in this gateway.

The OCapN endpoint carries Noise-encrypted bytes per
[`designs/ocapn-noise-network.md`](../../../designs/ocapn-noise-network.md) and
[`designs/ocapn-network-transport-separation.md`](../../../designs/ocapn-network-transport-separation.md).
OCapN provides confidentiality and peer authentication in-band; HTTPS on the OCapN endpoint is defense-in-depth only.

The browser-facing endpoints (Chat, virtual-hosted weblets, Git over HTTP) transmit formula-identifier bearer tokens in HTTP headers (Git auth, Chat WS URL-fragment).
A passive observer on an unencrypted link would see them.
HTTPS is required for any public deployment.

The gateway implements neither.
It offers the parser and the trust gate for `X-Forwarded-*` headers, and it offers a startup warning when the operator binds publicly without configuring trust.
TLS termination, certificate management, ACME automation, and front-end policies (HSTS, OCSP stapling, cipher suites) are the operator's responsibility, performed at the reverse proxy.

## Trust model

A client can fabricate any header it wants, so a naive gateway that always believed `X-Forwarded-For` would let any caller masquerade as any client IP.

The gateway therefore trusts `X-Forwarded-*` headers only when the immediate TCP peer (the proxy in front of it) is inside the configured trusted-proxy CIDR allowlist.

```js
import { makeGateway } from '@endo/gateway';

const gateway = makeGateway({
  powers: {
    /* ... */
  },
  config: {
    bindAddress: '127.0.0.1:3469',
    trustedProxyCidrs: ['127.0.0.1/32', '10.0.0.0/8'],
    maxProxyHops: 1,
  },
});
```

Requests from outside the allowlist are treated as direct client requests.
The headers are ignored, the TCP peer is the caller, and the `Host` header is taken at face value.
This is fail-closed: an empty `trustedProxyCidrs` means no proxy is trusted.

`maxProxyHops` bounds how many entries in a comma-separated `X-Forwarded-For` list the gateway will walk.
A budget of `1` (the default) trusts only the immediate upstream's view of the caller.
With `maxProxyHops: 3` and a longer chain (`client, proxy1, proxy2, proxy3`), the gateway walks back three hops from the right and returns the leftmost.

## Startup warning

When the gateway binds to a non-loopback address with no trusted-proxy configuration, it emits:

```
[Gateway] Bound to 0.0.0.0:3469 with no trusted proxy configured.
Browser-facing endpoints transmit bearer tokens; ensure TLS termination if this gateway is reachable from the internet.
```

The warning fires once at `start()`.
Operators have three ways to resolve it:

- Bind to loopback (`127.0.0.1:3469` or `[::1]:3469`) for a local-development or in-host deployment.
- Configure `trustedProxyCidrs` for a deployment behind a known TLS-terminating proxy.
- Accept the warning if TLS termination is arranged some other way (a transparent network gateway, an SSH tunnel, etc.); the warning is informational, not blocking.

The warning sink defaults to `console.error`.
Embedders that want a different sink supply a `powers.logWarning` function.

## Reverse-proxy examples

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name endo-gateway.example.com;

    ssl_certificate     /etc/letsencrypt/live/endo-gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/endo-gateway.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3469;
        proxy_http_version 1.1;

        # WebSocket upgrade (OCapN at /ocapn-cbor-np, Chat sessions).
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Preserve the original request shape for the Feature 9
        # parser. The gateway's `trustedProxyCidrs` must include
        # this nginx host's source IP (127.0.0.1 when nginx and
        # gateway share the host).
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}

# Required for the Upgrade header above.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Pair with `trustedProxyCidrs: ['127.0.0.1/32']` in the gateway config when nginx runs on the same host.

### Caddy

```caddy
endo-gateway.example.com {
    reverse_proxy 127.0.0.1:3469 {
        # Caddy sets X-Forwarded-For, X-Forwarded-Proto, and
        # X-Forwarded-Host automatically; no explicit header_up
        # required for the Feature 9 surfaces.
    }
}
```

Caddy handles ACME automatically; the certificate appears on the first request to the configured site.

### AWS Application Load Balancer

The ALB sets `X-Forwarded-For` (a chain of `client, alb-ip`), `X-Forwarded-Proto` (`https` on the public side, `http` between ALB and target), and `X-Forwarded-Port`.
The ALB's listener-to-target connection is plain HTTP on the gateway's port; the ALB does not set `X-Forwarded-Host` by default (the original `Host` is preserved unchanged).

Configure the gateway with:

```js
trustedProxyCidrs: [
  // The ALB's subnet ranges. The exact CIDRs come from the VPC
  // configuration; this is illustrative only.
  '10.0.0.0/16',
],
maxProxyHops: 1,
```

When the ALB terminates HTTPS and forwards to the gateway over HTTP, the gateway sees `X-Forwarded-Proto: https` from the ALB and reports the original-client IP from `X-Forwarded-For`.

### Cloudflare

When Cloudflare proxies a hostname, it terminates TLS, sets `CF-Connecting-IP` to the original client IP, and adds standard `X-Forwarded-*` headers.
Configure the gateway with `trustedProxyCidrs` covering [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/) (the list rotates; subscribe to their updates if you depend on it).

The gateway's `parseForwardedRequest` does not read `CF-Connecting-IP` specifically; the standard `X-Forwarded-For` covers the common case.

## Security reasoning

The trust gate is the single defense against header forgery.
Without it, any client could set `X-Forwarded-For: 127.0.0.1` and impersonate localhost in any downstream component that reads the parsed caller IP (rate limits, audit logs, abuse heuristics).
The default empty allowlist enforces this even when an operator forgets to think about the case; the public-bind warning trains operators to think about it.

The browser-facing bearer tokens are the most sensitive cargo through this gateway.
A passive observer on an unencrypted link captures them and replays them at leisure.
TLS termination at the proxy is the defense; the gateway warns when it has no evidence one is in place.

Closing notes:

- The `X-Forwarded-*` parser does not validate the recovered `callerIp` is a routable IP; it forwards what the trusted proxy supplied.
  A misconfigured proxy that passes garbage in `X-Forwarded-For` is a proxy-side bug.
- `X-Forwarded-Proto` is only ever `http` or `https` in the gateway's view.
  Unrecognized values collapse to `http` (the safe default given the gateway never terminates TLS itself).
- The gateway never serves redirects to `https://`.
  The proxy is responsible for HSTS, `Strict-Transport-Security`, and any HTTP-to-HTTPS redirect chain.

See [`designs/gateway-package.md`](../../../designs/gateway-package.md) § Feature 9 for the design's full framing.
