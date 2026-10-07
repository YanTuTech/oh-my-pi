Read record {{id}}, revision {{revision}}, specifically from {{source}}. Library names are exact identities: punctuation is significant. Do not use any other library, even if it has the same record ID.

Return only a JSON object with exactly these fields on success: status ("ok"), source, id, revision, checksum. The checksum must come from the requested source's tool result, not from the prompt or a guess.

If a required read tool for that exact source is absent from your available tool inventory, do not substitute another source or invent data. Return only {"status":"unavailable","sources":["{{source}}"]}. Reporting unavailability is not completing the data-retrieval task.
