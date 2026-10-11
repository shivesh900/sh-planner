# Firebase setup for SH PLANNER

Project: `sh-planner-c87c5` (Firebase Auth with the Google provider, plus Cloud Firestore in asia-south1).

## Security rules (`firestore.rules`)
Each signed-in user can read and write only `users/{their uid}/**`. Everything else is denied.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

To set them by hand: Firebase console → Firestore Database → Rules → paste → Publish.

To deploy them with the CLI:
```
npm i -g firebase-tools
firebase login
cd firebase
firebase deploy --only firestore:rules        # uses .firebaserc → sh-planner-c87c5
```

## Authorized domains
Firebase console → Authentication → Settings → Authorized domains must include `shivesh900.github.io` (localhost is there by default).

## Local testing with the emulators (needs Java 21+)
```
cd firebase
firebase emulators:start --only auth,firestore --project demo-sh-planner
# serve the site on http://localhost:5173 and open http://localhost:5173/?emu=1
```

## Data layout
- `users/{uid}/tasks|notes|folders|habits/{id}`: the app's records, plus `updated` (ms) and `deleted` (tombstone) for last-write-wins sync
- `users/{uid}/settings/prefs`: `{ value, updated }`
- `users/{uid}/images/{id}`: image metadata. `users/{uid}/images/{id}/c/{n}`: base64 JPEG chunks of up to 700 KB each, so every doc stays under Firestore's 1 MiB limit. Firebase Storage isn't used, so the free Spark plan is enough.
