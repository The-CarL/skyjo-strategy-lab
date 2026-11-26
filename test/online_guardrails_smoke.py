"""Exercise browser throttling and write integrity against the local in-memory game."""
from datetime import datetime, timezone
from email.utils import format_datetime
from hashlib import sha256
import json
import os
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from online_smoke import BASE, button, slot, stage


def record(request, profile):
    path = urlsplit(request.url).path
    headers = request.headers
    assert "authorization" not in headers
    if path == "/api/engines":
        assert "x-skyjo-profile" not in headers
    else:
        assert headers.get("x-skyjo-profile") == profile
    data = request.post_data_buffer
    if request.method == "POST":
        assert sha256(data).hexdigest() == headers["x-amz-content-sha256"]
        assert headers["content-type"] == "application/json"
    return path, data


def setup(browser):
    context = browser.new_context(viewport={"width": 390, "height": 844})
    page = context.new_page()
    page.clock.install(time=datetime(2026, 1, 2, tzinfo=timezone.utc))
    page.goto(BASE)
    expect(button(page, "Start game")).to_be_enabled()
    profile = page.evaluate("localStorage.getItem('skyjo-online-profile-v1')")
    return context, page, profile


def wait_response(page, path, status, action):
    with page.expect_response(lambda r: r.request.method == "POST" and urlsplit(r.url).path == path) as caught:
        action()
    assert caught.value.status == status
    return caught.value


def check_rate_limit(browser):
    context, page, profile = setup(browser)
    creates = []
    moves = []

    def throttle_first(route):
        path, data = record(route.request, profile)
        if route.request.method == "POST" and path == "/api/games":
            creates.append(data)
            if len(creates) == 1:
                route.fulfill(status=429, content_type="text/html", body="Slow down",
                              headers={"Retry-After": "30"})
                return
        elif route.request.method == "POST" and path.endswith("/moves"):
            moves.append(data)
            if len(moves) == 1:
                # Lambda can emit a plain 429 without a Retry-After or JSON body.
                route.fulfill(status=429, content_type="text/plain", body="Throttled")
                return
        route.continue_()

    page.route("**/api/**", throttle_first)
    page.get_by_label("Opponent 1", exact=True).select_option("counter")
    wait_response(page, "/api/games", 429, button(page, "Start game").click)
    expect(page.locator("#notice")).to_contain_text("Try again after")
    expect(button(page, "Retry game setup")).to_be_disabled()
    create = json.loads(creates[0])
    assert create["opponents"] == ["counter"] and create["requestId"]
    page.reload()
    expect(button(page, "Retry game setup")).to_be_disabled()
    expect(page.get_by_label("Opponent 1", exact=True)).to_have_value("counter")
    page.clock.fast_forward(30_001)
    expect(button(page, "Retry game setup")).to_be_enabled()
    assert len(creates) == 1
    created = wait_response(page, "/api/games", 201, button(page, "Retry game setup").click).json()["game"]
    assert creates == [creates[0], creates[0]]
    stage(page, "opening")
    slot(page, 0).click()
    slot(page, 3).click()
    path = "/api/games/" + created["id"] + "/moves"
    wait_response(page, path, 429, button(page, "Reveal 2 cards").click)
    saved = page.evaluate("JSON.parse(localStorage.getItem('skyjo-online-pending-v1')).request")
    assert saved["body"] == json.loads(moves[0])
    assert saved["body"]["action"] == {"kind": "open", "slots": [0, 3]}
    expect(button(page, "Retry saved move")).to_be_disabled()
    page.clock.fast_forward(60_001)
    expect(button(page, "Retry saved move")).to_be_enabled()
    assert len(moves) == 1
    wait_response(page, path, 200, button(page, "Retry saved move").click)
    assert moves == [moves[0], moves[0]]
    stage(page, "source")
    assert page.evaluate("localStorage.getItem('skyjo-online-pending-v1')") is None
    context.close()
    return profile


def check_paused_create(browser, active_profile):
    context, page, profile = setup(browser)
    creates = []
    until = format_datetime(datetime(2026, 1, 2, 0, 2, tzinfo=timezone.utc), usegmt=True)

    def pause(route):
        if route.request.method == "POST" and urlsplit(route.request.url).path == "/api/games":
            _, data = record(route.request, profile)
            creates.append(data)
            route.fulfill(status=503, json={"error": {"code": "new_games_paused", "message": "Paused"}},
                          headers={"Retry-After": until})
        else:
            route.continue_()

    page.route("**/api/**", pause)
    page.get_by_label("Opponent 1", exact=True).select_option("table")
    wait_response(page, "/api/games", 503, button(page, "Start game").click)
    expect(page.locator("#notice")).to_contain_text("New games are temporarily paused")
    expect(button(page, "Start game")).to_be_disabled()
    assert page.evaluate("localStorage.getItem('skyjo-online-pending-v1')") is None
    # A confirmed rejection releases the lineup for edits and preserves it across a refresh.
    page.get_by_label("Opponent 1", exact=True).select_option("board")
    page.reload()
    expect(page.get_by_label("Opponent 1", exact=True)).to_have_value("board")
    expect(button(page, "Start game")).to_be_disabled()
    page.clock.fast_forward(65_000)
    expect(button(page, "Start game")).to_be_disabled()
    assert len(creates) == 1
    button(page, "Recovery key").click()
    page.get_by_label("Recovery key to restore").fill(active_profile)
    button(page, "Restore key").click()
    stage(page, "source")
    button(page, "Draw blind").click()
    stage(page, "held")
    assert len(creates) == 1
    context.close()


if __name__ == "__main__":
    if urlsplit(BASE).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Run these intercepted throttle scenarios against a local test server.")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None,
                                     args=["--no-sandbox"])
        existing_profile = check_rate_limit(browser)
        check_paused_create(browser, existing_profile)
        browser.close()
    print("Browser body hashes, manual throttled retries and paused creation passed.")
