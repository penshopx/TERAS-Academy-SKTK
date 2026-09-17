---
name: Webhook secret rotation
description: Contract for rotating signed webhook secrets without changing payloads or interrupting delivery.
---

Webhook signatures must carry a signing-key identity that is separate from the signature algorithm version. Receivers may retain retired keys only with an explicit acceptance deadline; active keys remain unexpired.

**Why:** A simultaneous sender/receiver secret change can reject valid operational notifications. Embedding rotation metadata in the JSON body would also change the business payload and its downstream interpretation.

**How to apply:** Select the verification secret by the key-identity header, verify the existing timestamp-plus-body signature, and reject a retired key after its receiver-controlled transition deadline. Keep key identity and rotation timing out of the signed event body.