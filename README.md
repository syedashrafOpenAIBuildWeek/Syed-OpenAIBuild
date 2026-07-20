# Safe Metadata Delete

A review-first Salesforce admin tool for deleting custom fields and objects from a Lightning Home or App Page. Commands can be typed or dictated with browser-native Speech Recognition. The LWC calls a Node/Express service that reuses the existing `sf` CLI session for `hackathon-org`.

Planning is non-destructive: describe targets, block standard metadata, count object records, scan Tooling API dependencies, retrieve backups, and prepare AI-generated dependency-removal diffs. A one-time token and explicit approval click are required before deployment.

## Setup

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Set `CORS_ORIGINS` to the exact Lightning origin.
3. Optionally set `BACKEND_API_TOKEN` and put the same value in the component property.
4. Run `npm install`, then `npm run backend`.

The default backend/CSP URL is `http://localhost:3001`. Salesforce pages are HTTPS, so normal org use needs an HTTPS backend URL. Change both the App Builder `Backend URL` property and `force-app/main/default/cspTrustedSites/Safe_Delete_Backend.cspTrustedSite-meta.xml`.

No Salesforce OAuth flow, Named Credential, or new auth is used. The server always invokes `sf ... --target-org hackathon-org`.

## Safety pipeline

`POST /api/plan` uses `gpt-5.6` structured output, validates API names, describes objects/fields, blocks standard or missing targets, scans `MetadataComponentDependency`, checks incoming relationship dependencies, retrieves backups, and generates complete-file XML edits plus unified diffs.

Apex, Flow, and unknown dependencies stop that target. Layout, ListView, Report, ValidationRule, and FlexiPage dependencies are eligible for proposed edits. Incoming lookup/master-detail fields stop object deletion. Mixed requests continue only for eligible custom targets.

`POST /api/runs/:id/approve` requires the random token and `confirmed: true`. It dry-run deploys dependency fixes, deploys them, then performs a separate post-destructive deployment. On a post-backup failure, `POST /api/runs/:id/rollback` redeploys the backup.

Run artifacts are under gitignored `.safe-delete/runs/`. Restarting the backend intentionally invalidates pending approvals.

## Verification

```sh
npm run test:backend
npm run lint
npm run prettier:verify
```

Org deployment and destructive-path testing are intentionally not automated.
