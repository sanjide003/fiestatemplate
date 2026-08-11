# Empty-State Branding Contract

The application uses `branding-config.js` as the single neutral branding source for Admin, Login, Public Home, Results, Team Portal, Judge Desk, Publishing Desk, Public Registration and TV Display.

When `settings/home_config` is missing or has no festival name, pages must show **Fest Management / Setup Required**, setup guidance and a generic `FM`/role icon instead of a previous festival identity. The old browser cache is removed whenever Firestore confirms that the branding document does not exist. A configured identity requires a non-empty first name line or an explicit `setupCompleted: true` value.

Admin branding fields are blank in a fresh database and use UI labels/placeholders for guidance; sample festival names are never saved implicitly. Saving a non-empty first name marks branding setup complete. Factory Reset clears the local branding cache immediately while the shared loaders clear stale caches on other devices when they next verify Firestore.

Footer years are calculated from the current date. Legacy festival names are not part of the reusable identity; the linked `Powered by hadi mahiri faizy` credit remains on the public-facing footers.
