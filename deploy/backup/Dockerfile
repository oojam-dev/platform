# oojam backup service (SPEC §3.1, §3.3): pg_dump of both databases, nightly,
# plus optional off-box copies through rclone. Same Postgres build as the
# database, so pg_dump's version always matches the server's.
FROM postgres:17.11-trixie@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f

RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh

ENV TZ=UTC
# Not the postgres image's entrypoint: this container runs no server.
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
