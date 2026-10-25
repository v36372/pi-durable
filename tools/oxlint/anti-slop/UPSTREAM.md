# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: 13909c9e07590f5a85d93c62712259fe14a883f7
- Install: upstream `skills/install-anti-slop/scripts/install.mjs` copied the bundled plugin here.
- Verification: every copied source file matches this commit's canonical `src/` file. The installer omits upstream tests.
- Licenses: upstream MIT license in `LICENSE`. Nested Stylistic license and provenance remain in `vendor/eslint-stylistic/`.

## Local choices

Plugin source remains unchanged. `eslint.config.ts` enables all generic rules at error severity.
The `no-runtime-typeof` rule permits checks inside explicit type predicates, not arbitrary application branches.
Effect rules remain disabled because this application does not depend on Effect.

ESLint runs the compatible plugin because Oxlint's plugin allocator requests 6 GiB of virtual memory, which this VM rejects.
The parser adapter adds Oxc-compatible `start` and `end` offsets from ESTree `range` pairs.
Oxlint runs the native `no-accumulating-spread` companion rule separately, without JavaScript plugins.
No host memory settings change.

TypeScript 6.0.3 matches the parser's supported compiler range. Tool versions remain exact in package.json and package-lock.json.
