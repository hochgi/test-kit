# @hochgi/test-kit-s3

## 1.1.0

### Behaviour change — body-derived ETags

ETag is now the MD5 of the stored body (quoted), matching real AWS
semantics for non-multipart objects. Previously it was a stable string
derived from the key, so rewriting a key with different bytes kept the
same ETag.

**Migration:** if a test pinned a key-derived ETag value, recompute it as
`"${createHash('md5').update(body).digest('hex')}"` (or assert relative
equality / inequality instead of absolute values).

### Added

- `MaxKeys` is silently capped at 1000 (real S3); values above 1000 no
  longer return oversized pages.
- Conditional requests: `IfMatch` / `IfNoneMatch` on Get/Head/Put
  (`PreconditionFailed` 412, `NotModified` 304).

### Not in this release

- Object versioning / `VersionId` — deferred; would require reshaping
  the per-key store.
