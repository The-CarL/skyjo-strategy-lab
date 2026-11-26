"""Run against the built download, with its network fully disabled."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import os
import json
from urllib.parse import urljoin
from playwright.sync_api import sync_playwright

html = Path("dist/skyjo-coach.html").resolve()
release = json.loads(Path("web/release.json").read_text())
url = html.as_uri()
# Managed browsers may restrict file URLs. Only the initial HTML document is served.
if os.environ.get("COACH_LOOPBACK"):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path not in {"/skyjo-coach.html", "/skyjo-comparison-card.html"}:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write((html.parent / self.path[1:]).read_bytes())
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:" + str(server.server_port) + "/skyjo-coach.html"

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None,
                                args=["--no-sandbox"])
    context = browser.new_context(viewport={"width": 390, "height": 844}, offline=False)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    context.set_offline(True)
    def choose(control, value):
        page.locator(control).click()
        page.locator("#numbers").get_by_role("button", name=str(value), exact=True).click()
    def slot(c, r):
        return '[aria-label^="column '+str(c)+', row '+str(r)+',"]'
    expected_paper = "value" if release["paper"] == "value-upgrade" else "family"
    assert page.locator("#policy").input_value() == expected_paper
    assert page.locator('#policy option[value="match"]').count() == int(release["matchModel"])
    assert page.locator("#advice").inner_text() == "Set your opening cards"
    choose(slot(1,1),8)
    choose(slot(1,2),8)
    choose("#discard",8)
    assert "clear all three" in page.locator("#reason").inner_text()
    page.locator("#apply").click()
    assert page.locator(".gone").count() == 3
    page.locator("#undo").click()
    assert page.locator(".gone").count() == 0
    choose("#discard",9)
    assert page.locator("#advice").inner_text() == "Draw blind"
    choose("#apply",10)
    assert page.locator("#advice").inner_text() == "Discard 10 and flip"
    choose("#apply",-2)
    assert "-2" in page.locator("#grid").inner_text()
    context.set_offline(False)
    page.reload()
    context.set_offline(True)
    assert "-2" in page.locator("#grid").inner_text()
    choose("#discard",1)
    for mode in page.locator("#policy option").evaluate_all("(options) => options.map(o => o.value)"):
        page.locator("#policy").select_option(mode)
        assert page.locator("#apply").is_visible()
    page.locator("#print").click()
    assert page.locator("#rulecard").is_visible()
    page.emulate_media(media="print")
    assert page.locator("#rulecard").is_visible()
    Path("dist").mkdir(exist_ok=True)
    page.pdf(path="dist/skyjo-strategy-card.pdf",format="A5",print_background=True)
    page.emulate_media(media="screen")
    page.locator("#back").click()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.locator("#reset").click()
    assert page.locator(".hidden").count()==12
    if expected_paper == "value":
        page.locator("#policy").select_option("value")
        choose(slot(1,1),1)
        choose(slot(1,2),1)
        choose(slot(2,1),12)
        choose("#discard",1)
        assert "saves 11" in page.locator("#reason").inner_text()
        assert "saves 7" in page.locator("#reason").inner_text()
        assert page.locator(".suggest").get_attribute("aria-label").startswith("column 2, row 1")
        page.locator("#apply").click()
        assert page.locator(".gone").count() == 0
        choose("#drawn",7)
        choose(slot(2,2),12)
        assert "cuts 5 points" in page.locator("#reason").inner_text()
        page.locator("#reset").click()
        choose(slot(1,1),2)
        choose(slot(2,1),0)
        choose("#drawn",-2)
        assert page.locator(".suggest").get_attribute("aria-label").startswith("column 1, row 1")
    context.set_offline(False)
    page.goto(urljoin(url, "skyjo-comparison-card.html"))
    context.set_offline(True)
    page.emulate_media(media="print")
    page.pdf(path="dist/skyjo-comparison-card.pdf", format="A5", print_background=True)
    assert not errors, errors
    browser.close()
    print("Offline mobile flow, advice modes, undo, persistence, and strategy card passed.")
