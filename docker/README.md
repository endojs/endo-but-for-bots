# Endo Daemon Docker Image

Build the self-host image from a checkout with workspace dependencies
installed:

```sh
docker/build-daemon-image.sh endojs/daemon:latest
```

Run it with a named volume for daemon state:

```sh
docker run -d \
  --name endo-daemon \
  -p 8920:8920 \
  -v endo-state:/data/endo \
  endojs/daemon:latest
```

The container stores persistent state under `/data/endo`, binds the gateway to
`0.0.0.0:8920`, enables `ENDO_GATEWAY=remote`, and serves the built Chat UI
from the gateway root.
Open `http://localhost:8920/#agent=<agent-id>` after reading the root agent id
from the container state:

```sh
docker exec endo-daemon cat /data/endo/state/root
```

For internet exposure, place a TLS-terminating reverse proxy in front of the
container.
The agent id in the URL fragment is a bearer token for that agent profile.
