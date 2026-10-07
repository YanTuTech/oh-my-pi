Search {{source}} for the topic "{{topic}}", publication year {{year}}. From the matching records select the highest revision for that year, then read that exact ID and revision from the same library. Do not use another source, guess an ID, or read a record before the search that returns it has completed. Additional searches or evidence-based verification reads are allowed; not all tasks require one fixed call sequence.

Return only a JSON object with exactly: status ("ok"), source, id, revision, checksum. Obtain the checksum by reading the selected record. Search results contain revisions and years but not checksums.

If the required source's search or read tool is absent from your available inventory, do not invent data. Return only {"status":"unavailable","sources":["{{source}}"]}. An available tool returning an empty result is not a missing capability.
