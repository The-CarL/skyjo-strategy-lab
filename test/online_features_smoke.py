"""Exercise mixed tables, abandonment and the independent physical-table coach."""
import os
import re
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from online_smoke import BASE, api_response, button, choose_opening, no_horizontal_scroll, show_key, stage

LINEUP = [
    "threshold-3+clear", "board", "counter", "tree",
    "match-mlp-11", "expanded-table", "family-value-upgrade",
]


def set_mixed_table(page):
    players = page.get_by_label("Total players", exact=True)
    expect(players.locator("option")).to_have_count(7)
    for total in range(2, 9):
        players.select_option(str(total))
        # Keep earlier selections as new seats are added.
        for i, engine in enumerate(LINEUP[:total - 2], start=1):
            expect(page.get_by_label(f"Opponent {i}", exact=True)).to_have_value(engine)
        page.get_by_label(f"Opponent {total - 1}", exact=True).select_option(LINEUP[total - 2])
        expect(page.get_by_role("combobox")).to_have_count(total)


def pick_value(page, control, value):
    control.click()
    page.locator("#numbers").get_by_role("button", name=str(value), exact=True).click()


def check_physical_coach(phone):
    phone.get_by_role("link", name="Table coach", exact=True).click()
    assert urlsplit(phone.url).path.rstrip("/") == "/coach"
    def cell(i):
        return phone.locator(f'#grid [data-slot="{i}"]')

    expect(phone.locator("#grid .hidden")).to_have_count(12)
    phone.locator("#policy").select_option("family")
    pick_value(phone, phone.locator("#drawn"), 11)
    expect(phone.locator("#drawn-value")).to_have_text("11")
    expect(phone.locator("#apply")).not_to_be_visible()
    phone.locator("#undo").click()
    for i in (0, 1):
        pick_value(phone, cell(i), 8)

    # This is a real-table scenario. The parent online game independently holds its own draw.
    pick_value(phone, phone.locator("#discard"), 9)
    expect(phone.locator("#advice")).to_have_text("Draw blind")
    pick_value(phone, phone.locator("#apply"), 10)
    expect(phone.locator("#advice")).to_have_text("Discard 10 and flip")
    expect(cell(2)).to_have_class(re.compile(r"\bsuggest\b"))
    pick_value(phone, phone.locator("#apply"), 8)
    expect(phone.locator("#grid .gone")).to_have_count(3)

    pick_value(phone, phone.locator("#drawn"), -2)
    expect(phone.locator("#advice")).to_have_text("Keep -2")
    phone.locator("#apply").click()
    expect(cell(3)).to_have_text("-2")
    cell(6).click()
    phone.locator("#mark-gone").click()
    expect(phone.locator("#grid .gone")).to_have_count(6)
    phone.reload()
    expect(cell(3)).to_have_text("-2")
    expect(phone.locator("#grid .gone")).to_have_count(6)
    phone.locator("#undo").click()
    expect(phone.locator("#grid .gone")).to_have_count(3)
    no_horizontal_scroll(phone)

    return api_response(phone, "GET", "/api/games/current", phone.locator("#online-nav").click).json()["game"]


