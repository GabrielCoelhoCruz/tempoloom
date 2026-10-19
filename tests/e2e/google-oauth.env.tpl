# 1Password references for the Google OAuth E2E run (scripts/e2e-google.sh).
# A reference is op://<vault>/<item>/<field>; for a file it is the file's name.
#
# GOOGLE_OAUTH_CLIENT_JSON is the OAuth client JSON file downloaded from the
# Google Cloud console. The reference below needs that file attached as the
# file field "client.json" of the item "google-oauth-client" in the vault
# "tempoloom-e2e". If the JSON is a separate Document item instead, change
# the reference to op://tempoloom-e2e/<document item title>/<file name>, for
# example op://tempoloom-e2e/google-oauth-client-json/client.json, or attach
# the file to google-oauth-client as client.json. Use item titles, not ids.
GOOGLE_OAUTH_CLIENT_JSON=op://tempoloom-e2e/google-oauth-client/client.json
# The Google test account: the text field "test-account-email" of the same
# item. The consent screen suggests it, and the run stops if another account
# approves. A plain address also works here.
GOOGLE_TEST_ACCOUNT_EMAIL=op://tempoloom-e2e/google-oauth-client/test-account-email
