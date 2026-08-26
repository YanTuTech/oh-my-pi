# @oh-my-pi/omp-stats

Headless session-usage analytics for Agent Runtime hosts.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.omp/agent/sessions/`
- **SQLite aggregation**: Efficient stats storage and querying using `bun:sqlite`
- **Incremental sync**: Only processes new/modified log entries

## Metrics Tracked

| Metric | Calculation |
|--------|-------------|
| Tokens/s | `output_tokens / (duration / 1000)` |
| Cache Rate | `cache_read / (input + cache_read) * 100` |
| Cache Savings | `(uncached prompt cost - actual prompt cost) / uncached prompt cost * 100` |
| Error Rate | `count(stopReason=error) / total_calls * 100` |
| API-equivalent estimate | Sum of token usage priced with the matching public API rate card |
| Avg Latency | Mean of `duration` |
| TTFT | Mean of `ttft` (time to first token) |

Subscription-backed models use matching public API prices when an exact public model exists; these values estimate API-equivalent usage rather than the user's bill. Subscription-only models without a public price are reported as N/A and excluded from dollar totals.

## Programmatic use

```typescript
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats";

// Sync session logs to database
const { processed, files } = await syncAllSessions();

// Get aggregated stats
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);
```

## Data Storage

- **Session logs**: `~/.omp/agent/sessions/` (JSONL files)
- **Stats database**: `~/.omp/stats.db` (SQLite)

## License

MIT
