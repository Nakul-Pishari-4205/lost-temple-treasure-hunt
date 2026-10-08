# Enable account sign-in and cloud saves

The game continues to work as a guest without Firebase. Guest preferences and best
score remain in that browser's local storage. To sync profiles between phones and
computers, configure a Firebase project; saves are stored separately for each
Firebase user ID.

## Firebase project setup

1. Create a Firebase project and register a **Web app**. Copy its web configuration
   into `firebase-config.js` (`apiKey`, `authDomain`, `projectId`, and `appId`).
   Firebase web configuration is public client configuration, not a secret. Never
   paste a service-account key into the website.
2. In **Authentication → Sign-in method**, enable Google, Microsoft, and Apple.
   Configure each provider with its provider-console credentials and Firebase's
   callback URL. Apple sign-in requires an Apple Developer Services ID and the
   associated Apple sign-in configuration.
3. In **Authentication → Settings → Authorized domains**, add the GitHub Pages
   host `nakul-pishari-4205.github.io` (and any local test host you use).
4. Create a **Cloud Firestore** database and publish the rules from `firestore.rules`.
   Do not use open/test-mode rules. The supplied rules restrict every profile read
   and write to the authenticated user's own UID and validate the saved fields.
5. Deploy the updated static files over HTTPS and open the site again. Sign in on
   each device using the same provider and account to load the same profile.

The account profile syncs sound and reduced-motion settings, personal-best score,
completed expeditions, and recovered relic totals. Cloud updates use Firestore
transactions so simultaneous sessions preserve the best score and add expedition
totals without overwriting another device's newer save. Signing out returns to the
device-local guest profile; guest data is never automatically copied into an
account. Switching accounts loads a different UID-scoped profile.

## Local testing

Run the site from a local HTTP server (ES modules and provider redirects do not work
from a `file://` URL), add that local hostname to Firebase's authorized domains,
and open the hosted URL. If `firebase-config.js` is left blank, provider buttons
explain that cloud sign-in has not yet been configured.
