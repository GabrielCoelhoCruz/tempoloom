# 1Password reference for the Google OAuth E2E run (scripts/e2e-google.sh).
# The value is the OAuth client JSON file downloaded from the Google Cloud console.
GOOGLE_OAUTH_CLIENT_JSON=op://tempoloom-e2e/google-oauth-client/client.json
# The Google test account. The consent screen suggests it, and the run stops
# if another account approves. A plain address also works here.
GOOGLE_TEST_ACCOUNT_EMAIL=op://tempoloom-e2e/google-oauth-client/test-account-email