def check_restore_during_boot(browser, key, game):
    """Deliver the original guest's current-game response after restoring another guest."""
    context = browser.new_context()
    page = context.new_page()
    delayed = []
    page.route("**/api/games/current", lambda route: delayed.append(route), times=1)
    with page.expect_request(lambda r: urlsplit(r.url).path == "/api/games/current"):
        page.goto(BASE, wait_until="domcontentloaded")

    button(page, "Recovery key").click()
    page.get_by_label("Recovery key to restore").fill(key)
    restored = api_response(page, "GET", "/api/games/current", button(page, "Restore key").click)
    assert restored.json()["game"] == game
    stage(page, game["phase"])
    assert len(delayed) == 1
    stale = api_response(page, "GET", "/api/games/current", delayed[0].continue_)
    assert stale.json()["game"] is None

    button(page, "Abandon game").click()
    confirm = button(page, "Abandon and set up a new game")
    api_response(page, "POST", f"/api/games/{game['id']}/abandon", confirm.click)
    stage(page, "setup")
    opponent = page.get_by_label("Opponent 1", exact=True)
    expect(opponent).to_be_enabled()
    opponent.select_option("counter")
    expect(button(page, "Start game")).to_be_enabled()
    context.close()


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None, args=["--no-sandbox"])
        desktop = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        phone = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True).new_page()
        errors = []
        for page in (desktop, phone):
            page.on("pageerror", lambda error: errors.append(str(error)))

        desktop.goto(BASE)
        set_mixed_table(desktop)
        game = api_response(desktop, "POST", "/api/games", button(desktop, "Start game").click).json()["game"]
        assert [seat["engineId"] for seat in game["players"]] == [None, *LINEUP]
        key = show_key(desktop)
        path = f"/api/games/{game['id']}"
        api_response(desktop, "POST", path + "/moves", lambda: choose_opening(desktop))
        held = api_response(desktop, "POST", path + "/moves", button(desktop, "Draw blind").click).json()["game"]

        empty = api_response(phone, "GET", "/api/games/current", lambda: phone.goto(BASE))
        assert empty.json()["game"] is None
        button(phone, "Recovery key").click()
        phone.get_by_label("Recovery key to restore").fill(key)
        restored = api_response(phone, "GET", "/api/games/current", button(phone, "Restore key").click)
        assert restored.request.header_value("authorization") == f"Bearer {key}"
        assert restored.json()["game"] == held
        stage(phone, "held")
        no_horizontal_scroll(phone)
        seats = phone.locator("#scores .score-row")
        expect(seats).to_have_count(8)
        for i, seat in enumerate(held["players"]):
            expect(seats.nth(i)).to_contain_text(seat["name"])

        returned = check_physical_coach(phone)
        assert returned == held, "Using the physical table coach changed the online match"
        stage(phone, "held")
        button(phone, "Abandon game").click()
        confirm = phone.get_by_role("dialog", name="Abandon this game?")
        confirm.get_by_role("button", name="Keep playing").click()
        expect(confirm).not_to_be_visible()
        kept = api_response(phone, "GET", "/api/games/current", phone.reload).json()["game"]
        assert kept == held

        button(phone, "Abandon game").click()
        abandon = confirm.get_by_role("button", name="Abandon and set up a new game", exact=True)
        result = api_response(phone, "POST", path + "/abandon", abandon.click)
        assert result.json()["game"] is None
        stage(phone, "setup")
        current = api_response(desktop, "GET", "/api/games/current", desktop.reload)
        assert current.json()["game"] is None
        history = api_response(desktop, "GET", "/api/history", button(desktop, "Match history").click)
        assert history.json()["items"] == []
        expect(desktop.get_by_role("heading", name="No completed games yet")).to_be_visible()

        phone.get_by_label("Total players", exact=True).select_option("2")
        phone.get_by_label("Opponent 1", exact=True).select_option("match-tree-11")
        fresh = api_response(phone, "POST", "/api/games", button(phone, "Start game").click).json()["game"]
        assert fresh["id"] != held["id"] and fresh["revision"] == 0
        assert [seat["engineId"] for seat in fresh["players"]] == [None, "match-tree-11"]
        stage(phone, "opening")
        phone.get_by_role("link", name="Table coach", exact=True).click()
        expect(phone.locator("#grid .gone")).to_have_count(3)
        expect(phone.locator('#grid [data-slot="3"]')).to_have_text("-2")
        # The recovered online identity does not synchronize a physical board to other devices.
        desktop.get_by_role("link", name="Table coach", exact=True).click()
        expect(desktop.locator("#grid .hidden")).to_have_count(12)
        check_restore_during_boot(browser, key, fresh)
        assert not errors, errors
        browser.close()
        print("Mixed seat selection, two-device recovery, mobile table coaching and abandoning a held turn passed.")


if __name__ == "__main__":
    run()
