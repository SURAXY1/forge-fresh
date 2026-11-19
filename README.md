[![Built for make.fun](https://make.fun/api/badges/github-core-clone-01/built-for-makefun.svg?repo=SURAXY1/forge-fresh)](https://make.fun/bounty/github-core-clone-01) [![Competition](https://make.fun/api/badges/github-core-clone-01/competition.svg?repo=SURAXY1/forge-fresh)](https://make.fun/bounty/github-core-clone-01) [![Earn on make.fun](https://make.fun/api/badges/github-core-clone-01/earn.svg?repo=SURAXY1/forge-fresh)](https://make.fun/bounty/github-core-clone-01)

# forge-fresh

A GitHub-compatible git forge in a single Node process, standard library
only, zero dependencies. One in-memory store backs four API surfaces:

- **Git smart HTTP** — `info/refs` advertisements (v0 and protocol v2),
  upload-pack v2 `ls-refs` and `fetch` (shallow, deepen, incremental),
  upload-pack v0 fetch, and receive-pack with report-status and
  fast-forward enforcement.
- **REST v3** — repositories, branches, tags, git refs, commits, contents
  (read/write/delete with sha checks), labels, issues, comments and pull
  requests (create/list/get/files/merge).
- **GraphQL** — `POST /api/graphql` with viewer/repository/issue/pull
  request queries, connections with cursors, introspection for the served
  types, and the create/close/merge/comment mutations.
- **MCP** — `POST /mcp`, JSON-RPC 2.0 with `server/discover` and the legacy
  `initialize` handshake, and tools for repositories, issues and pull
  requests acting on the same store.

## Running

```sh
node main.ts
```

The process expects `MAKEFUN_ENV_URL` (the environment endpoint it
registers its ephemeral port with) and serves until the environment
reports the trial done. The bearer token arrives as `MAKEFUN_SHOP_TOKEN`;
the token's owner identity is derived from the trial's published scenario
seed.

## Performance design

- A per-repository mutation epoch invalidates every cached view and git
  reply; `store.touch()` is the only way state changes, and it clears the
  repository's git cache, so a cached answer always matches the state it
  was computed from.
- Advertisements, `ls-refs` answers and fetch packs are memoised per
  repository epoch — a burst of concurrent clones is one pack build and
  fifty buffer copies.
- Each git object is parsed at most once (the parsed form rides on the
  object record) and deflated at most once (the packed form is cached).
  Pack parsing is the only place a consumed-length zlib read is used;
  every other inflate/deflate is the plain call.
- Serialised JSON views of repositories and issues are cached, so the
  hot read path is a map lookup; sort keys are computed once, outside
  comparators; hot loops avoid regex and `Date` construction.
- The HTTP layer splits URLs by hand and reuses pre-serialised constant
  payloads (the MCP tools list is one constant string).

## Layout

- `main.ts` — environment lifecycle: listen, register, serve, drain.
- `app.ts` — HTTP routing, auth, request ids.
- `git.ts` — smart HTTP: pkt-lines, advertisements, ls-refs, fetch planning, receive-pack.
- `gitcore.ts` — object model: hashing, parsing, packs, deltas, reachability, tree merge.
- `store.ts` — repositories, issues, pulls, global ids, merge logic.
- `views.ts` — REST JSON views with epoch/version-keyed serialisation caches.
- `rest.ts` — REST v3 routes.
- `graphql.ts` — tokenizer, parser and executor for the forge's schema.
- `mcp.ts` — JSON-RPC endpoint and tools.
- `scenario.ts` — the token owner's identity, derived from the published seed.
