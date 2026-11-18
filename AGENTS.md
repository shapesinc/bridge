# Bridge contributor and agent instructions

## This is a public open-source repo

shapes.inc Bridge is open source (MIT), and shapes.inc also ships it inside its Mac and Windows apps. Everything committed here, including docs, comments, test fixtures, commit messages and PR descriptions, is public. Write it for an outside contributor.

Never commit:

- secrets, tokens, real device credentials, or real user, account or chat data (fixtures must be synthetic)
- backend model names, gateway limits, provider pricing, credit or revenue figures
- $/day cost projections, traffic numbers or eval spend
- commit SHAs, build numbers or links from private shapes.inc repos, internal dashboards, or prod data
- QA run logs, GO/NO-GO release gates, or acceptance status for unreleased builds
- names, personal machine paths or emails of team members or users

Put those in the private repo instead: `shapesinc/app` under `architecture/bridge-internal/`, or the internal PR that consumes the Bridge change. Docs here should describe contracts and behavior: what an endpoint accepts, what a receipt means, how cancellation works.

## Working in this repo

- Work in a dedicated Git worktree based on current `origin/main`; preserve other worktrees and branches. Use the machine-wide heavy-job lock for native builds and record ownership/cleanup. Never stop another task's services.
- Keep discovery, connection, execution, status and cancellation composable. Preserve account/device/chat authorization, funding, provenance, idempotency and cancellation. Changes that add AI calls or context need a full incremental USD/day projection before implementation. Write it in the internal PR or `architecture/bridge-internal/`, not in this repo.
- Run focused checks for changed boundaries. For package-version/docs-only releases, run `node --test test/package-bin.test.js` and `npm pack --dry-run`; do not repeat unchanged heavy suites. CI still runs its configured checks. Product changes require actual affected UI/runtime verification and honest remaining gaps.
- Contributor-facing guidance is in [CONTRIBUTING.md](CONTRIBUTING.md); security reports follow [SECURITY.md](SECURITY.md).

## Standalone and native releases are separate

- A Bridge merge or a shapes.inc native-app release does **not** publish the standalone Bridge GitHub asset. This repo currently automates CI only; there is no automatic release workflow or npm-registry publication contract.
- Source installs and updates fetch `main`; macOS signed installs fetch GitHub's **latest** `shapes.inc-Bridge-macos.zip`. A passing PR or a release tag alone does not update that asset.
- Use an unused numeric `major.minor.patch` version. Keep `package.json`, the signed bundle's nested runtime package and bundle versions, and `v<version>` aligned. Never modify a signed bundle to relabel it.
- The standalone installer rejects a signed helper older than itself; the bundled installer rejects downgrading a newer installed helper. Coordinate the native pin/release and standalone asset at the same helper version so either entry point can reconnect. Modern app-owned state remains separate; do not migrate credentials or grants as part of packaging.
- **Do not merge a bumped installer onto `main` before the compatible signed latest asset is available.** Prepare a reviewed release-candidate commit and a draft release/tag at that exact commit; build/sign/notarize/staple using `scripts/build-mac-release.sh`. Publish the compatible native app first, then the verified standalone asset/checksum, verify the public latest download, and only then merge the version metadata PR. Keep unrelated runtime changes out of the release candidate.
- Public artifacts must pass exact source/version and both-architecture checks, strict signatures/team identity, notarization/stapling and Gatekeeper checks. Include the script-generated ZIP checksum and a disposable signed-installer minimum-version check. `SKIP_NOTARIZE=1` is not a public release.
- Instead of compiling twice, the standalone asset may reuse the unchanged helper from a completed native release built from the exact reviewed Bridge commit/version. Verify the accepted notary ticket and staple an extracted copy if needed; never re-sign, relabel or change its runtime. Archive that verified helper and generate its checksum. Bundled-installer smoke tests must isolate home/state and simulate global service-manager calls: a custom state directory alone does not isolate `stopService`. Keep signature, copy and version checks real and label the service-manager simulation.
- Record commit/tag, native pin/release, asset hashes, validation and public latest-download proof. Do not claim rollout from a draft upload or CI alone. Tagging, publishing, merging and production changes require authorization from the current task; existing explicit authorization remains valid.

See [Releasing the macOS app](docs/releasing.md) for the supported build and publication sequence.
