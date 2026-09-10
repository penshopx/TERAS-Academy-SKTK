# TERAS readiness audit signing

Readiness audit exports are signed with Ed25519. The API refuses to export an
unsigned file when signing is not configured.

Configure the secret `TERAS_READINESS_AUDIT_SIGNING_KEYS` as a JSON array:

```json
[
  {
    "keyId": "teras-audit-2026-09",
    "version": 2,
    "active": true,
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  },
  {
    "keyId": "teras-audit-2026-01",
    "version": 1,
    "active": false,
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
  }
]
```

Exactly one entry must be active and contain its matching private key. Retain
old public keys as inactive entries so previously issued exports remain
verifiable. Never retain an old private key unless it is still needed for a
separate controlled recovery process.

Public keys and their key IDs/versions are available without authentication at
`/api/readiness-audit/public-keys`. Verify a downloaded export with:

```sh
node artifacts/api-server/scripts/verify-readiness-audit.mjs readiness-audit.json
```

Save the public-key endpoint response, then pass it to the verifier:

```sh
node artifacts/api-server/scripts/verify-readiness-audit.mjs readiness-audit.json public-keys.json
```