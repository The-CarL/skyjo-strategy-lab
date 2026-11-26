# Hosted Skyjo

CloudFront serves the online table at `/`, the family coach at `/coach` and the API on the canonical hostname. A Lambda function URL in us-east-1 supplies the origin. The Node.js 22 arm64 function runs with 256 MiB, an eight-second timeout and two concurrent executions. Its execution role can read and write game records in one DynamoDB table and write warning/error logs to one group with seven-day retention. Every game and history request uses the browser's private profile key. After the origin migration, the Lambda URL requires AWS IAM authentication. Its resource policy admits the CloudFront service principal with this distribution’s ARN.

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

The release verifies the deployed ZIP digest and compares each of the six served table and coach assets with its packaged bytes. It also checks both pages’ same-origin script policy, the engine catalog and an authenticated private history read. The release output contains the Lambda origin URL and deployed ZIP digest. Use the canonical hostname for public verification. Once signed-origin routing is enabled, each new package invalidates the prior edge cache and waits for completion. The inventory keeps the exact resource IDs, creation attribution and private readback. Its companion events file records operation intents and outcomes. Preserve both files. A creation with an uncertain provider response requires reconciling that exact ID and its documented creation event before continuing. Existing named resources require matching inventory and provider provenance.

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

[skyjo.carloperottino.com](https://skyjo.carloperottino.com/) serves the existing Lambda function URL through one pay-as-you-go CloudFront distribution. The distribution terminates TLS with an exact-host ACM certificate in us-east-1, redirects HTTP viewers to HTTPS and requires TLS 1.2 to the origin. During migration, the existing forwarding setup and Lambda URL remain available until the independent stages below complete.

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


For owner alerts, rate controls and the new-game pause procedure, see the [traffic operations guide](traffic.md).

## Sign origin traffic and cache the public assets

Use the compatibility release before changing distribution routing. It sends the existing recovery key as `X-Skyjo-Profile` and hashes the exact serialized bytes for every body-bearing write into `X-Amz-Content-Sha256`. CloudFront can then use `Authorization` for its own SigV4 signature. The game data, profile hashes and recovery codes are unchanged. On the original Lambda hostname, the compatibility release shows a migration notice and a recovery-key dialog. Save that key and restore it on the canonical hostname before closing direct access.

Use the activated project, clean release checkout, private inventory and factory execution bindings from the Release section. Change `stage` and use a fresh run ID for every invocation.

```bash
stage=prepare
run_id="origin-$stage-$(date -u +%Y%m%dT%H%M%SZ)"
export FACTORY_AWS_EXECUTABLE="$PWD/infra/origin.py"
export FACTORY_AWS_EXECUTABLE_SHA256="$(sha256sum "$FACTORY_AWS_EXECUTABLE" | cut -d' ' -f1)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  "$stage" --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json"
```

1. `prepare` creates a Lambda origin access control and a shared-cache policy, then grants this distribution the two Lambda URL invocation permissions. Both grants restrict the source to the distribution ARN. The function invocation grant also requires invocation via its URL. Preparation leaves the previous traffic route in service.
2. `edge` attaches the signing configuration using the distribution’s latest ETag. CloudFront signs every origin request. The default GET/HEAD behavior omits viewer profile headers, cookies and query strings, and caches responses according to origin directives up to five minutes. HTML currently advertises 60 seconds and scripts and stylesheets 300 seconds of shared caching. The `api` and `api/*` behaviors allow every method, forward the profile header and query parameters, and use the managed CachingDisabled policy. Error cache TTLs stay at zero. Wait for CloudFront to reach Deployed, then verify canonical creation, idempotent retry, isolated history, recovery and abandon.
3. `managed` switches the public behavior to AWS Managed-CachingOptimized for flat-rate plan eligibility. This policy forwards no viewer cookies, query strings or profile headers. Its one-second minimum can briefly cache anonymous generic responses; both private API behaviors and their error-cache settings remain at zero. Origin-provided shared TTLs still govern known assets. The earlier custom policy remains in the inventory.
4. `lock` switches the verified existing Lambda URL to `AWS_IAM` and retires the two previous wildcard grants. The ordinary release command verifies the resulting resource policy and can no longer recreate an anonymous origin. Confirm both canonical play and an anonymous 403 on the original URL. A previously saved raw-host profile remains in the browser’s local storage on that exact hostname. On desktop, the browser’s developer tools can display `skyjo-online-profile-v1` under that origin’s local storage for manual recovery on the canonical page.

An interrupted stage can be rerun from the same private inventory after checking its journal. To coordinate changes to WAF and the origin, serialize operations against that inventory. Each distribution update uses its current ETag and preserves its other settings. Origin access controls and cache policies introduce no fixed monthly charge. CloudFront request traffic, Lambda and DynamoDB are metered. CloudFront’s first 1,000 invalidation paths per account per month are free. [Lambda origin access control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html) · [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)
