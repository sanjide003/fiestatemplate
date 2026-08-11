# Security notes

## Kaspersky / Safe Browsing fix

The app pages must not ship encoded HTML blobs, `document.write` routers, hidden iframe/srcdoc loaders, or base64/data-URI placeholders. Security products often flag those patterns because malware uses similar obfuscation.

This repo now keeps the app entry pages as readable HTML/JS and adds browser/hosting security headers for Firebase Hosting, Vercel, Netlify and Cloudflare Pages style deployments.

## After deploying

1. Hard refresh the browser with Ctrl+Shift+R.
2. Clear any Kaspersky cached block entry for the site.
3. If the domain reputation is still cached remotely, submit the URL to Kaspersky as a false positive after the new deployment is live.
