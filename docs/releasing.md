# Releasing the macOS app

Moved from the README. See also [AGENTS.md](../AGENTS.md#standalone-and-native-releases-are-separate).

The standalone Bridge release and the shapes.inc native-app release are separate
deliverables. Merging Bridge or publishing a native app does **not** publish the
standalone GitHub asset. This repository currently automates CI only, with no
automatic release workflow or npm-registry publication contract. Source installs
and updates fetch `main`; signed macOS installation downloads
`shapes.inc-Bridge-macos.zip` from the latest GitHub release.

Use the following coordinated sequence after release authorization:

1. Prepare a dedicated worktree from current `origin/main`, an unused numeric
   `major.minor.patch` package version, and a reviewed release-candidate commit.
   For a version/docs-only change, run `node --test test/package-bin.test.js` and
   `npm pack --dry-run`, then let the configured CI checks finish. Create the
   `v<version>` tag/draft release at that exact candidate, without publishing it.
2. Under the machine-wide build lock, run `scripts/build-mac-release.sh` on a Mac
   with the authorized Developer ID certificate and notarytool profile. It
   verifies downloads, builds both Mac architectures, signs with hardened
   runtime, notarizes/staples, and writes `dist/shapes.inc-Bridge-macos.zip` and
   its `.sha256` file. Do not use `SKIP_NOTARIZE=1` for public distribution.
   Alternatively, reuse the unchanged helper from a completed native release
   built from the exact reviewed Bridge commit/version. Verify its accepted
   notary ticket and staple the extracted copy if needed; never re-sign, relabel
   or modify its runtime. Archive that verified helper and generate the checksum
   without recompiling it.
3. Verify the archive's source commit, both architectures, strict signatures and
   team identity, notarization/stapling and Gatekeeper acceptance. The nested
   runtime `package.json`, bundle versions and release tag must agree. Exercise
   `installSignedMacApp` against a disposable destination with the new package
   version as its minimum; never relabel an already signed older helper.
   For bundled-installer tests, isolate home/state and simulate global service
   manager calls because `stopService` is not isolated by a custom state directory.
   Keep signature, copy and version checks real and record that simulation.
4. Coordinate the native app's Bridge pin and public release at the same helper
   version before publishing the standalone asset. The standalone installer
   rejects an older signed helper, while the bundled installer refuses to
   downgrade a newer installed Bridge. Updating only one channel can therefore
   prevent reconnecting through the other entry point that shares the install.
   Modern app-owned runtime state remains separate from the standalone install.
5. Upload the verified ZIP and checksum to the draft, publish it as the latest
   standalone release, then download through the public `releases/latest` URL
   and verify its bytes, checksum and version. Only then merge the installer
   version metadata PR onto `main`. Merging the bump first can reject the old
   latest asset and trigger the existing unsigned local-build fallback. Record
   the source/tag, native release and public asset verification in the handoff.

Version/docs-only release work adds **$0/day** in AI calls or context. Runtime
changes still require their affected integration and user-flow checks; packaging
checks do not replace them. See [AGENTS.md](https://github.com/shapesinc/bridge/blob/main/AGENTS.md)
for contributor rules.

The release now also builds the native **Computer connection** window and
packages a universal cloudflared 2026.10.6 executable, with both architecture
archives checked against pinned SHA-256 values. Both executables are signed
before the app. Host apps embed the complete signed bundle and open it with
the `desktop-ui` argument. First connection verifies and copies that bundled
release into the existing per-user install location, preserving account pairing
and grants. It never downloads a replacement, accepts an unsigned helper, or
downgrades a newer installed Bridge. The parent app must be re-signed and
notarized after embedding; an archive assembled locally is not a release.
