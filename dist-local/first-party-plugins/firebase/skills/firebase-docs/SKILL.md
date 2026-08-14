---
name: firebase-docs
description: Build and debug Firebase apps — Authentication, Firestore data modeling and security rules, Cloud Functions, Hosting, and the local emulator suite. Use when a project uses Firebase or the firebase CLI.
---

# Firebase

## Canonical docs (fetch for version-specific answers)

- Docs root: https://firebase.google.com/docs
- Firestore: https://firebase.google.com/docs/firestore
- Security rules: https://firebase.google.com/docs/rules
- Cloud Functions (2nd gen): https://firebase.google.com/docs/functions
- Emulator suite: https://firebase.google.com/docs/emulator-suite

## CLI cheatsheet

`firebase init` · `firebase emulators:start` · `firebase deploy` /
`firebase deploy --only hosting,functions:myFn` · `firebase functions:log` ·
`firebase firestore:indexes` · `firebase use <project>`.

## Footguns worth knowing

- **Always develop against the emulator suite**, never prod. Point SDKs at it
  with `connectFirestoreEmulator`/`connectAuthEmulator` guarded by an env
  check, and commit `firebase.json` emulator ports.
- Security rules are the actual authorization layer — client code checks are
  cosmetic. Default open rules in dev are the classic incident; rules should
  be written and unit-tested (`@firebase/rules-unit-testing`) alongside data
  model changes.
- Firestore queries need composite indexes for multi-field filters; the error
  message includes a creation link, but indexes belong in
  `firestore.indexes.json` so deploys are reproducible.
- Firestore charges per document read — unbounded `collection().get()` in a
  render path is the top cost bug. Paginate with cursors, aggregate with
  `count()`, and cache.
- Functions cold starts: prefer 2nd-gen with `minInstances` for hot paths;
  keep global scope light.
- `firebase deploy` deploys everything by default; use `--only` in CI to
  avoid clobbering rules or hosting unintentionally.
