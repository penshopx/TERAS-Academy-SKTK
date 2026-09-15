---
name: Strict IANA time-zone validation
description: Runtime behavior to account for when an API requires named IANA time zones rather than every Intl-compatible identifier.
---

Successful construction of `Intl.DateTimeFormat` is not sufficient to enforce named IANA time zones. The project runtime also accepts fixed-offset identifiers such as `+01:00` and `-2359`.

**Why:** Fixed offsets are valid for this runtime's Intl implementation but are not IANA time-zone names and do not carry regional daylight-saving rules.

**How to apply:** When a contract requires an IANA time zone, explicitly reject fixed-offset syntax before checking the identifier with `Intl.DateTimeFormat`. Include a fixed-offset case in validation tests.