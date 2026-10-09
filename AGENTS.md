# glassnode-api-ts-client: agent instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: setup, commands, the version and changelog rules,
and the design notes all live there. Before opening a PR, run the checks in its "Run the full
local check list" step.

## Don't

- Edit `test/fixtures/contract/` by hand: it holds recorded real API responses. A contract test
  failing there is API drift: fix the schema, never the fixture or the test.
- Run `scripts/record-fixtures.mjs`: it calls the live API with a real key and spends quota. Only
  a maintainer re-records the fixtures.
- Bump `@types/node` past the Node.js floor (`^22`), TypeScript to 7.x, or TypeScript past what
  `typedoc` lists: see "Toolchain pins" in CONTRIBUTING.md.
- Write extensionless or `.ts` relative imports in `src/`: they are `./foo.js`.
- Add a `browser` field or a `browser` condition in `exports`, even when `publint` suggests it.
- Add `.transform()` to `GlassnodeConfigSchema`, or set `tag` in `package.json` `publishConfig`.
- Expose the API key: logged URLs mask it, and hook payloads and error messages never carry it.
- Rename the `test` or `compat-node-floor` CI jobs (the rulesets require them by name), or
  reference an action by tag instead of a full commit SHA.
