# Publishing Guide

This guide covers how to release a new version of `@runeauth/sdk` to npm.

> **Only maintainers with npm org access can publish.**

---

## Pre-publish Checklist

Before every release:

```bash
# 1. All tests must pass
pnpm test:all

# 2. TypeScript must be clean
pnpm run typecheck

# 3. No uncommitted changes
git status   # should be clean

# 4. You are on main and up to date
git checkout main && git pull
```

---

## Version Numbering

Follow [Semantic Versioning](https://semver.org/):

| Change | Example | Version bump |
|---|---|---|
| Bug fix | Fix timeout error | `1.0.2 → 1.0.3` |
| New feature (backward compatible) | Add `rune.batch()` | `1.0.2 → 1.1.0` |
| Breaking change | Rename `can()` to `check()` | `1.0.2 → 2.0.0` |

**Rule:** Never break existing callers in a patch or minor release.

---

## Releasing a New SDK Version

### Step 1 — Make and commit your changes

```bash
git checkout -b chore/release-1.1.0
# ... make changes to packages/sdk/src/ ...
pnpm test:all && pnpm run typecheck
git add -A
git commit -m "feat: add batch check endpoint to SDK"
```

### Step 2 — Bump the version

```bash
cd packages/sdk

# Patch (bug fix): 1.0.2 → 1.0.3
npm version patch --no-git-tag-version

# Minor (new feature): 1.0.2 → 1.1.0
npm version minor --no-git-tag-version

# Major (breaking): 1.0.2 → 2.0.0
npm version major --no-git-tag-version
```

### Step 3 — Commit the version bump

```bash
cd /path/to/rune   # back to project root
git add packages/sdk/package.json
git commit -m "chore: bump @runeauth/sdk to 1.1.0"
git push origin chore/release-1.1.0
```

Open PR → merge to main.

### Step 4 — Publish to npm

```bash
# Make sure you're authenticated
# Token must be in ~/.npmrc:
# //registry.npmjs.org/:_authToken=npm_YOUR_TOKEN_HERE

cd packages/sdk

# Dry run first — verify what will be published
npm publish --dry-run

# Publish for real
npm publish --access public
```

### Step 5 — Verify on npm

```bash
npm view @runeauth/sdk version
# should show new version

# Or check: https://www.npmjs.com/package/@runeauth/sdk
```

---

## npm Auth Setup

Get your token from **[npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)**:

1. Generate New Token → **Granular Access Token**
2. Permissions: **Read and Write**
3. ✅ Check **"Allow this token to bypass two-factor authentication"**
4. Copy the token

Save it to `~/.npmrc` (outside the project, never commit this):

```bash
echo "//registry.npmjs.org/:_authToken=npm_YOUR_TOKEN_HERE" > ~/.npmrc
```

> ⚠️ Run this from your home directory (`~`), not from inside the pnpm workspace.

---

## What Gets Published

Only these files are included (defined in `packages/sdk/package.json` → `files`):

```
dist/          # compiled JavaScript + TypeScript declarations
README.md      # shown on npmjs.com
LICENSE        # MIT
package.json   # package metadata
```

Source files, tests, and `.env` are **never** published.

Verify what will be published without actually publishing:
```bash
cd packages/sdk && npm publish --dry-run
```

---

## Engine Releases (GitHub only)

The engine is self-hosted — there's no npm publish for it. To release a new engine version:

1. Merge all changes to `main`
2. Create a GitHub release tag:
   ```bash
   git tag v1.1.0 -m "Release v1.1.0 — adds batch endpoint"
   git push origin v1.1.0
   ```
3. Create a GitHub Release from the tag with release notes
4. Users pull the new version: `git pull && pnpm install && pnpm dev`
