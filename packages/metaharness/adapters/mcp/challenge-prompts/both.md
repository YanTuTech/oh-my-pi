Compare record {{id}} in two distinct libraries: {{primarySource}} revision {{primaryRevision}}, and {{secondarySource}} revision {{secondaryRevision}}. Punctuation distinguishes the libraries; neither is an alias of the other. Read both sources. Independent reads may be parallel.

Return only a JSON object with exactly: status ("ok"), primarySource, primaryId, primaryRevision, primaryChecksum, secondarySource, secondaryId, secondaryRevision, secondaryChecksum. Values must come from their respective tool results.

If a required source's read tool is absent, do not replace it with the other library or claim the comparison is complete. Return only {"status":"unavailable","sources":[the exact names of required libraries whose read tool is absent]}. Report only missing sources; do not list available ones. Reporting unavailability is not completing the comparison.
