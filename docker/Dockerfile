FROM node:22-slim

WORKDIR /opt/endo

# Install the Endo CLI globally.  In production, this would be replaced
# with pre-built bundles copied from the build stage.
# For now, we install from the local workspace.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn
COPY packages packages

# Install dependencies (production only)
RUN corepack enable && yarn install --immutable

# State directory — mount a volume here for persistence.
VOLUME /data/endo

# Gateway port
EXPOSE 8920

# Default environment:
#   ENDO_ADDR — bind address for the gateway (0.0.0.0 for Docker)
#   ENDO_STATE_PATH — state directory path
#   ENDO_GC — enable formula garbage collection
ENV ENDO_ADDR=0.0.0.0:8920
ENV ENDO_STATE_PATH=/data/endo
ENV ENDO_GC=1

COPY docker/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
