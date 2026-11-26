# Hosted Skyjo

The HTTPS Lambda function URL serves the browser and API from one origin in us-east-1. The Node.js 22 arm64 function runs with 256 MiB, an eight-second timeout and two concurrent executions. Its execution role can read and write game records in one DynamoDB table and write warning/error logs to one group with seven-day retention. Every game and history request uses the browser's private profile key. The public invocation grants apply only to the function URL.

The table uses on-demand billing, a string partition key `pk`, a string sort key `sk`, deletion protection and configured maxima of 16 read units and 32 write units per second. DynamoDB can temporarily exceed these targets through burst capacity. The account's normal encryption at rest applies.

## Release

Use the Skyjo project's activated factory session with the approved account, workload boundary and region selected. Build the package from a clean committed checkout and run the repository tests. Choose a new run ID for each attempt, and keep the inventory at the same location between releases. Set `SKYJO_OPS` to the private operations directory outside the checkout.

```bash
npm ci
npm test
npm run online:package
mkdir -p -m 700 "$SKYJO_OPS"
run_id="skyjo-$(date -u +%Y%m%dT%H%M%SZ)"
export FACTORY_AWS_EXECUTABLE="$PWD/infra/online.py"
export FACTORY_AWS_EXECUTABLE_SHA256="$(sha256sum "$FACTORY_AWS_EXECUTABLE" | cut -d' ' -f1)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json"
```

The release output contains the public HTTPS URL and the deployed ZIP digest. The inventory keeps the exact resource IDs, creation attribution and private readback. Its companion events file records operation intents and outcomes. Preserve both files. A creation with an uncertain provider response requires reconciling that exact ID and its documented creation event before continuing. Existing named resources require matching inventory and provider provenance.

## Expected operating cost

For example, 10,000 requests averaging 250 ms each at 256 MiB consume 625 GB-seconds of Lambda compute, about $0.01 at standard arm64 rates before free tier. A workload with 100,000 DynamoDB write request units and 50,000 read request units costs about $0.07 for requests. Storage adds roughly $0.25 per GB-month beyond applicable free tier. Transactional writes consume twice the units of equivalent ordinary writes. Family use at this scale fits below an estimated $1/month, including modest logs and bandwidth. Actual charges vary with usage and retention. A lifetime dollar ceiling requires tracking cumulative charges and changing or ending the service when the remaining budget approaches zero.

A future custom domain can use CloudFront with this HTTPS origin, an ACM certificate and a DNS record. The current release creates the Lambda URL only.
