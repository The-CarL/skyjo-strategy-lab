"""Check public asset caching and independent private game state through the normal UI."""
import os
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

from online_smoke import BASE, api_response, button, choose_opening, stage

EDGE = os.environ.get("EXPECT_CLOUDFRONT") == "1"


def private(response):
    assert response.ok and "no-store" in response.headers.get("cache-control", "")
    assert "hit from cloudfront" not in response.headers.get("x-cache", "").lower()
    return response.json()


def browse(page):
    with page.expect_response(lambda r: urlsplit(r.url).path == "/style.css") as css:
        current = api_response(page, "GET", "/api/games/current", lambda: page.goto(BASE))
    asset = css.value
    assert asset.ok and "s-maxage=" in asset.headers.get("cache-control", "")
    assert asset.headers.get("etag")
    return private(current)["game"], asset


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None, args=["--no-sandbox"])
        first = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True).new_page()
        second = browser.new_context().new_page()
        guest, css = browse(first)
        assert guest is None
        created = private(api_response(first, "POST", "/api/games", button(first, "Start game").click))["game"]
        path = f"/api/games/{created['id']}"
        try:
            opened = private(api_response(first, "POST", path + "/moves", lambda: choose_opening(first)))["game"]
            assert opened["revision"] == created["revision"] + 1
            other, shared_css = browse(second)
            assert other is None
            assert css.headers["etag"] == shared_css.headers["etag"] and css.body() == shared_css.body()
            if EDGE:
                assert "hit from cloudfront" in shared_css.headers.get("x-cache", "").lower(), shared_css.headers.get("x-cache")
            remembered = private(api_response(first, "GET", "/api/games/current", first.reload))["game"]
            assert remembered == opened
            empty = private(api_response(second, "GET", "/api/history", button(second, "Match history").click))
            assert empty["items"] == []
        finally:
            button(first, "Abandon game").click()
            private(api_response(first, "POST", path + "/abandon", button(first, "Abandon and set up a new game").click))
            stage(first, "setup")
        assert private(api_response(first, "GET", "/api/games/current", first.reload))["game"] is None
        browser.close()
        print("Static assets shared; two guest profiles stayed isolated. The disposable game was abandoned.")


if __name__ == "__main__":
    run()
