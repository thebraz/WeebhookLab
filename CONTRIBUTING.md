# Contributing

Use Node.js 22.13+ and npm. The project uses TypeScript with strict checking, Fastify, React, and the SQLite API bundled with Node.

```sh
npm ci
npm run dev
```

The inspector runs on loopback port 5173 and capture/API on 5050. Backend changes require restarting development. Production build and capture share port 5050 with `npm run build` followed by `npm start -- --no-open`.

## Structure

- `src/server`: HTTP capture, SQLite storage/migrations, workspace API, replay, SSE, CLI.
- `src/shared`: contracts and pure debugging/redaction engines.
- `src/web`: React inspector, request editor, comparison and configuration views.
- `tests`: local HTTP, database, migration, payload and release tests.
- `scripts`: development launcher and clean package validation.
- `examples`: deterministic local webhook demo.

## Checks

Before proposing a change:

```sh
npm run lint
npm run typecheck
npm test
npm run test:package
```

The package check includes the production build and isolated tarball install. Tests require loopback socket access; package installation needs the npm registry or a populated cache. Temporary package installations remain in `.release-validation`, excluded from version control and the npm package.

Keep changes focused. Preserve raw request bytes, duplicate headers/query, workspace associations, stored data, and API contracts. Validate incoming configuration and report errors without printing payloads or secrets. Add regression coverage for behavioral fixes; use real local receivers for replay and no external services. Avoid dependencies where the platform or existing modules suffice. Follow the existing TypeScript and React conventions.

Pull requests should explain the user-visible problem, resulting behavior, relevant validation, and any migration or compatibility impact. Do not include local databases, real captured webhooks, credentials, private notes, or generated caches. Report bugs with Node/OS versions, steps, expected/actual behavior, and a sanitized example.

The project is published at https://github.com/thebraz/WeebhookLab under the MIT license.
