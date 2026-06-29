FROM node:22-slim

WORKDIR /opt/endo

ENV NODE_ENV=production
ENV ENDO_STATE=/data/endo
ENV ENDO_STATE_PATH=/data/endo/state
ENV ENDO_EPHEMERAL_STATE_PATH=/data/endo/run
ENV ENDO_CACHE_PATH=/data/endo/cache
ENV ENDO_SOCK_PATH=/data/endo/run/endo.sock
ENV ENDO_ADDR=0.0.0.0:8920
ENV ENDO_GATEWAY=remote
ENV ENDO_CHAT_DIST=/opt/endo/chat
ENV ENDO_WORKER_SUBPROCESS_PATH=/opt/endo/bundles/worker-node.cjs

COPY bundles/ ./bundles/
COPY chat/ ./chat/
COPY docker-entrypoint.sh /usr/local/bin/endo-docker-entrypoint

RUN chmod +x /usr/local/bin/endo-docker-entrypoint \
  && mkdir -p /data/endo/state /data/endo/run /data/endo/cache \
  && chown -R node:node /data/endo /opt/endo

VOLUME ["/data/endo"]
EXPOSE 8920

USER node

ENTRYPOINT ["/usr/local/bin/endo-docker-entrypoint"]
