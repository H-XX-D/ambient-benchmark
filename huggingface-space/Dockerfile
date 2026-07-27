FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node . /app

ENV NODE_ENV=production \
    PORT=7860 \
    AMBIENT_SPACE_ROOT=/tmp/ambient-space

USER node
EXPOSE 7860

CMD ["node", "space-app/server.mjs"]
