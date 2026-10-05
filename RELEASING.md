# Releasing

All 13 packages publish to npmjs under the `@hochgi` scope, from the manual
**Release** workflow (`.github/workflows/release.yml`). That workflow runs the
full gate, then `scripts/publish-unpublished.mjs`, which publishes, in
dependency order, every `packages/*` whose `package.json` version is not on
npm yet, with provenance. A version that is already published is skipped, so
re-running after a partial failure is safe.

## Cutting a release

1. In the pull request that changes a package, bump that package's `version`
   (semver). If a sibling's peer range must move, bump it too.
2. Merge the pull request. Nothing publishes on merge.
3. Run the workflow: **Actions → Release → Run workflow**, or
   `gh workflow run release.yml`, then approve the `npm` environment deployment.
4. `node scripts/publish-unpublished.mjs --dry-run` (also run by CI) shows what
   the next release would publish.

## Authentication

Steady state is **npm trusted publishing**: npm trusts this repository's
`release.yml` running in the `npm` environment, through GitHub's OIDC token.
There is no long-lived npm secret.

A package cannot have a trusted publisher until it exists on npm, so a
package's **first** publish uses a short-lived token stored as the `NPM_TOKEN`
secret of the `npm` environment. When `NPM_TOKEN` is unset the script relies on
OIDC alone.

## One-time setup

### 1. npm account

1. Sign up at <https://www.npmjs.com/signup> with username **`hochgi`**. The
   username *is* the scope: `@hochgi/*` packages can only be published by the
   npm user (or org) named `hochgi`. If the name is taken, pick another and
   rename the scope in every `package.json` before the first release.
2. Verify the email address npm sends to.
3. **Account → Two-Factor Authentication**: enable it with an authenticator app
   or security key, for authorization *and* publishing.

### 2. GitHub environment

In the GitHub repository, **Settings → Environments → New environment**, name it
`npm`:

- **Required reviewers:** yourself, so every release waits for an approval.
- **Deployment branches:** `main` only.

### 3. First publish (token)

1. On npmjs: **Avatar → Access Tokens → Generate New Token → Granular Access
   Token**.
   - Expiration: 7 days.
   - Permissions: **Read and write (publish and stage)**, all packages (none
     exist yet). npm warns that direct publishing with such tokens ends in
     January 2027; that does not matter for a token that lives a week.
   - Tick **Bypass two-factor authentication (2FA)**. Without it the publish
     fails with `EOTP` ("This operation requires a one-time password"): CI
     cannot answer a 2FA prompt.
2. Store it as the environment secret (paste it at the prompt; it is never
   echoed):

   ```bash
   gh secret set NPM_TOKEN --env npm --repo hochgi/test-kit
   ```

3. Run the Release workflow and approve it. All 13 packages publish.

### 4. Switch to trusted publishing

`npm trust` (npm ≥ 11.5.1) configures the trusted publisher from the CLI. It
only works on a package that already exists, which is why step 3 comes first,
and it needs your interactive npm login with 2FA:

```bash
npm login
for p in test-kit test-kit-mock test-kit-sql test-kit-pglite-driver \
         test-kit-pg-kysely test-kit-pg-knex test-kit-pg-sequelize \
         test-kit-redis test-kit-bull test-kit-s3 test-kit-sqs \
         test-kit-kafka test-kit-mysql; do
  npm trust github "@hochgi/$p" --file release.yml --repo hochgi/test-kit \
    --env npm --allow-publish -y
done
```

The same can be done on npmjs, per package, under **Settings → Trusted
Publisher → GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `hochgi` |
| Repository | `test-kit` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

Then, on each package's npmjs settings page, set **Publishing access** to
*Require two-factor authentication and disallow tokens*.

Finally remove the bootstrap token everywhere:

```bash
gh secret delete NPM_TOKEN --env npm --repo hochgi/test-kit
```

and revoke it under **Access Tokens** on npmjs.

A package added later repeats steps 3–4 for that package only: re-create a
short-lived `NPM_TOKEN`, release, add its trusted publisher, delete the token.
