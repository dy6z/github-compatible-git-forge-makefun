# GitHub-Compatible Forge

A standalone in-memory Git forge built for the make.fun `github-core-clone-01` bounty.

It implements:

- Git smart HTTP (`upload-pack` v2/v0 and `receive-pack` v0)
- GitHub-compatible REST v3 repository, issue, pull request, and contents APIs
- GitHub GraphQL v4 query and mutation shapes used by `gh`
- MCP Streamable HTTP tools over the same shared state

## Runtime

Node.js 22, standard library only. No install step, external service, or Git binary is required.

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with `MAKEFUN_ENV_URL/register`, serves until the suite returns `{"done": true}`, then exits cleanly.

## License

MIT
