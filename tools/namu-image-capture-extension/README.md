# Kpoparkive Namu Image Capture

This is the human-assisted image path for NamuWiki. It does **not** launch or drive Chrome. You open NamuWiki normally, and the extension only captures image URLs/bytes already available to that normal browser session.

## 1. Start the local helper

From the `kpoparkive` project directory:

```bat
npm run namu:capture-helper
```

Expected output:

```text
Kpoparkive Namu Chrome capture helper
Listening on http://127.0.0.1:43117
```

The helper reads `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`, validates incoming image bytes, uploads accepted files to `wiki-media/imports/<root>/...`, and updates matching `source_asset_queue` rows.

## 2. Load the unpacked Chrome extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select:

```text
<kpoparkive>\tools\namu-image-capture-extension
```

If NamuWiki was already open before the extension was loaded, refresh the NamuWiki tab once.

## 3. Capture one document

1. Use your normal Chrome profile and open a NamuWiki document normally.
2. Finish any human verification yourself if NamuWiki asks for it.
3. After the actual wiki document is visible, click the Kpoparkive extension icon.
4. Keep `Root document` set to the imported cluster root, e.g. `RESCENE`.
5. Click **Capture this page**.

The extension extracts NamuWiki file names from image/file links, fetches the actual image bytes through the normal Chrome session, rejects blank/transparent/placeholder raster images, and sends only validated bytes to the localhost helper.

The helper stores successful files under:

```text
Supabase Storage
└ wiki-media
  └ imports
    └ rescene
```

Queue metadata records `resolved_from = manual-chrome-capture-extension`, plus width, height and byte size.

## Why this exists

The server-side and Playwright image paths can trigger NamuWiki/Cloudflare verification. This capture path does not attempt to automate or solve that verification. It uses a page you opened normally and only captures assets after the page is available to you.
