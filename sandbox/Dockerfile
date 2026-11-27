ARG AGENTRITE_IMAGE
FROM ${AGENTRITE_IMAGE}

# rsync, which agent/src/backup.js runs to pull the server's dumps, and which agent/test/backup.test.js runs for real.
# The kit's image does not have it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends rsync \
    && rm -rf /var/lib/apt/lists/*
