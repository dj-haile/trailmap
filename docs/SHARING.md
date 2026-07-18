# Sharing Trailmap with other Macs

## Building the shareable installer

```bash
npm run dist
```

This produces `dist/Trailmap-<version>-universal.dmg` — a **universal binary** that runs natively on both Apple Silicon and Intel Macs. Send that .dmg file however you like (AirDrop, Drive, Slack).

## What recipients do

1. Open the .dmg, drag **Trailmap** into **Applications**.
2. Double-click Trailmap. macOS will refuse the first time — the app is not notarized by Apple, so Gatekeeper shows *"Trailmap" cannot be opened* or a malware-check warning. This is expected.
3. Open **System Settings → Privacy & Security**, scroll down to the security section — there's a message about Trailmap with an **Open Anyway** button. Click it, confirm, done. macOS remembers forever after.

(On macOS 14 Sonoma and earlier, right-click → Open on the app is a faster path to the same override. macOS 15 Sequoia and later removed that shortcut, hence the Settings route.)

If a recipient gets a *"damaged and can't be opened"* message instead (some transfer methods aggravate quarantine), have them run this once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Trailmap.app
```

Their data is their own: each Mac stores its map at `~/Library/Application Support/Trailmap/` — nothing is shared or synced between machines, and the app makes no network calls at all.

## Removing the friction later: signing & notarization

The warnings exist only because the build is unsigned. To ship a Gatekeeper-clean app (no warnings, no Settings visit), you need an [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/yr). Once enrolled:

1. In Xcode or developer.apple.com, create a **Developer ID Application** certificate and install it in your Keychain.
2. Create an app-specific password for your Apple ID (appleid.apple.com → Sign-In and Security).
3. In `package.json` under `build.mac`, remove `"identity": null` and add `"notarize": true`.
4. Export credentials and build:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"
npm run dist
```

electron-builder signs and notarizes automatically; the resulting .dmg opens with a normal double-click on any Mac. (This is roadmap item §12.4 in `docs/PLAN.md`.)
