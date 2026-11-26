"""Exercise the hosted game against a running local server using fresh browser profiles."""
import os
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


BASE = os.environ.get("ONLINE_BASE_URL", "http://127.0.0.1:4175").rstrip("/")
ENGINE = "match-mlp-11"


def api_response(page, method, path, action):
    """Read the same response the browser receives, including the command it submitted."""
    with page.expect_response(
        lambda res: res.request.method == method and urlsplit(res.url).path == path
    ) as pending:
        action()
    response = pending.value
    assert response.ok, f"{method} {path} returned {response.status}"
    return response


def stage(page, phase):
    expect(page.locator("#app")).to_have_attribute("data-phase", phase)


def slot(page, i):
    return page.get_by_test_id(f"slot-{i}")


def button(page, text):
    return page.get_by_role("button", name=text, exact=True)


def no_horizontal_scroll(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Page overflows the viewport"


def choose_opening(page):
    slot(page, 0).click()
    slot(page, 3).click()
    button(page, "Reveal 2 cards").click()


def show_key(page):
    button(page, "Recovery key").click()
    button(page, "Show key").click()
    value = page.get_by_label("Your recovery key").input_value()
    assert value, "A recovery key should be available"
    button(page, "Close").click()
    return value


def complete_match(page, game):
    """Play real visible actions to the score limit and watch the bot's replies."""
    path = f"/api/games/{game['id']}/moves"
    for _ in range(1000):
        phase = game["phase"]
        stage(page, phase)
        if phase == "gameOver":
            return game
        if phase == "roundOver":
            action = button(page, "Next round").click
        elif phase == "opening":
            action = lambda: choose_opening(page)
        elif phase == "source" and game["discard"] > 3:
            action = button(page, "Draw blind").click
        else:
            if phase == "source":
                placement = "Take discard"
            else:
                assert phase == "held"
                placement = "Swap drawn card" if game["held"] <= 5 else "Discard and flip"
            button(page, placement).click()
            action = slot(page, game["players"][0]["board"].index(None)).click
        new_game = api_response(page, "POST", path, action).json()["game"]
        assert new_game["revision"] == game["revision"] + 1
        game = new_game
    raise AssertionError("Human move limit reached before the match finished")


def check_history(page, game):
    response = api_response(page, "GET", "/api/history", button(page, "Match history").click)
    rows = response.json()["items"]
    assert [row["id"] for row in rows] == [game["id"]]
    row = rows[0]
    totals = [p["total"] for p in game["players"]]
    assert max(totals) >= 100
    assert row["winners"] == [i for i, n in enumerate(totals) if n == min(totals)] == game["winners"]
    assert row["rounds"] == game["history"]
    assert [p["total"] for p in row["players"]] == totals
    assert [sum(r["points"][seat] for r in row["rounds"]) for seat in range(len(totals))] == totals
    button(page, "Game details").click()
    scores = page.locator("#scores")
    expect(scores).to_contain_text(game["players"][1]["name"])
    expect(scores.locator(".score")).to_have_text([str(n) for n in totals])
    scores.get_by_text("Round-by-round scores", exact=True).click()
    score_rows = scores.get_by_role("table").locator("tbody tr")
    expect(score_rows).to_have_count(len(row["rounds"]))
    for i, r in enumerate(row["rounds"]):
        expect(score_rows.nth(i).get_by_role("cell")).to_have_text([str(n) for n in [r["round"], *r["points"]]])


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None,
                                    args=["--no-sandbox"])
        mobile = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        desktop = browser.new_context(viewport={"width": 1280, "height": 900})
        phone, other = mobile.new_page(), desktop.new_page()
        errors = []
        for page in (phone, other):
            page.on("pageerror", lambda error: errors.append(str(error)))
        phone.goto(BASE)
        button(phone, "Add opponent").click()
        expect(phone.get_by_label("Opponent 2", exact=True)).to_be_visible()
        button(phone, "Remove opponent 2").click()
        phone.get_by_label("Opponent 1", exact=True).select_option(ENGINE)
        response = api_response(phone, "POST", "/api/games", button(phone, "Start game").click)
        authorization = response.request.header_value("authorization")
        assert authorization and authorization.startswith("Bearer ")
        game = response.json()["game"]
        assert [p["engineId"] for p in game["players"]] == [None, ENGINE]
        assert game["players"][0]["board"] == [None] * 12
        path = f"/api/games/{game['id']}/moves"
        stage(phone, "opening")
        no_horizontal_scroll(phone)
        opened = api_response(phone, "POST", path, lambda: choose_opening(phone)).json()["game"]
        stage(phone, "source")
        assert opened["players"][0]["board"].count(None) == 10
        expect(button(phone, "Take discard")).to_have_accessible_description(f"Top discard is {opened['discard']}.")
        drawn = api_response(phone, "POST", path, button(phone, "Draw blind").click).json()["game"]
        assert drawn["phase"] == "held" and -2 <= drawn["held"] <= 12
        snapshot = api_response(phone, "GET", "/api/games/current", phone.reload).json()["game"]
        assert (snapshot["id"], snapshot["revision"], snapshot["held"]) == (game["id"], drawn["revision"], drawn["held"])
        stage(phone, "held")
        button(phone, "Discard and flip").click()
        after = api_response(phone, "POST", path, slot(phone, 1).click).json()["game"]
        assert after["players"][0]["board"][1] is not None
        key = show_key(phone)

        # A second browser profile starts with an independent guest key and no saved games.
        fresh = api_response(other, "GET", "/api/games/current", lambda: other.goto(BASE))
        assert fresh.json()["game"] is None
        fresh_auth = fresh.request.header_value("authorization")
        assert fresh_auth and fresh_auth != authorization
        private_status = other.evaluate(
            """async ({id, auth}) => {
                const response = await fetch('/api/games/' + id, {headers: {Authorization: auth}})
                return response.status
            }""",
            {"id": game["id"], "auth": fresh_auth},
        )
        assert private_status == 404
        empty = api_response(other, "GET", "/api/history", button(other, "Match history").click)
        assert empty.json()["items"] == []
        button(other, "Recovery key").click()
        other.get_by_label("Recovery key to restore").fill(key)
        restored = api_response(other, "GET", "/api/games/current", button(other, "Restore key").click)
        assert restored.request.header_value("authorization") == authorization
        recovered = restored.json()["game"]
        assert (recovered["id"], recovered["revision"]) == (after["id"], after["revision"])
        button(other, "Table").click()
        stage(other, recovered["phase"])
        no_horizontal_scroll(other)
        done = complete_match(other, recovered)
        check_history(other, done)
        phone.reload()
        check_history(phone, done)
        no_horizontal_scroll(phone)
        assert not errors, errors
        browser.close()
        print(f"Hosted mobile and desktop play passed (rounds played: {len(done['history'])}), "
              "including isolated profiles, draw, resume, recovery, and shared history.")


if __name__ == "__main__":
    run()
