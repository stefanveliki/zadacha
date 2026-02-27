# Merge Order — Rural Run Protocol Agent Branches

Merge into `main` in this order. Each step should be a merge commit
with tests passing before proceeding to the next.

## 1. Agent B — Bluetooth Transport

**Branch:** `origin/claude/agent-b-bluetooth-transport-MoTuy`

First merge because it has the fewest shared-file dependencies and no
awareness of `src/shared/types.ts`. Clean merge into bare `main`.

**Action required after merge:**
- Agent B defines its own `src/types/EventEnvelope.ts`. After merge,
  update its import to use `src/shared/types.ts` instead and delete
  the duplicate file.
- Agent B uses Jest (`jest.config.js`, `jest.setup.js`). Unify the
  test runner to Vitest after all merges, or keep both configs
  temporarily.

## 2. Agent C — WiFi Transport

**Branch:** `origin/claude/review-rural-run-docs-mxAMW`

Introduces `src/shared/types.ts` (the canonical shared types),
`vitest.config.ts`, and the WiFi transport adapter.

**Conflicts to resolve:**
- `package.json` — merge dependencies from both branches; reconcile
  `scripts.test` (Jest vs Vitest)
- `package-lock.json` — regenerate after merging `package.json`
- `tsconfig.json` — minor differences; Agent C's is the more complete
  version (adds `"lib": ["DOM"]`)
- `.gitignore` — trivial, take union of both

## 3. Agent D — Nostr Transport

**Branch:** `origin/claude/agent-d-nostr-transport-cB4SN`

Agent D's branch already includes Agent C's WiFi code identically, so
the WiFi files will merge cleanly. Adds `@noble/curves` and
`@noble/hashes` as production dependencies.

**Conflicts to resolve:**
- `package.json` — add `@noble/curves`, `@noble/hashes` deps
- `package-lock.json` — regenerate
- `src/shared/types.ts` — identical to Agent C's; no real conflict

## 4. Agent A — Identity Layer

**Branch:** `origin/claude/identity-layer-setup-dQRMp`

Identity layer has its own `src/identity/types.ts` for layer-specific
types (no conflict with shared types). Uses `@noble/curves ^1.4.2` and
`@noble/hashes ^1.4.0` — Agent D already brought in `^2.0.1`.

**Conflicts to resolve:**
- `package.json` — Agent A uses Jest and pins `@noble/curves ^1.4.2`.
  Upgrade to `^2.0.1` (already present from Agent D) and update any
  v1-specific API calls (`randomPrivateKey` → `randomSecretKey`, import
  paths need `.js` suffix in v2)
- `package-lock.json` — regenerate
- `tsconfig.json` — take the superset config
- `.gitignore` — trivial union

## 5. Agent E — Log (this branch)

**Branch:** `origin/claude/review-rural-run-docs-cinOF`

Depends on `src/shared/types.ts` and `@noble/curves`/`@noble/hashes`
which are already present after steps 2–4. Adds `fake-indexeddb` dev
dependency and the entire `src/log/` directory.

**Conflicts to resolve:**
- `package.json` — add `fake-indexeddb` to devDependencies
- `package-lock.json` — regenerate
- `src/shared/types.ts` — identical to Agent C's; no real conflict
- `tsconfig.json`, `vitest.config.ts` — identical to Agent C/D; clean

---

## Files that conflict across multiple branches

| File | Branches that modify it | Resolution strategy |
|------|------------------------|---------------------|
| `package.json` | All 5 | Merge dependencies additively; unify test runner |
| `package-lock.json` | All 5 | Delete and `npm install` after each merge |
| `tsconfig.json` | All 5 | Take Agent C/D's version (superset) |
| `.gitignore` | All 5 | Union of all entries |
| `src/shared/types.ts` | C, D, E | Identical content — merge cleanly |
| `vitest.config.ts` | C, D, E | Identical content — merge cleanly |
| `src/types/EventEnvelope.ts` | B only | Delete after merge; redirect to `src/shared/types.ts` |

## Post-merge checklist

- [ ] Unify test runner: migrate Agent A and B tests from Jest to Vitest
- [ ] Delete `src/types/EventEnvelope.ts` — use `src/shared/types.ts`
- [ ] Delete `jest.config.js` and `jest.setup.js` after migration
- [ ] Upgrade Agent A's `@noble/curves` imports from v1 to v2 API
- [ ] Run full test suite: `npx vitest run`
- [ ] Verify TypeScript compiles: `npx tsc --noEmit`
