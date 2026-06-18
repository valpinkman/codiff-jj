# Distribution

## Native Apps

Codiff uses Electron Forge at the repository root:

- App bundle ID: `dev.nkzw-tech.codiff`
- Product name: `Codiff`
- URL scheme: `codiff`

Build commands:

```sh
pnpm make
pnpm make:ci
pnpm make:mac
```

`pnpm make:mac` builds the renderer and then runs the Apple Silicon build:

```sh
electron-forge make --platform=darwin --arch=arm64
```

For a signed and notarized macOS build, export the Apple environment variables `pnpm make:mac`:

```sh
export APPLE_ID='apple-id@example.com'
export APPLE_PASSWORD='app-specific-password-or-keychain-profile'
export APPLE_TEAM_ID='TEAMID12345'
export APPLE_SIGNING_IDENTITY='Developer ID Application: Nakazawa Tech (TEAMID12345)'
pnpm make:mac
```

The signing certificate must already be present in the local keychain. If `APPLE_SIGNING_IDENTITY` is omitted, Electron's signing tooling may choose a matching Developer ID identity automatically, but setting it explicitly is less ambiguous.

## GitHub Actions

`.github/workflows/build-app.yml` builds Linux and Windows artifacts on Ubuntu with Wine. macOS builds are intentionally local-only for now because they require the Developer ID certificate in the local keychain.

## App-Specific Setup

The Nakazawa Tech Apple account, team, and Developer ID certificate are reusable.

These parts are app-specific:

- `dev.nkzw-tech.codiff` must be the bundle ID you want to use for Codiff.
- Codiff includes `electron/icons/icon.icns`, `electron/icons/icon.ico`, and `electron/icons/icon.png`. The Forge config uses these automatically, and the source Icon Composer document lives at `electron/icons/Codiff.icon`.
- Release asset hosting URLs are app-specific. For Homebrew, the macOS zip needs a stable HTTPS URL.

## Homebrew Tap

Use a cask, not a formula, because Codiff is a prebuilt macOS `.app` bundle.

The tap lives at <https://github.com/nkzw-tech/homebrew-tap>. Users can install
Codiff with:

```sh
brew install --cask nkzw-tech/tap/codiff
```

Or tap the repository first:

```sh
brew tap nkzw-tech/tap
brew install --cask codiff
```

### Manual Release Flow

Build, sign, and notarize the macOS app locally. The signed zip should be in:

```sh
out/make/zip/darwin/arm64/Codiff-darwin-arm64-<version>.zip
```

The zip must also be uploaded to the matching GitHub Release in
`nkzw-tech/codiff` and be available at the stable public URL:

```sh
https://github.com/nkzw-tech/codiff/releases/download/v<version>/Codiff-darwin-arm64-<version>.zip
```

If the release is still a draft, publish it before updating the tap:

```sh
gh release edit v<version> --repo nkzw-tech/codiff --draft=false --latest --title v<version>
```

Verify the release asset URL and checksum:

```sh
curl -L --fail --output /tmp/Codiff-darwin-arm64-<version>.zip \
  https://github.com/nkzw-tech/codiff/releases/download/v<version>/Codiff-darwin-arm64-<version>.zip
shasum -a 256 out/make/zip/darwin/arm64/Codiff-darwin-arm64-<version>.zip
shasum -a 256 /tmp/Codiff-darwin-arm64-<version>.zip
```

Update `Casks/codiff.rb` in `nkzw-tech/homebrew-tap` with the new `version`
and `sha256`:

```ruby
cask "codiff" do
  version "0.2.0"
  sha256 "6fa3d5e723a1f768bbb81e16f7c05bd3e6559a53fd48a6d1aa2f5093ddce10db"

  url "https://github.com/nkzw-tech/codiff/releases/download/v#{version}/Codiff-darwin-arm64-#{version}.zip"
  name "Codiff"
  desc "Visual diff tool for Git changes"
  homepage "https://github.com/nkzw-tech/codiff"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on :macos

  app "Codiff.app"
  binary "#{appdir}/Codiff.app/Contents/Resources/app/bin/codiff-app",
         target: "codiff"

  zap trash: [
    "~/Library/Application Support/Codiff",
    "~/Library/Preferences/dev.nkzw-tech.codiff.plist",
    "~/Library/Saved Application State/dev.nkzw-tech.codiff.savedState",
  ]
end
```

Commit and push the tap update:

```sh
git add Casks/codiff.rb
git commit -m "Update Codiff cask to <version>"
git push
```

After pushing, verify Homebrew sees the new version:

```sh
brew tap nkzw-tech/tap
git -C "$(brew --repository nkzw-tech/tap)" pull --ff-only
brew audit --cask nkzw-tech/tap/codiff
brew style --cask nkzw-tech/tap/codiff
brew info --cask nkzw-tech/tap/codiff
brew upgrade --cask codiff
```

The cask symlinks Codiff's packaged terminal helper as `codiff`. Running
`codiff` from a repository opens that folder, and running
`codiff /path/to/repo` opens the provided folder without keeping the terminal
attached to the Electron process. `codiff --share` runs the bundled CLI
headlessly, waits for walkthrough generation and upload, and prints the final
URL without opening an Electron window.

Users who install the `.app` directly can run `Codiff > Install Terminal Helper`
from the app menu. Codiff installs the helper into the first writable location
from `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin`.
