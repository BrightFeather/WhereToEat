# iOS Build & Run

## Open in Xcode

```bash
open WhereToEat/WhereToEat.xcodeproj
```

The project file is at `WhereToEat/WhereToEat.xcodeproj`. Sources live one level over at `ios/WhereToEat/`. The project file points into `ios/` for sources.

## Build (CLI)

iPhone 15 simulator, no code-signing:

```bash
xcodebuild -project WhereToEat/WhereToEat.xcodeproj \
  -scheme WhereToEat \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO build
```

Or pin to a specific simulator UDID (faster fast-loop because Xcode doesn't re-pick destinations):

```bash
xcodebuild -project WhereToEat/WhereToEat.xcodeproj \
  -scheme WhereToEat \
  -destination 'platform=iOS Simulator,id=F63B6CF3-D0C0-45DF-A6E0-B884F03A0072' \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO build
```

Find UDIDs with:

```bash
xcrun simctl list devices available
```

## Install + run on the simulator

```bash
APP_PATH=$(ls -td ~/Library/Developer/Xcode/DerivedData/WhereToEat-*/Build/Products/Debug-iphonesimulator/WhereToEat.app | head -1)

xcrun simctl install   <UDID> "$APP_PATH"
xcrun simctl terminate <UDID> com.weijia.wheretoeat
xcrun simctl launch    <UDID> com.weijia.wheretoeat
xcrun simctl io        <UDID> screenshot /tmp/out.png
```

Bundle id is `com.weijia.wheretoeat` (note: a stale `weijia.WhereToEat` from earlier scaffolding may also be installed — check `xcrun simctl listapps <UDID>` and uninstall the stale one if app launches go to the iOS Home Screen).

## Tests

There is **no test target** today. Visual validation in the simulator is the QA loop. Don't add a target without confirming with the user.

## Pointing the app at a different backend

Order is enforced in `ios/WhereToEat/Networking/APIClient.swift:49-57`:

1. `dev_api_base_url` UserDefaults key — set with:
   ```bash
   xcrun simctl spawn <UDID> defaults write com.weijia.wheretoeat dev_api_base_url "http://192.168.1.50:3000"
   ```
2. `API_BASE_URL` Info.plist key — set via xcconfig.
3. Default → `https://wheretoeat-red.vercel.app`.

`localhost` is never a default — a physical iPhone's loopback can't reach the Mac.

## Common gotchas

- **Simulator has no GPS** by default → **Features → Location → Apple** in the simulator menu before assuming Discovery / Find is broken.
- **SourceKit transient errors** ("Cannot find type Restaurant in scope") during fast Edit cycles are normal — trust `BUILD SUCCEEDED` over the editor banner.
- **Don't re-apply scaffolding fixes**: the project moved from a macOS scaffold to iOS targeting; those fixes are settled. Diagnose first if a build breaks.
- **Two installed app bundles**: stale `weijia.WhereToEat` may exist alongside `com.weijia.wheretoeat`. Uninstall the stale id if launches go to the Home Screen.
- **Adding a new Swift file** means editing both the file system **and** `project.pbxproj` (PBXBuildFile + PBXFileReference + group child + Sources phase). Use hex-only 24-char IDs in the `5FBAD0*` range; grep the pbxproj first — linters have re-added colliding IDs in the past.

## Project settings worth knowing

- `SDKROOT = iphoneos`
- `TARGETED_DEVICE_FAMILY = "1,2"`
- `IPHONEOS_DEPLOYMENT_TARGET = 17.0`
- `SWIFT_INSTALL_OBJC_HEADER = NO`
- Location usage strings via `INFOPLIST_KEY_NSLocation*` build settings (no separate Info.plist).
- `WhereToEat.entitlements` has macOS sandbox keys cleared; `applesignin` is commented until the Apple Developer Portal capability is flipped on.
