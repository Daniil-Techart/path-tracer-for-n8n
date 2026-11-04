# Privacy Policy — Path Tracer for n8n

Last updated: 2026-10-31

Path Tracer for n8n is an unofficial browser extension that enhances the n8n workflow editor. It runs entirely on the user's device and is not affiliated with, endorsed by, or sponsored by n8n.

## What the extension does

- Reads the workflow currently open in the n8n editor (nodes and connections) from the page's DOM and the editor's client-side store.
- Draws an overlay with the paths from a trigger to the selected node.
- Stores no data and sends no data anywhere.

## Data collection

The extension collects no personal data, no analytics, no telemetry, and no usage statistics.

## Network access

The extension makes no network requests. It does not load remote code, scripts, or configuration.

## Storage

The extension uses no browser storage (no `chrome.storage`, no cookies, no `localStorage`).

## Permissions

The extension declares no API permissions. It uses a content script matched against `http://*/*` and `https://*/*` so it can work with any self-hosted n8n instance. The script exits immediately on every page that is not an n8n editor (detected by the `n8n:config:rest-endpoint` meta tag or the n8n workflow canvas).

## Third parties

No third-party services are used.

## Contact

Open an issue in the project repository.
