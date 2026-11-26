# Hosted Skyjo

The HTTPS Lambda function URL serves the online table at `/`, the family coach at `/coach` and the API from one origin in us-east-1. The Node.js 22 arm64 function runs with 256 MiB, an eight-second timeout and two concurrent executions. Its execution role can read and write game records in one DynamoDB table and write warning/error logs to one group with seven-day retention. Every game and history request uses the browser's private profile key. The public invocation grants apply only to the function URL.

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

The release verifies the deployed ZIP digest and compares each of the six served table and coach assets with its packaged bytes. It also checks both pages’ same-origin script policy, the engine catalog and an authenticated private history read. The release output contains the public HTTPS URL and the deployed ZIP digest. The inventory keeps the exact resource IDs, creation attribution and private readback. Its companion events file records operation intents and outcomes. Preserve both files. A creation with an uncertain provider response requires reconciling that exact ID and its documented creation event before continuing. Existing named resources require matching inventory and provider provenance.

## Recover private deployment records

Each successful release saves a single atomic, compressed copy of the deployment inventory and its operation journal in the same private DynamoDB table. The verified factory project UUID and environment determine the table name `factory-<project_id>-<environment>-r-games`. The fixed operator record uses `pk=OPS#FACTORY` and `sk=DEPLOYMENT#v1`. Browser profiles use `P#` partitions. Running the following in a newly activated Skyjo workspace restores both files with private permissions. The only local prerequisite is a clean checkout of this release tool and the factory AWS profile used for deployment.

```bash
mkdir -p -m 700 "$SKYJO_OPS"
run_id="restore-$(date -u +%Y%m%dT%H%M%SZ)"
export FACTORY_AWS_EXECUTABLE="$PWD/infra/online.py"
export FACTORY_AWS_EXECUTABLE_SHA256="$(sha256sum "$FACTORY_AWS_EXECUTABLE" | cut -d' ' -f1)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json" --recovery restore
sha256sum "$SKYJO_OPS/inventory.json" "$SKYJO_OPS/inventory.events.jsonl"
```

The result file reports the same two byte digests. Restore verifies the table's project tags, performs a strongly consistent read, and checks both decompressed files before writing. Use an empty private directory if existing records differ. To refresh the copy directly after reconciling records, use the same environment and a new run ID.

```bash
run_id="backup-$(date -u +%Y%m%dT%H%M%SZ)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json" --recovery backup
```

The update checks that the saved journal is a prefix of the local journal, uses a conditional write, and reads the result back to verify its bytes. A competing update or a forked journal requires reconciliation. The snapshot shares the table's availability and deletion protection. Keep the private files when backing up the table or migrating the service. If the compressed recovery item approaches DynamoDB's 400 KB per-item limit, migrate the archive before the next release.

## Expected operating cost

For example, 10,000 requests averaging 250 ms each at 256 MiB consume 625 GB-seconds of Lambda compute, about $0.01 at standard arm64 rates before free tier. A workload with 100,000 DynamoDB write request units and 50,000 read request units costs about $0.07 for requests. Storage adds roughly $0.25 per GB-month beyond applicable free tier. Transactional writes consume twice the units of equivalent ordinary writes. Family use at this scale fits below an estimated $1/month, including modest logs and bandwidth. Actual charges vary with usage and retention. A lifetime dollar ceiling requires tracking cumulative charges and changing or ending the service when the remaining budget approaches zero.

## Canonical HTTPS hostname

[skyjo.carloperottino.com](https://skyjo.carloperottino.com/) serves the existing Lambda function URL through one pay-as-you-go CloudFront distribution. The distribution terminates TLS with an exact-host ACM certificate in us-east-1, redirects HTTP viewers to HTTPS and requires TLS 1.2 to the origin. It forwards Authorization, query strings and every HTTP method. CloudFront supplies the Lambda origin's Host header. AWS’s managed CachingDisabled policy and zero error-cache TTLs keep each private response on its own request. The existing function URL continues to work.

Use the same clean checkout, allocated project role, private inventory and selected public Route 53 zone as the release. Read the current records before every change. The certificate and distribution receive project provenance tags. The private recovery copy tracks the exact certificate, validation record, distribution, canonical A and AAAA aliases, their zone, ownership and change IDs.

```bash
export FACTORY_AWS_EXECUTABLE="$PWD/infra/domain.py"
export FACTORY_AWS_EXECUTABLE_SHA256="$(sha256sum "$FACTORY_AWS_EXECUTABLE" | cut -d' ' -f1)"
stage=certificate
run_id="domain-$stage-$(date -u +%Y%m%dT%H%M%SZ)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  "$stage" --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json"
```

Run this command for `certificate`, then `distribution` after ACM issues the certificate, then `publish` after CloudFront reports Deployed. Select a fresh run ID on each attempt. The certificate stage creates the single ACM-supplied CNAME for DNS validation and automatic renewal. The publish stage submits one create-only Route 53 batch for the IPv4 and IPv6 aliases, waits for INSYNC and checks both record values. Keep the validation CNAME for renewal. If a provider write times out, reconcile its exact resource or change ID against the private operation journal before retrying.

CloudFront's monthly pay-as-you-go charges depend on request volume and bytes delivered. The ACM public certificate for this distribution, SNI TLS, and alias lookups to CloudFront have no separate fixed monthly charge. The existing hosted zone and Lambda service are reused. At the family-scale example above, 10,000 North American HTTPS requests and 250 MB of outbound traffic add approximately $0.03 before free allowances. [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) · [ACM pricing](https://aws.amazon.com/certificate-manager/pricing/)
