# API explorer: endpoints found for you, requests in one click

Feedback #42 ("Insomnia/Postman + discover all endpoints automatically"), 2026-09-06.
Status: plan, 2026-10-01.

## Problem

Full-stack work in Sinfonie spans a backend and a frontend, but trying the backend means leaving for
Postman or Insomnia: you rebuild the request by hand, copy tokens around, and the collection drifts
from the code. The agent can't use those collections either.

## Goal

An **API** area for each space's backends that:

1. **Discovers the endpoints** from the code, from OpenAPI files, and from real traffic, without you
   writing a collection.
2. **Sends requests** to the workspace's running app, staging or production, with auth handled.
3. Is something the **agent can use too**: list endpoints, call them while developing, and keep the
   collection in sync when it changes a route.

## Discovery, in order of trust

| Source | How | Notes |
|---|---|---|
| OpenAPI / Swagger in the repo | Find `openapi.{yaml,json}`, `swagger.*`, and framework-generated specs (`/docs/openapi.json` on the running app) | Exact; preferred whenever present |
| Framework route scan | Static scan per framework: Express/Fastify/Hono, NestJS decorators, Next.js app/pages API routes, FastAPI/Flask, Django urls, Rails routes, Go net/http/chi/gin | Fast and offline; params and bodies are partial |
| Agent-assisted | A crew task reads the handlers and writes an OpenAPI document (request and response shapes, auth) for routes the scan found | Fills in bodies and types; reviewed like any change |
| Traffic | The in-app browser already sees requests over CDP (`browser/driver.ts` `Network.*`); captured calls to the app's own origin become examples | Real payloads; redact auth headers |

Results merge into one **endpoint list per repo**: method, path, params, body schema, examples, source
(spec / scan / agent / traffic) and a confidence label. A route that disappears from the code is marked
stale rather than deleted.

## Sending requests

- The request runs **in main** (no CORS, no browser), with a timeout and a size cap on the body shown.
- **Environments**: *This workspace* (the workspace's own port, from its run script), *Local*,
  *Staging* and *Production*, defined per space. Base URLs and variables are shared with the team;
  secrets live in the keychain, per person.
- **Auth**: bearer, basic, API key, cookie (from the in-app browser session), or a login request whose
  token is reused.
- **Safety**: anything that is not a GET to a local environment shows the full request and asks before
  it is sent; production writes always ask. This follows the "confirm what leaves the Mac" rule and the
  team guardrails.
- History per workspace, the response with timing, and a one-click "copy as curl".

## Collections and interop

- Saved requests and folders per space, versioned with the space definition (secrets excluded),
  so the team shares them like statuses and views.
- **Import** Postman v2.1, Insomnia v4 and OpenAPI 3; **export** OpenAPI and Postman.

## For the agent

- Tools: `api_endpoints(repo?)`, `api_request(env, method, path, body?)` (same safety rules: non-local
  or non-GET asks through the permission card), `api_examples(endpoint)`.
- After a turn that changed a route file, the scan reruns for that file, and the agent is told which
  endpoints changed, so it can update tests or the frontend call sites.
- Generated views (Home pages) get an `endpoints` source and a `sendRequest` action, so a team can pin
  a "health of our API" page.

## Phases

1. **Endpoints**: OpenAPI detection and the framework scan for the two most common stacks in your
   repos (Node/Express or Nest, and Python/FastAPI); an endpoint list under the workspace's Data area.
2. **Requests**: the runner in main, environments (workspace / local), auth, history, curl export,
   safety prompts.
3. **Agent**: the tools, rescan after route changes, agent-assisted OpenAPI for partial routes.
4. **Team and interop**: space collections, staging/production environments, Postman/Insomnia/OpenAPI
   import and export, traffic capture from the in-app browser, and a views source.

## Open questions

- Which stacks first? Proposal: look at the repos across your spaces (Lumepic's backend-services,
  perla-pli-api, …) and start with the frameworks they use.
- Is it a workspace tab (next to Data) or a space-level page? Proposal: a workspace tab bound to the
  workspace's running app, plus the space's collections in Team settings.
