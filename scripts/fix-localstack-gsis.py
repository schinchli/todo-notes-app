#!/usr/bin/env python3
"""LocalStack parity fixup: Blocks provisions DynamoDB GSIs via a custom
resource (the "GSI manager" Lambda), which LocalStack CFN marks complete
without executing. Read the index specs from the synthesized template's
custom resources and create any missing GSIs directly via UpdateTable."""
import glob
import json
import subprocess
import sys

ENDPOINT = "http://localhost:4566"


def aws(*args):
    cmd = ["aws", f"--endpoint-url={ENDPOINT}", *args, "--output", "json"]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip())
    return json.loads(out.stdout) if out.stdout.strip() else {}


templates = glob.glob("cdk.out/*-prod.template.json") or glob.glob("cdk.out/*.template.json")
if not templates:
    sys.exit("No synthesized template found — run a deploy first.")
resources = json.load(open(templates[0]))["Resources"]

fixed = 0
for lid, res in resources.items():
    indexes = res.get("Properties", {}).get("Indexes")
    if res["Type"] != "AWS::CloudFormation::CustomResource" or not indexes:
        continue
    ref = res["Properties"]["TableName"].get("Ref")
    table = resources[ref]["Properties"]["TableName"]
    live = aws("dynamodb", "describe-table", "--table-name", table)["Table"]
    have = {g["IndexName"] for g in live.get("GlobalSecondaryIndexes") or []}
    for name, spec in indexes.items():
        if name in have:
            continue
        attrs = {spec["partitionKey"]: spec["partitionKeyType"]}
        key_schema = [{"AttributeName": spec["partitionKey"], "KeyType": "HASH"}]
        if spec.get("sortKey"):
            attrs[spec["sortKey"]] = spec.get("sortKeyType", "S")
            key_schema.append({"AttributeName": spec["sortKey"], "KeyType": "RANGE"})
        aws("dynamodb", "update-table", "--cli-input-json", json.dumps({
            "TableName": table,
            "AttributeDefinitions": [
                {"AttributeName": a, "AttributeType": t} for a, t in attrs.items()
            ],
            "GlobalSecondaryIndexUpdates": [{"Create": {
                "IndexName": name,
                "KeySchema": key_schema,
                "Projection": {"ProjectionType": "ALL"},
            }}],
        }))
        print(f"added GSI {name} -> {table}")
        fixed += 1

print(f"done — {fixed} GSI(s) added" if fixed else "done — all GSIs already present")
