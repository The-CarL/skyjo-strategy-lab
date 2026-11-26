#!/usr/bin/env python3
"""Inspect or change the owner's new-game switch through the scoped factory AWS profile."""
import argparse
import json
import uuid
from pathlib import Path

from online import Deployment, aws, require, timestamp

CONTROL_KEY = {"pk": {"S": "CONTROL#SKYJO"}, "sk": {"S": "NEW_GAMES"}}


def read_control(deploy):
    row = aws("dynamodb", "get-item", {
        "TableName": deploy.table, "Key": CONTROL_KEY, "ConsistentRead": True,
    }).get("Item")
    if row is not None:
        require(all(row.get(k) == v for k, v in CONTROL_KEY.items()) and
                isinstance(row.get("paused", {}).get("BOOL"), bool) and
                isinstance(row.get("generation", {}).get("S"), str), "Invalid new-game control record")
    return row


def creation_switch(deploy, action):
    require(action in ("status", "pause", "resume"), "Unknown new-game control action")
    require(deploy.state["resources"]["table"]["id"] == deploy.table_arn, "Inventory table mismatch")
    tags = aws("dynamodb", "list-tags-of-resource", {"ResourceArn": deploy.table_arn})["Tags"]
    deploy.verify("table", tags)
    previous = read_control(deploy)
    paused = previous["paused"]["BOOL"] if previous else False
    if action == "status" or paused == (action == "pause"):
        return {"newGamesPaused": paused, "changed": False}

    item = {
        **CONTROL_KEY, "paused": {"BOOL": action == "pause"}, "generation": {"S": str(uuid.uuid4())},
        "changedAt": {"S": timestamp()}, "run": {"S": deploy.run},
    }
    condition = (
        {"ConditionExpression": "#generation = :previous",
         "ExpressionAttributeNames": {"#generation": "generation"},
         "ExpressionAttributeValues": {":previous": previous["generation"]}}
        if previous else {"ConditionExpression": "attribute_not_exists(pk)"}
    )
    deploy.mutate("dynamodb", "put-item", {"TableName": deploy.table, "Item": item, **condition})
    require(read_control(deploy) == item, "The control changed concurrently; check status before retrying")
    return {"newGamesPaused": item["paused"]["BOOL"], "changed": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "pause", "resume"))
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    print(json.dumps(creation_switch(Deployment(args), args.action)))


if __name__ == "__main__":
    main()
