# Store screenshots

Captioned screenshots for the App Store (Apple TV) and Google Play (Android TV)
in every store language, built from the tvOS gallery captures. Store texts are
not kept here: App Store Connect and Play Console are their source of truth.
`locales.json` holds the captions (seven per language, in frame order) and each
language's tvOS app, App Store Connect and Play codes.

## 1. Capture

On an Apple TV 4K simulator, about 90 s per language:

```bash
HEX_SIM=<udid> bash scripts/gallery/capture-tvos.sh       # English; builds and installs the app
for l in de fr es it pt ja ko zh ru tr; do
  HEX_SIM=<udid> HEX_LANG=$l HEX_SKIP_BUILD=1 bash scripts/gallery/capture-tvos.sh
done
```

## 2. Render

```bash
node artwork/store/screenshots.js          # or a subset: … screenshots.js en de
```

Writes `artwork/store/output/` (git-ignored). Needs ImageMagick (`magick`).
Play gets the App Store frames minus the phone opener, plus two unaltered
captures for TV quality criterion TV-G4.

## 3. Upload

```bash
# App Store: the version must exist in App Store Connect and still be editable.
node artwork/store/upload-appstore.js ~/.appstoreconnect/private_keys/AuthKey_<id>.p8 <issuer-id> <version>

# Play: one edit, sent for review on commit. --dry-run validates and discards it.
node artwork/store/upload-play.js "$GOOGLE_PLAY_KEY_FILE" --dry-run
```

Both replace the screenshots in every language of `locales.json`. The App
Store key needs the App Manager role or higher; the Play service account needs
permission to edit the store listing.
