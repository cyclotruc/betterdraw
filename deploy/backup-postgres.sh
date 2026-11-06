#!/bin/sh
# Nightly Postgres dump, kept 14 days. With BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET and BACKUP_S3_ACCESS_KEY_ID /
# BACKUP_S3_SECRET_ACCESS_KEY set, each dump is also uploaded with plain curl.
set -eu
dir=/backups
stamp=$(date -u +%Y%m%d-%H%M%S)
file="$dir/betterdraw-$stamp.sql.gz"
pg_dump -h db -U betterdraw betterdraw | gzip > "$file"
find "$dir" -name 'betterdraw-*.sql.gz' -mtime +14 -delete
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  curl -fsS --aws-sigv4 "aws:amz:${BACKUP_S3_REGION:-auto}:s3" --user "$BACKUP_S3_ACCESS_KEY_ID:$BACKUP_S3_SECRET_ACCESS_KEY" \
    -T "$file" "$BACKUP_S3_ENDPOINT/$BACKUP_S3_BUCKET/$(basename "$file")"
fi
echo "backup: $file"
