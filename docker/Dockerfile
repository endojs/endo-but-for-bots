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

# Default environment for containerized operation.
# ENDO_STATE is the root; the entrypoint derives *_PATH vars from it.
# Users can override individual paths if needed.
ENV ENDO_STATE=/data/endo
ENV ENDO_ADDR=0.0.0.0:8920
ENV ENDO_GC=1

COPY docker/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
