#!/usr/bin/env python3
"""Read-only production smoke checks used by every deployment path."""

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


TIMEOUT_SECONDS = 20
MINIMUM_API_OPERATIONS = 140
PUBLIC_API_PREFIXES = (
    "/api/health",
    "/api/auth/login",
    "/api/gmail/oauth/callback",
    "/api/auth/property-invitations",
    "/api/property-webhooks",
)
HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "archive-mail-deployment-smoke/1"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.status, response.headers, response.read()


def status_for(method, url):
    request = urllib.request.Request(
        url,
        method=method,
        headers={"User-Agent": "archive-mail-deployment-smoke/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as error:
        error.read()
        return error.code


def is_public(path):
    return any(
        path == prefix or path.startswith(prefix + "/")
        for prefix in PUBLIC_API_PREFIXES
    )


def resolve_path(path):
    return re.sub(
        r"\{[^}]+\}",
        "00000000-0000-0000-0000-000000000001",
        path,
    )


def main():
    base_url = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3001").rstrip("/")
    failures = []

    status, headers, index_body = get(base_url + "/")
    index_text = index_body.decode("utf-8", errors="replace")
    if status != 200 or "text/html" not in headers.get("Content-Type", ""):
        failures.append("React entry page did not return HTML with status 200")
    if not re.search(r"""id=["']root["']""", index_text):
        failures.append("React entry page is missing the root mount element")

    asset_paths = sorted(set(re.findall(r"""(?:src|href)=["'](/assets/[^"']+)""", index_text)))
    if not asset_paths:
        failures.append("React entry page did not reference any production assets")
    for asset_path in asset_paths:
        asset_status, _, asset_body = get(urllib.parse.urljoin(base_url + "/", asset_path))
        if asset_status != 200 or not asset_body:
            failures.append("React asset {} was empty or unavailable".format(asset_path))

    _, _, health_body = get(base_url + "/api/health")
    health = json.loads(health_body.decode("utf-8"))
    if health.get("api") != "csharp" or health.get("database") != "postgresql":
        failures.append("Health response is not the C# PostgreSQL service")

    _, _, swagger_body = get(base_url + "/swagger/v1/swagger.json")
    swagger = json.loads(swagger_body.decode("utf-8"))
    operations = []
    for path, definition in swagger.get("paths", {}).items():
        for method in HTTP_METHODS:
            if method in definition:
                operations.append((method.upper(), path))

    if len(operations) < MINIMUM_API_OPERATIONS:
        failures.append(
            "Swagger exposed only {} operations; expected at least {}".format(
                len(operations),
                MINIMUM_API_OPERATIONS,
            )
        )

    protected_checked = 0
    for method, path in operations:
        if is_public(path):
            continue
        protected_checked += 1
        actual_status = status_for(method, base_url + resolve_path(path))
        if actual_status != 401:
            failures.append(
                "{} {} returned {}; expected 401 without credentials".format(
                    method,
                    path,
                    actual_status,
                )
            )

    print("React production assets: {} passed".format(len(asset_paths)))
    print("Swagger paths: {}".format(len(swagger.get("paths", {}))))
    print("Swagger operations: {}".format(len(operations)))
    print("Protected route authentication checks: {} passed".format(protected_checked))
    print("Database contract: C# + PostgreSQL startup passed")

    if failures:
        for failure in failures:
            print("ERROR: " + failure, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
