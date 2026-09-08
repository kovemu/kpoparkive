from io import BytesIO
from urllib.parse import quote

import cloudscraper
import requests
from bs4 import BeautifulSoup
from fastapi import FastAPI
from PIL import Image

app = FastAPI()

FILE_CDN_TESTS = [
    "https://file.namu.moe/file/67e336914029a528fed5dedc601ca2e714d40d0c08220440853cc694d47cc9d199282c6a83abdc17198c9978f9b7f9e0",
    "https://file.namu.moe/file/67e336914029a528fed5dedc601ca2e7c2a90e71b57f461db52a6322757582d7d91116f6625c3f82d7e018d136397cb9",
    "https://file.namu.moe/file/58b7beb9825890faebfd3e2564c10ff3733cfcea1bffbe438af9973e7296abaf25989a6859cf3a0f7411df3d16d6b983",
]

OFFICIAL_PAGE_TESTS = [
    "https://namu.wiki/w/RESCENE",
    "https://namu.wiki/raw/RESCENE",
    "https://namu.wiki/w/" + quote("파일:Pretty Girl 원이 프로필.jpg", safe=":"),
    "https://namu.wiki/w/" + quote("파일:RESCENE 로고 모션.gif", safe=":"),
]

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
IMAGE_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Referer": "https://www.namu.moe/",
}
PAGE_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
}


def common_meta(response):
    body = response.content or b""
    return {
        "status": response.status_code,
        "final_url": response.url,
        "content_type": response.headers.get("content-type", ""),
        "bytes": len(body),
        "cf_ray": response.headers.get("cf-ray"),
        "server": response.headers.get("server"),
        "head_hex": body[:16].hex(),
    }


def inspect_image_response(response):
    body = response.content or b""
    result = common_meta(response)
    result.update({"image": False, "width": None, "height": None, "format": None})
    try:
        image = Image.open(BytesIO(body))
        width, height = image.size
        fmt = image.format
        image.verify()
        result.update({"image": True, "width": width, "height": height, "format": fmt})
    except Exception as exc:
        result["image_error"] = str(exc)[:200]
    return result


def inspect_page_response(response):
    body = response.content or b""
    result = common_meta(response)
    text = response.text if body else ""
    result["text_head"] = text[:160].replace("\n", " ")
    result["challenge_hint"] = any(
        token in text.lower()
        for token in ["just a moment", "cf-chl-", "cloudflare", "captcha", "turnstile"]
    )
    try:
        soup = BeautifulSoup(text, "html.parser")
        candidates = []
        for tag in soup.find_all(["img", "source", "a"]):
            for attr in ["src", "data-src", "data-original", "srcset", "href"]:
                value = tag.get(attr)
                if not isinstance(value, str):
                    continue
                for part in value.split(","):
                    url = part.strip().split(" ")[0]
                    low = url.lower()
                    if any(key in low for key in ["image.namu", "i.namu", "namu.wiki/file", "/file/", "upload.namu"]):
                        if url not in candidates:
                            candidates.append(url)
        result["asset_candidates"] = candidates[:20]
    except Exception as exc:
        result["parse_error"] = str(exc)[:200]
    return result


def request_pair(scraper, url, headers, inspector):
    item = {"url": url}
    try:
        plain = requests.get(url, headers=headers, timeout=12, allow_redirects=True)
        item["plain"] = inspector(plain)
    except Exception as exc:
        item["plain"] = {"error": str(exc)[:300]}
    try:
        cloud = scraper.get(url, headers=headers, timeout=12, allow_redirects=True)
        item["cloudscraper"] = inspector(cloud)
    except Exception as exc:
        item["cloudscraper"] = {"error": str(exc)[:300]}
    return item


def run_probe():
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "mobile": False}
    )
    file_tests = [request_pair(scraper, url, IMAGE_HEADERS, inspect_image_response) for url in FILE_CDN_TESTS]
    page_tests = [request_pair(scraper, url, PAGE_HEADERS, inspect_page_response) for url in OFFICIAL_PAGE_TESTS]
    return {"ok": True, "file_cdn_tests": file_tests, "official_page_tests": page_tests}


@app.get("/")
def probe_root():
    return run_probe()


@app.get("/api/namu_cloudscraper_probe")
def probe_file_route():
    return run_probe()
