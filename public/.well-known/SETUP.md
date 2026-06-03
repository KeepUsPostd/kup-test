# Universal Links / App Links — activation steps

These two files let `https://keepuspostd.com/app/*` links (the email CTA buttons)
open the **app directly** if installed, and fall back to the web (the
`/app/*.html → download-app` redirect) on desktop / when not installed.

They are served (with `application/json`) via explicit routes in `src/server.js`
because `express.static` ignores dotfiles.

## What's pre-filled
- iOS bundle id: `com.keepuspostd.reviews` (from ios/Runner.xcodeproj)
- Android package: `com.KeepUsPostd.KeepUsPostdApp`
- iOS entitlement `applinks:keepuspostd.com` already exists in
  `keepuspostd_app/ios/Runner/Runner.entitlements` ✅

## TWO values to fill in before the next app build
1. **Apple Team ID** (10 chars, e.g. `A1B2C3D4E5`):
   Apple Developer → Membership → Team ID. Put it in
   `apple-app-site-association` → replace `REPLACE_APPLE_TEAM_ID`.
2. **Android signing SHA-256** of the kup.jks release cert:
   `keytool -list -v -keystore kup.jks -alias <alias>` → copy the SHA-256 line
   (colon-separated hex). Put it in `assetlinks.json` →
   replace `REPLACE_WITH_SHA256_FINGERPRINT_FROM_kup.jks`.

## App-side steps (do in the next app build)
- **iOS:** entitlement is already there. Ensure the app **routes** an incoming
  universal link path (e.g. `/app/submissions.html`) to the right screen
  (handle in the app's deep-link router).
- **Android:** add an intent-filter with `android:autoVerify="true"` for
  `https://keepuspostd.com` `/app/*` in `AndroidManifest.xml`, and route the path.
- Rebuild + ship. On install/update, iOS fetches the AASA and Android verifies
  assetlinks — then the email buttons deep-link into the app.

Until then: the `/app/*.html → download-app` redirect keeps every email button
working (no 404; opens the app on mobile via the download page's smart link).
