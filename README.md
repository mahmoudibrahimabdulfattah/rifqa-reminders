# Rifqa reminder sender

This public repository runs the scheduled sender for the Rifqa app. It sends data-only Firebase Cloud Messaging (FCM) reminders; the app itself lives in a private repository.

## Setup

Create a Firebase service-account key in **Firebase console → Project settings → Service accounts → Generate new private key**. In this repository, open **Settings → Secrets and variables → Actions**, create a repository secret named `FIREBASE_SERVICE_ACCOUNT`, and paste in the complete JSON file contents. Then delete the downloaded local file.

To run the sender once manually:

```sh
gh workflow run reminders.yml
```

The reminder workflow runs every 30 minutes. A monthly keepalive workflow re-enables both scheduled workflows to guard against GitHub disabling schedules after repository inactivity.

The sender's public log output is limited to an aggregate counts JSON object and a generic failure line. It does not print user IDs, device tokens, reminder times, or error details.
